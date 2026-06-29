CREATE TABLE "AppLink" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "McpAuditLog" (
	"id" text PRIMARY KEY NOT NULL,
	"tool" text NOT NULL,
	"args" text DEFAULT '{}' NOT NULL,
	"result" text,
	"error" text,
	"status" text DEFAULT 'auto-approved' NOT NULL,
	"durationMs" integer NOT NULL,
	"createdAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "Secret" (
	"id" text PRIMARY KEY NOT NULL,
	"storeId" text NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "Setting" (
	"id" text PRIMARY KEY NOT NULL,
	"data" text DEFAULT '{}' NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "Space" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"data" text DEFAULT '{"nodes":[],"edges":[]}' NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "McpAuditLog_tool_idx" ON "McpAuditLog" USING btree ("tool");--> statement-breakpoint
CREATE INDEX "McpAuditLog_status_idx" ON "McpAuditLog" USING btree ("status");--> statement-breakpoint
CREATE INDEX "McpAuditLog_createdAt_idx" ON "McpAuditLog" USING btree ("createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX "Secret_storeId_key_key" ON "Secret" USING btree ("storeId","key");--> statement-breakpoint
CREATE INDEX "Secret_storeId_idx" ON "Secret" USING btree ("storeId");--> statement-breakpoint
CREATE UNIQUE INDEX "Space_slug_key" ON "Space" USING btree ("slug");