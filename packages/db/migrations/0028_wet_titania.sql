CREATE TABLE "ChatUsageTurn" (
	"id" text PRIMARY KEY NOT NULL,
	"day" text NOT NULL,
	"sessionId" text NOT NULL,
	"adapterId" text NOT NULL,
	"model" text,
	"inputTokens" bigint NOT NULL,
	"outputTokens" bigint NOT NULL,
	"cacheReadTokens" bigint NOT NULL,
	"cacheWriteTokens" bigint NOT NULL,
	"totalTokens" bigint NOT NULL,
	"costAmount" double precision,
	"costCurrency" text,
	"createdAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "ChatUsageTurn_day_idx" ON "ChatUsageTurn" USING btree ("day");--> statement-breakpoint
CREATE INDEX "ChatUsageTurn_sessionId_idx" ON "ChatUsageTurn" USING btree ("sessionId");