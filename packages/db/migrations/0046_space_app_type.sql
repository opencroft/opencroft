-- An app instance names its App by one qualified type, `<owner>.<extension>.<type>`,
-- in place of the extension id and App slug it was stored as. Every existing row
-- takes its old pair joined that way, the old id's `/` becoming the `.` ids use
-- now, before the old columns go: `builtin/core` + `graph` becomes
-- `builtin.core.graph`, the Graph App's type, so graphs keep working. A row whose
-- extension has since changed its id keeps a type nothing provides until it is
-- retyped; nothing is dropped.
ALTER TABLE "SpaceApp" ADD COLUMN "type" text;--> statement-breakpoint
UPDATE "SpaceApp" SET "type" = replace("extensionId", '/', '.') || '.' || "appSlug";--> statement-breakpoint
ALTER TABLE "SpaceApp" ALTER COLUMN "type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "SpaceApp" DROP COLUMN "extensionId";--> statement-breakpoint
ALTER TABLE "SpaceApp" DROP COLUMN "appSlug";
