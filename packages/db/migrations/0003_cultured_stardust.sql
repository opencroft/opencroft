CREATE TABLE "ApiToken" (
	"id" text PRIMARY KEY NOT NULL,
	"agent" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"tokenHash" text NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	"lastUsedAt" timestamp with time zone,
	"revokedAt" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "McpCaller" (
	"id" text PRIMARY KEY NOT NULL,
	"fingerprint" text NOT NULL,
	"credential" text NOT NULL,
	"agent" text,
	"method" text NOT NULL,
	"tool" text,
	"sourceIp" text,
	"userAgent" text,
	"firstSeenAt" timestamp with time zone NOT NULL,
	"lastSeenAt" timestamp with time zone NOT NULL,
	"seenCount" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ApiToken_tokenHash_key" ON "ApiToken" USING btree ("tokenHash");--> statement-breakpoint
CREATE INDEX "ApiToken_agent_idx" ON "ApiToken" USING btree ("agent");--> statement-breakpoint
CREATE UNIQUE INDEX "McpCaller_fingerprint_key" ON "McpCaller" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX "McpCaller_credential_idx" ON "McpCaller" USING btree ("credential");--> statement-breakpoint
CREATE INDEX "McpCaller_lastSeenAt_idx" ON "McpCaller" USING btree ("lastSeenAt");