-- Repairs turns booked with their session's whole running cost.
--
-- A turn's cost is the harness's cumulative session reading less what earlier
-- turns already claimed. A session reopened after its process stopped or went
-- idle lost that baseline, so its next priced turn was booked with the whole
-- running total. Those rows are recognisable two ways at once: the figure
-- cannot be the turn's own spend, and it is the running total the session had
-- reached.
--
-- "Cannot be its own spend" is a bound on the turn's tokens, taken from its
-- per-model rows (subagents included): five times their token price, plus a
-- fixed margin. It decides which rows to touch and prices nothing.
--
-- The repaired figure is the flagged reading less the running total before it.
-- That total is rebuilt from the session's own rows: each flagged row is a
-- cumulative reading, and every row after it up to the next flagged one is an
-- increment, so the sum of that stretch is the reading the next flagged row
-- started from. Where the result is negative or still over the bound, the
-- harness restarted its count somewhere in between and the turn's own share
-- cannot be recovered. That turn is left unpriced (cost NULL), the same as
-- the engine now leaves a turn whose baseline it does not know. Tokens are not
-- touched.
--
-- Every change is written to ChatUsageCostRepair first, and the update applies
-- exactly what was written there, so the trail is the change. Restoring
-- `originalAmount` and `originalCurrency` from it undoes the repair.
INSERT INTO "ChatUsageCostRepair" ("turnId", "migration", "originalAmount", "originalCurrency", "repairedAmount", "createdAt")
WITH "turn" AS (
  SELECT
    t."id",
    t."sessionId",
    t."createdAt",
    t."costAmount" AS "cost",
    t."costCurrency" AS "currency",
    5 * (
      coalesce(m."input", 0) * 4
      + coalesce(m."output", 0) * 20
      + coalesce(m."cacheRead", 0) * 0.2
      + coalesce(m."cacheWrite", 0) * 5
    ) / 1000000.0 + 0.5 AS "bound"
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
  WHERE t."costAmount" IS NOT NULL
),
"stretch" AS (
  SELECT
    *,
    "cost" > "bound" AS "inflated",
    count(*) FILTER (WHERE "cost" > "bound") OVER (PARTITION BY "sessionId" ORDER BY "createdAt", "id") AS "run"
  FROM "turn"
),
"runTotal" AS (
  SELECT "sessionId", "run", sum("cost") AS "total"
  FROM "stretch"
  GROUP BY "sessionId", "run"
),
"repaired" AS (
  SELECT s."id", s."cost", s."currency", s."cost" - coalesce(r."total", 0) AS "own", s."bound"
  FROM "stretch" s
  LEFT JOIN "runTotal" r ON r."sessionId" = s."sessionId" AND r."run" = s."run" - 1
  WHERE s."inflated"
)
SELECT
  "id",
  '0040_repair_resumed_turn_cost',
  "cost",
  "currency",
  CASE WHEN "own" >= 0 AND "own" <= "bound" THEN "own" END,
  now()
FROM "repaired";
--> statement-breakpoint
UPDATE "ChatUsageTurn" u
SET
  "costAmount" = r."repairedAmount",
  "costCurrency" = CASE WHEN r."repairedAmount" IS NOT NULL THEN r."originalCurrency" END
FROM "ChatUsageCostRepair" r
WHERE r."turnId" = u."id" AND r."migration" = '0040_repair_resumed_turn_cost';
