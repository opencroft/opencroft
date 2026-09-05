CREATE TABLE "SpaceApp" (
	"id" text PRIMARY KEY NOT NULL,
	"spaceId" text NOT NULL,
	"extensionId" text NOT NULL,
	"appSlug" text NOT NULL,
	"params" text DEFAULT '{}' NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "SpaceApp" ADD CONSTRAINT "SpaceApp_spaceId_Space_id_fk" FOREIGN KEY ("spaceId") REFERENCES "public"."Space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "SpaceApp_spaceId_extensionId_appSlug_key" ON "SpaceApp" USING btree ("spaceId","extensionId","appSlug");--> statement-breakpoint
CREATE INDEX "SpaceApp_spaceId_idx" ON "SpaceApp" USING btree ("spaceId");