CREATE TABLE "GroupChatSlugAlias" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"groupChatId" text NOT NULL,
	"createdAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "GroupChatThreadAlias" (
	"id" text PRIMARY KEY NOT NULL,
	"threadId" text NOT NULL,
	"groupChatId" text NOT NULL,
	"agentNodeId" text NOT NULL,
	"sessionKey" text,
	"slug" text,
	"createdAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "GroupChatSlugAlias" ADD CONSTRAINT "GroupChatSlugAlias_groupChatId_GroupChat_id_fk" FOREIGN KEY ("groupChatId") REFERENCES "public"."GroupChat"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "GroupChatThreadAlias" ADD CONSTRAINT "GroupChatThreadAlias_threadId_GroupChatThread_id_fk" FOREIGN KEY ("threadId") REFERENCES "public"."GroupChatThread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "GroupChatThreadAlias" ADD CONSTRAINT "GroupChatThreadAlias_groupChatId_GroupChat_id_fk" FOREIGN KEY ("groupChatId") REFERENCES "public"."GroupChat"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "GroupChatSlugAlias_slug_key" ON "GroupChatSlugAlias" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "GroupChatSlugAlias_groupChatId_idx" ON "GroupChatSlugAlias" USING btree ("groupChatId");--> statement-breakpoint
CREATE UNIQUE INDEX "GroupChatThreadAlias_sessionKey_key" ON "GroupChatThreadAlias" USING btree ("sessionKey");--> statement-breakpoint
CREATE UNIQUE INDEX "GroupChatThreadAlias_groupChatId_agentNodeId_slug_key" ON "GroupChatThreadAlias" USING btree ("groupChatId","agentNodeId","slug");--> statement-breakpoint
CREATE INDEX "GroupChatThreadAlias_threadId_idx" ON "GroupChatThreadAlias" USING btree ("threadId");