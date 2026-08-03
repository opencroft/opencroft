DROP INDEX "ApiToken_agent_idx";--> statement-breakpoint
ALTER TABLE "ApiToken" ALTER COLUMN "agent" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ApiToken" ALTER COLUMN "label" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "ApiToken" ALTER COLUMN "label" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ApiToken" ADD COLUMN "subjectType" text;--> statement-breakpoint
ALTER TABLE "ApiToken" ADD COLUMN "userId" text;--> statement-breakpoint
ALTER TABLE "ApiToken" ADD COLUMN "agentName" text;--> statement-breakpoint
ALTER TABLE "ApiToken" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "ApiToken" ADD COLUMN "expiresAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ApiToken" ADD CONSTRAINT "ApiToken_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ApiToken_agentName_idx" ON "ApiToken" USING btree ("agentName");--> statement-breakpoint
CREATE INDEX "ApiToken_userId_idx" ON "ApiToken" USING btree ("userId");--> statement-breakpoint
-- Backfill: every existing row was written by the agent-only mint script, so
-- it is unambiguously an agent credential. Typically the table is empty (no
-- token has ever been minted there), so this is a safety net for any other
-- environment rather than a load-bearing step here.
UPDATE "ApiToken" SET "subjectType" = 'agent', "agentName" = "agent", "name" = "label" WHERE "subjectType" IS NULL;
