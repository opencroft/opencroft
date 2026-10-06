CREATE TABLE "CollabDoc" (
	"name" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"lineage" text NOT NULL,
	"sourceVersion" text,
	"schemaVersion" integer NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "CollabDocUpdate" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"update" text NOT NULL,
	"createdAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "CollabDocUpdate" ADD CONSTRAINT "CollabDocUpdate_name_CollabDoc_name_fk" FOREIGN KEY ("name") REFERENCES "public"."CollabDoc"("name") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "CollabDocUpdate_name_idx" ON "CollabDocUpdate" USING btree ("name");