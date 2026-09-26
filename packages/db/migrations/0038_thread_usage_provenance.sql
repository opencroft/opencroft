ALTER TABLE "ChatUsageTurn" ADD COLUMN "sessionKey" text;--> statement-breakpoint
ALTER TABLE "GroupChatThread" ADD COLUMN "createdBySystemId" text;--> statement-breakpoint
CREATE INDEX "ChatUsageTurn_sessionKey_idx" ON "ChatUsageTurn" USING btree ("sessionKey");