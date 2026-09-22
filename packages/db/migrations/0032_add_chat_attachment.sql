CREATE TABLE "ChatAttachment" (
	"id" text PRIMARY KEY NOT NULL,
	"sessionKey" text NOT NULL,
	"name" text NOT NULL,
	"mimeType" text NOT NULL,
	"data" text NOT NULL,
	"byteSize" integer NOT NULL,
	"createdAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "ChatAttachment_sessionKey_idx" ON "ChatAttachment" USING btree ("sessionKey");