CREATE TABLE "GroupChatPin" (
	"id" text PRIMARY KEY NOT NULL,
	"groupChatId" text NOT NULL,
	"text" text NOT NULL,
	"position" integer NOT NULL,
	"createdByUserId" text,
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "GroupChatThread" ADD COLUMN "deliveredContextSignature" text;--> statement-breakpoint
ALTER TABLE "GroupChatPin" ADD CONSTRAINT "GroupChatPin_groupChatId_GroupChat_id_fk" FOREIGN KEY ("groupChatId") REFERENCES "public"."GroupChat"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "GroupChatPin" ADD CONSTRAINT "GroupChatPin_createdByUserId_user_id_fk" FOREIGN KEY ("createdByUserId") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "GroupChatPin_groupChatId_idx" ON "GroupChatPin" USING btree ("groupChatId");