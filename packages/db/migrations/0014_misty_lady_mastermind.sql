CREATE TABLE "UsageRollupDay" (
	"id" text PRIMARY KEY NOT NULL,
	"day" text NOT NULL,
	"agent" text NOT NULL,
	"model" text NOT NULL,
	"requests" integer NOT NULL,
	"rawInputTokens" bigint NOT NULL,
	"cacheWriteTokens" bigint NOT NULL,
	"cacheReadTokens" bigint NOT NULL,
	"outputTokens" bigint NOT NULL,
	"coldPrimeRequests" integer NOT NULL,
	"coldPrimeTokens" bigint NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "UsageRollupDay_day_agent_model_key" ON "UsageRollupDay" USING btree ("day","agent","model");--> statement-breakpoint
CREATE INDEX "UsageRollupDay_day_idx" ON "UsageRollupDay" USING btree ("day");