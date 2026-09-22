CREATE TABLE "BackgroundTask" (
	"taskId" text PRIMARY KEY NOT NULL,
	"instanceId" text NOT NULL,
	"agent" text,
	"sessionKey" text,
	"sessionId" text,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"target" text NOT NULL,
	"summary" text NOT NULL,
	"state" text NOT NULL,
	"reason" text,
	"startedAt" timestamp with time zone NOT NULL,
	"finishedAt" timestamp with time zone,
	"timeoutMs" bigint,
	"exitCode" integer,
	"outputTail" text,
	"logPath" text,
	"nodeDir" text,
	"pid" integer,
	"deliveredAt" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "BackgroundTask_state_idx" ON "BackgroundTask" USING btree ("state");--> statement-breakpoint
CREATE INDEX "BackgroundTask_sessionKey_idx" ON "BackgroundTask" USING btree ("sessionKey");