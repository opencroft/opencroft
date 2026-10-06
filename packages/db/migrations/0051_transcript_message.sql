CREATE TABLE "TranscriptMessage" (
	"sessionKey" text NOT NULL,
	"position" integer NOT NULL,
	"segment" integer NOT NULL,
	"role" text NOT NULL,
	"turn" integer NOT NULL,
	"text" text NOT NULL,
	"document" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', "TranscriptMessage"."text")) STORED,
	"createdAt" timestamp with time zone NOT NULL,
	CONSTRAINT "TranscriptMessage_sessionKey_position_segment_pk" PRIMARY KEY("sessionKey","position","segment")
);
--> statement-breakpoint
CREATE TABLE "TranscriptMessageCursor" (
	"sessionKey" text PRIMARY KEY NOT NULL,
	"resumeFrom" integer NOT NULL,
	"turn" integer,
	"openPosition" integer,
	"openSegment" integer NOT NULL
);
--> statement-breakpoint
DROP TABLE "TranscriptSearchEntry" CASCADE;--> statement-breakpoint
CREATE INDEX "TranscriptMessage_document_idx" ON "TranscriptMessage" USING gin ("document");