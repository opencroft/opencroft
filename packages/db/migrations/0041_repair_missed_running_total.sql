-- Repairs the turns booked with their session's running total that the
-- previous repair (0040_repair_resumed_turn_cost) could not see.
--
-- That repair flagged a turn only when its cost was over five times its token
-- price, so a running total under that bound stayed booked in full: a session
-- reopened with a small history, or a turn whose own spend was large next to
-- it. Such a turn is recognisable exactly rather than by a bound: its cost less
-- the session's reading before it comes to its own token price.
--
-- The reading before it is rebuilt as 0040 rebuilt it. A turn that repair
-- changed held a cumulative reading (kept as its `originalAmount`), and every
-- priced turn after it is an increment, so their sum is the reading the next
-- turn started from; before a session's first repaired turn it is the sum of
-- the turns from the session's start.
--
-- A turn is re-booked here when all of these hold:
--   - it was recorded before the fixed engine booted: before the earliest row
--     0040 wrote, which it did at that boot. An instance where 0040 changed
--     nothing has no such instant, and every turn is considered;
--   - it is priced, and not already repaired;
--   - it costs more than 1.03 times its token price, so it does not already
--     match its own spend;
--   - the reading before it is above zero;
--   - its cost less that reading is above zero and within 10% of its token
--     price. The repaired cost is that difference. The tolerance is relative
--     only: an absolute floor would let a turn with a near-zero token price
--     "match" whenever its cost happened to sit close to the reading before
--     it, and book it at nothing.
-- The token price is the turn's per-model rows (subagents included) priced
-- per token. It only decides whether the difference is the turn's own spend;
-- the booked figure is the harness's.
--
-- As in 0040, every change is written to ChatUsageCostRepair first and the
-- update applies exactly what was written there, so the trail is the change
-- and restoring `originalAmount` undoes it. Tokens are not touched.
INSERT INTO "ChatUsageCostRepair" ("turnId", "migration", "originalAmount", "originalCurrency", "repairedAmount", "createdAt")
WITH "turn" AS (
  SELECT
    t."id",
    t."sessionId",
    t."createdAt",
    t."costAmount" AS "cost",
    t."costCurrency" AS "currency",
    coalesce(r."originalAmount", t."costAmount") AS "reading",
    r."turnId" IS NOT NULL AS "repaired",
    (
      coalesce(m."input", 0) * 4
      + coalesce(m."output", 0) * 20
      + coalesce(m."cacheRead", 0) * 0.2
      + coalesce(m."cacheWrite", 0) * 8
    ) / 1000000.0 AS "price"
  FROM "ChatUsageTurn" t
  LEFT JOIN (
    SELECT
      "turnId",
      sum("inputTokens") AS "input",
      sum("outputTokens") AS "output",
      sum("cacheReadTokens") AS "cacheRead",
      sum("cacheWriteTokens") AS "cacheWrite"
    FROM "ChatUsageTurnModel"
    GROUP BY "turnId"
  ) m ON m."turnId" = t."id"
  LEFT JOIN "ChatUsageCostRepair" r ON r."turnId" = t."id" AND r."migration" = '0040_repair_resumed_turn_cost'
  WHERE coalesce(r."originalAmount", t."costAmount") IS NOT NULL
    -- Only what the old engine booked: 0040 ran as the fixed engine first
    -- booted, so a turn recorded after its earliest trail row was priced by
    -- the fixed engine and is its own spend.
    AND t."createdAt" < coalesce(
      (SELECT min("createdAt") FROM "ChatUsageCostRepair" WHERE "migration" = '0040_repair_resumed_turn_cost'),
      now()
    )
),
"stretch" AS (
  SELECT
    *,
    count(*) FILTER (WHERE "repaired") OVER (PARTITION BY "sessionId" ORDER BY "createdAt", "id") AS "run"
  FROM "turn"
),
"prior" AS (
  SELECT
    *,
    coalesce(
      sum("reading") OVER (
        PARTITION BY "sessionId", "run"
        ORDER BY "createdAt", "id"
        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
      ),
      0
    ) AS "before"
  FROM "stretch"
)
SELECT "id", '0041_repair_missed_running_total', "cost", "currency", "cost" - "before", now()
FROM "prior"
WHERE NOT "repaired"
  AND "cost" > "price" * 1.03
  AND "before" > 0
  AND "cost" - "before" > 0
  AND abs("cost" - "before" - "price") <= "price" * 0.1;
--> statement-breakpoint
UPDATE "ChatUsageTurn" u
SET "costAmount" = r."repairedAmount"
FROM "ChatUsageCostRepair" r
WHERE r."turnId" = u."id" AND r."migration" = '0041_repair_missed_running_total';
