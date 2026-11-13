CREATE TABLE "AgentSessionLegacyLog" (
	"sessionKey" text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
-- Every key recorded so far, for the event store to rewrite into the compacted
-- layout. Not part of the schema drizzle tracks.
INSERT INTO "AgentSessionLegacyLog" ("sessionKey") SELECT DISTINCT "sessionKey" FROM "AgentSessionEvent";
