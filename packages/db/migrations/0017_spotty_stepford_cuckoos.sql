CREATE TABLE "AgentQueueEntry" (
	"id" text PRIMARY KEY NOT NULL,
	"sessionKey" text NOT NULL,
	"kind" text NOT NULL,
	"sender" text,
	"text" text NOT NULL,
	"sentAt" timestamp with time zone,
	"position" integer NOT NULL,
	"createdAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "AgentQueueEntry_sessionKey_position_idx" ON "AgentQueueEntry" USING btree ("sessionKey","position");