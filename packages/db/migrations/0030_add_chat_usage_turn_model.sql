CREATE TABLE "ChatUsageTurnModel" (
	"id" text PRIMARY KEY NOT NULL,
	"turnId" text NOT NULL,
	"model" text,
	"inputTokens" bigint NOT NULL,
	"outputTokens" bigint NOT NULL,
	"cacheReadTokens" bigint NOT NULL,
	"cacheWriteTokens" bigint NOT NULL,
	"totalTokens" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ChatUsageTurnModel" ADD CONSTRAINT "ChatUsageTurnModel_turnId_ChatUsageTurn_id_fk" FOREIGN KEY ("turnId") REFERENCES "public"."ChatUsageTurn"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ChatUsageTurnModel_turnId_idx" ON "ChatUsageTurnModel" USING btree ("turnId");