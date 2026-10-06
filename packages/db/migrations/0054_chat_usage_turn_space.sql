ALTER TABLE "ChatUsageTurn" ADD COLUMN "spaceId" text;--> statement-breakpoint
CREATE INDEX "ChatUsageTurn_spaceId_day_idx" ON "ChatUsageTurn" USING btree ("spaceId","day");--> statement-breakpoint
-- Backfill: every turn recorded before the column existed gets the space its
-- session's chat belongs to, resolved as recordChatUsageTurn resolves a new one
-- (thread by key, live then alias, -> its chat -> the space at the chat's slug,
-- live then alias; then, when the chat's live slug addresses no space, the
-- slugs the chat was renamed away from, provided they agree on one space), with
-- two fallbacks only history needs:
--   * a key whose thread has since been deleted resolves through the chat slug
--     the key itself names (live, then alias). A legacy key carrying a chat id
--     in that segment rather than a slug matches no slug and falls through;
--   * a turn recorded before keys were stored borrows the key that another
--     record of the same session id carries (one of its later turns, or a
--     background task it started), when every such key agrees on one space.
-- A turn none of these resolve keeps NULL, which is in no space's Usage.
-- Every slug and session-key column joined here is unique, and the chat-alias
-- step is grouped per chat, so the working table holds at most one row per key
-- and the UPDATE below never chooses between two.
CREATE TEMPORARY TABLE "ChatUsageTurnKeySpace" AS
WITH "chatLiveSpace" AS (
  SELECT c."id" AS "groupChatId", COALESCE(s."id", sa."spaceId") AS "spaceId"
  FROM "GroupChat" c
  LEFT JOIN "Space" s ON s."slug" = c."slug"
  LEFT JOIN "SpaceSlugAlias" sa ON sa."slug" = c."slug"
), "chatAliasSpace" AS (
  SELECT ca."groupChatId", MIN(COALESCE(s."id", sa."spaceId")) AS "spaceId"
  FROM "GroupChatSlugAlias" ca
  LEFT JOIN "Space" s ON s."slug" = ca."slug"
  LEFT JOIN "SpaceSlugAlias" sa ON sa."slug" = ca."slug"
  WHERE COALESCE(s."id", sa."spaceId") IS NOT NULL
  GROUP BY ca."groupChatId"
  HAVING COUNT(DISTINCT COALESCE(s."id", sa."spaceId")) = 1
)
SELECT k."key", COALESCE(live."spaceId", aliased."spaceId") AS "spaceId"
FROM (
  SELECT "sessionKey" AS "key" FROM "ChatUsageTurn" WHERE "sessionKey" IS NOT NULL
  UNION
  SELECT "sessionKey" FROM "BackgroundTask" WHERE "sessionKey" IS NOT NULL
) k
LEFT JOIN "GroupChatThread" th ON th."sessionKey" = k."key"
LEFT JOIN "GroupChatThreadAlias" ta ON ta."sessionKey" = k."key"
LEFT JOIN "GroupChat" named ON k."key" LIKE 'group-chat.%' AND named."slug" = split_part(k."key", '.', 2)
LEFT JOIN "GroupChatSlugAlias" ca ON k."key" LIKE 'group-chat.%' AND ca."slug" = split_part(k."key", '.', 2)
JOIN "chatLiveSpace" live ON live."groupChatId" = COALESCE(th."groupChatId", ta."groupChatId", named."id", ca."groupChatId")
LEFT JOIN "chatAliasSpace" aliased ON aliased."groupChatId" = live."groupChatId"
WHERE COALESCE(live."spaceId", aliased."spaceId") IS NOT NULL;--> statement-breakpoint
UPDATE "ChatUsageTurn" t
SET "spaceId" = ks."spaceId"
FROM "ChatUsageTurnKeySpace" ks
WHERE t."sessionKey" = ks."key";--> statement-breakpoint
UPDATE "ChatUsageTurn" t
SET "spaceId" = bySession."spaceId"
FROM (
  SELECT "sessionId", MIN("spaceId") AS "spaceId"
  FROM (
    SELECT u."sessionId", ks."spaceId"
    FROM "ChatUsageTurn" u
    JOIN "ChatUsageTurnKeySpace" ks ON ks."key" = u."sessionKey"
    UNION ALL
    SELECT b."sessionId", ks."spaceId"
    FROM "BackgroundTask" b
    JOIN "ChatUsageTurnKeySpace" ks ON ks."key" = b."sessionKey"
    WHERE b."sessionId" IS NOT NULL
  ) candidates
  GROUP BY "sessionId"
  HAVING COUNT(DISTINCT "spaceId") = 1
) bySession
WHERE t."sessionKey" IS NULL AND t."sessionId" = bySession."sessionId";--> statement-breakpoint
DROP TABLE "ChatUsageTurnKeySpace";
