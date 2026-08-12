CREATE TABLE "GroupChatThreadArtifact" (
	"id" text PRIMARY KEY NOT NULL,
	"threadId" text NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "GroupChatThreadArtifact" ADD CONSTRAINT "GroupChatThreadArtifact_threadId_GroupChatThread_id_fk" FOREIGN KEY ("threadId") REFERENCES "public"."GroupChatThread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "GroupChatThreadArtifact_threadId_idx" ON "GroupChatThreadArtifact" USING btree ("threadId");