ALTER TABLE "GroupChatMember" ADD COLUMN "systemId" text;--> statement-breakpoint
CREATE UNIQUE INDEX "GroupChatMember_groupChatId_systemId_key" ON "GroupChatMember" USING btree ("groupChatId","systemId");--> statement-breakpoint
CREATE INDEX "GroupChatMember_systemId_idx" ON "GroupChatMember" USING btree ("systemId");