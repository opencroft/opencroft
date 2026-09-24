-- Hand-edited: the DELETE before the ApiToken changes is not drizzle's.
--
-- Agent credentials move out of ApiToken into McpToken, and ApiToken becomes
-- personal tokens only. An agent row -- the only kind with no userId -- would
-- make SET NOT NULL fail, and after this change it authenticates nothing
-- anywhere: the MCP endpoint reads McpToken alone. So those rows are deleted
-- rather than carried over; an agent that needs a credential gets a new
-- McpToken from its node's settings.
CREATE TABLE "McpToken" (
	"id" text PRIMARY KEY NOT NULL,
	"agentNodeId" text NOT NULL,
	"name" text NOT NULL,
	"tokenHash" text NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	"lastUsedAt" timestamp with time zone,
	"expiresAt" timestamp with time zone
);
--> statement-breakpoint
DELETE FROM "ApiToken" WHERE "userId" IS NULL;--> statement-breakpoint
DROP INDEX "ApiToken_agentName_idx";--> statement-breakpoint
ALTER TABLE "ApiToken" ALTER COLUMN "userId" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "McpCaller" ADD COLUMN "agentNodeId" text;--> statement-breakpoint
CREATE UNIQUE INDEX "McpToken_tokenHash_key" ON "McpToken" USING btree ("tokenHash");--> statement-breakpoint
CREATE INDEX "McpToken_agentNodeId_idx" ON "McpToken" USING btree ("agentNodeId");--> statement-breakpoint
ALTER TABLE "ApiToken" DROP COLUMN "subjectType";--> statement-breakpoint
ALTER TABLE "ApiToken" DROP COLUMN "agentName";