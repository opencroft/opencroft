CREATE TABLE "SpaceSlugAlias" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"spaceId" text NOT NULL,
	"createdAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "SpaceSlugAlias" ADD CONSTRAINT "SpaceSlugAlias_spaceId_Space_id_fk" FOREIGN KEY ("spaceId") REFERENCES "public"."Space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "SpaceSlugAlias_slug_key" ON "SpaceSlugAlias" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "SpaceSlugAlias_spaceId_idx" ON "SpaceSlugAlias" USING btree ("spaceId");