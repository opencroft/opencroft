CREATE TABLE "TranscriptSearchEntry" (
	"sessionKey" text NOT NULL,
	"position" integer NOT NULL,
	"role" text NOT NULL,
	"segment" integer NOT NULL,
	"text" text NOT NULL,
	"document" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', "TranscriptSearchEntry"."text")) STORED,
	"createdAt" timestamp with time zone NOT NULL,
	CONSTRAINT "TranscriptSearchEntry_sessionKey_position_role_segment_pk" PRIMARY KEY("sessionKey","position","role","segment")
);
--> statement-breakpoint
CREATE INDEX "TranscriptSearchEntry_document_idx" ON "TranscriptSearchEntry" USING gin ("document");