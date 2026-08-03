ALTER TABLE "ApiToken" ALTER COLUMN "subjectType" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "ApiToken" ALTER COLUMN "name" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "ApiToken" ALTER COLUMN "name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "ApiToken" DROP COLUMN "agent";--> statement-breakpoint
ALTER TABLE "ApiToken" DROP COLUMN "label";