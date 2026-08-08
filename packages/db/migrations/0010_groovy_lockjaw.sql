-- Hand-edited from the generated statements: the generated form adds
-- `slug NOT NULL` with no default, which cannot apply to a table that already
-- has rows. Split into add-nullable, backfill, constrain.
--
-- The backfill mirrors the application's own slugify (lower, non-alphanumeric
-- runs to a single dash, dashes trimmed from both ends) so a chat created
-- before this migration gets the same slug it would get today.
ALTER TABLE "GroupChat" ADD COLUMN "slug" text;--> statement-breakpoint
UPDATE "GroupChat"
  SET "slug" = NULLIF(btrim(regexp_replace(lower("name"), '[^a-z0-9]+', '-', 'g'), '-'), '');--> statement-breakpoint
-- A name made entirely of punctuation slugifies to nothing. It still needs a
-- key segment, so it gets a stable one rather than an empty string.
UPDATE "GroupChat" SET "slug" = 'chat-' || substr(md5("id"), 1, 6) WHERE "slug" IS NULL;--> statement-breakpoint
-- Two chats can share a name, and the slug is unique. The duplicates keep
-- their slug plus a suffix derived from their own id: deterministic, and it
-- cannot collide with another duplicate the way a sequence number can collide
-- with a slug that already ends in one.
UPDATE "GroupChat" AS g
  SET "slug" = g."slug" || '-' || substr(md5(g."id"), 1, 6)
  FROM (
    SELECT "id", row_number() OVER (PARTITION BY "slug" ORDER BY "createdAt", "id") AS rn
    FROM "GroupChat"
  ) AS d
  WHERE d."id" = g."id" AND d.rn > 1;--> statement-breakpoint
ALTER TABLE "GroupChat" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint
-- Threads keep NULL: their existing uuid keys stay exactly as they are, and
-- the unique index below treats NULLs as distinct so they never collide.
ALTER TABLE "GroupChatThread" ADD COLUMN "slug" text;--> statement-breakpoint
CREATE UNIQUE INDEX "GroupChat_slug_key" ON "GroupChat" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "GroupChatThread_groupChatId_agentNodeId_slug_key" ON "GroupChatThread" USING btree ("groupChatId","agentNodeId","slug");
