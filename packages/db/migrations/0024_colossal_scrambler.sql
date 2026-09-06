CREATE TABLE "SpaceGraph" (
	"id" text PRIMARY KEY NOT NULL,
	"spaceId" text NOT NULL,
	"instanceId" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"data" text DEFAULT '{"nodes":[],"edges":[]}' NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "Space" ADD COLUMN "defaultGraphSlug" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "SpaceGraph" ADD CONSTRAINT "SpaceGraph_spaceId_Space_id_fk" FOREIGN KEY ("spaceId") REFERENCES "public"."Space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "SpaceGraph" ADD CONSTRAINT "SpaceGraph_instanceId_SpaceApp_id_fk" FOREIGN KEY ("instanceId") REFERENCES "public"."SpaceApp"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "SpaceGraph_spaceId_slug_key" ON "SpaceGraph" USING btree ("spaceId","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "SpaceGraph_instanceId_key" ON "SpaceGraph" USING btree ("instanceId");--> statement-breakpoint
CREATE INDEX "SpaceGraph_spaceId_idx" ON "SpaceGraph" USING btree ("spaceId");