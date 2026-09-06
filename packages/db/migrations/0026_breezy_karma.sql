ALTER TABLE "SpaceApp" ADD COLUMN "name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "SpaceApp" ADD COLUMN "slug" text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE "SpaceApp" SET "name" = COALESCE(NULLIF("params"::json->>'name', ''), "appSlug") WHERE "name" = '';--> statement-breakpoint
UPDATE "SpaceApp" SET "slug" = sg."slug" FROM "SpaceGraph" sg WHERE sg."instanceId" = "SpaceApp"."id" AND "SpaceApp"."slug" = '';--> statement-breakpoint
WITH base AS (
  SELECT "id", "spaceId", "createdAt",
    regexp_replace(regexp_replace(regexp_replace(lower("name"), '[^a-z0-9]+', '-', 'g'), '^-+', ''), '-+$', '') AS b
  FROM "SpaceApp" WHERE "slug" = ''
),
named AS (
  SELECT "id", "spaceId", "createdAt", CASE WHEN b = '' THEN 'app' ELSE b END AS b FROM base
),
ranked AS (
  SELECT n."id", n.b,
    (SELECT count(*) FROM "SpaceApp" s2 WHERE s2."spaceId" = n."spaceId" AND s2."slug" = n.b) AS taken,
    row_number() OVER (PARTITION BY n."spaceId", n.b ORDER BY n."createdAt", n."id") AS rn
  FROM named n
)
UPDATE "SpaceApp" SET "slug" = CASE WHEN r.rn = 1 AND r.taken = 0 THEN r.b ELSE r.b || '-' || (r.rn + r.taken) END
FROM ranked r WHERE "SpaceApp"."id" = r."id";--> statement-breakpoint
CREATE UNIQUE INDEX "SpaceApp_spaceId_slug_key" ON "SpaceApp" USING btree ("spaceId","slug");