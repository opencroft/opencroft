CREATE TABLE "GroupChat" (
	"id" text PRIMARY KEY NOT NULL,
	"topic" text NOT NULL,
	"createdByUserId" text,
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "GroupChatMember" (
	"id" text PRIMARY KEY NOT NULL,
	"groupChatId" text NOT NULL,
	"principalType" text NOT NULL,
	"userId" text,
	"agentNodeId" text,
	"createdAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "GroupChatThread" (
	"id" text PRIMARY KEY NOT NULL,
	"groupChatId" text NOT NULL,
	"agentNodeId" text NOT NULL,
	"sessionKey" text NOT NULL,
	"title" text,
	"createdByUserId" text,
	"createdAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "GroupChat" ADD CONSTRAINT "GroupChat_createdByUserId_user_id_fk" FOREIGN KEY ("createdByUserId") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "GroupChatMember" ADD CONSTRAINT "GroupChatMember_groupChatId_GroupChat_id_fk" FOREIGN KEY ("groupChatId") REFERENCES "public"."GroupChat"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "GroupChatMember" ADD CONSTRAINT "GroupChatMember_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "GroupChatThread" ADD CONSTRAINT "GroupChatThread_groupChatId_GroupChat_id_fk" FOREIGN KEY ("groupChatId") REFERENCES "public"."GroupChat"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "GroupChatThread" ADD CONSTRAINT "GroupChatThread_createdByUserId_user_id_fk" FOREIGN KEY ("createdByUserId") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "GroupChatMember_groupChatId_userId_key" ON "GroupChatMember" USING btree ("groupChatId","userId");--> statement-breakpoint
CREATE UNIQUE INDEX "GroupChatMember_groupChatId_agentNodeId_key" ON "GroupChatMember" USING btree ("groupChatId","agentNodeId");--> statement-breakpoint
CREATE INDEX "GroupChatMember_groupChatId_idx" ON "GroupChatMember" USING btree ("groupChatId");--> statement-breakpoint
CREATE INDEX "GroupChatMember_userId_idx" ON "GroupChatMember" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "GroupChatMember_agentNodeId_idx" ON "GroupChatMember" USING btree ("agentNodeId");--> statement-breakpoint
CREATE UNIQUE INDEX "GroupChatThread_sessionKey_key" ON "GroupChatThread" USING btree ("sessionKey");--> statement-breakpoint
CREATE INDEX "GroupChatThread_groupChatId_idx" ON "GroupChatThread" USING btree ("groupChatId");--> statement-breakpoint
CREATE INDEX "GroupChatThread_agentNodeId_idx" ON "GroupChatThread" USING btree ("agentNodeId");