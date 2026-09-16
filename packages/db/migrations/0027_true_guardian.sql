CREATE TABLE "AgentSessionEvent" (
	"sessionKey" text NOT NULL,
	"position" integer NOT NULL,
	"event" jsonb NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	CONSTRAINT "AgentSessionEvent_sessionKey_position_pk" PRIMARY KEY("sessionKey","position")
);
