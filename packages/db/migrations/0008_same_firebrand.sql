-- Hand-edited from the generated single statement.
--
-- The generated form was `ADD COLUMN "name" text NOT NULL`, which cannot
-- apply to a table that already has rows: there is no default, so every
-- existing row would violate the constraint the moment it is added. Split
-- into add-nullable, backfill, then constrain -- the end state is identical
-- to the snapshot, and every chat that existed before this keeps rendering
-- under the string it already had.
ALTER TABLE "GroupChat" ADD COLUMN "name" text;--> statement-breakpoint
UPDATE "GroupChat" SET "name" = "topic" WHERE "name" IS NULL;--> statement-breakpoint
ALTER TABLE "GroupChat" ALTER COLUMN "name" SET NOT NULL;
