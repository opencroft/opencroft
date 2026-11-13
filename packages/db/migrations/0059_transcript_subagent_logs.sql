ALTER TABLE "AgentSessionEvent" ADD COLUMN "subagentId" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "AgentSessionEvent" ADD COLUMN "kind" text GENERATED ALWAYS AS (("AgentSessionEvent"."event" ->> 'kind')) STORED;--> statement-breakpoint
ALTER TABLE "AgentSessionEvent" DROP CONSTRAINT "AgentSessionEvent_sessionKey_position_pk";--> statement-breakpoint
ALTER TABLE "AgentSessionEvent" ADD CONSTRAINT "AgentSessionEvent_sessionKey_subagentId_position_pk" PRIMARY KEY("sessionKey","subagentId","position");--> statement-breakpoint
ALTER TABLE "TranscriptMessageCursor" ADD COLUMN "resumeChars" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "AgentSessionEvent_kind_idx" ON "AgentSessionEvent" USING btree ("sessionKey","subagentId","kind","position");--> statement-breakpoint
-- Room on each page for an entry rewritten in place, so a rewrite can stay on
-- its page and leave the indexes alone. Not part of the schema drizzle tracks.
ALTER TABLE "AgentSessionEvent" SET (fillfactor = 90);
