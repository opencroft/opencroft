CREATE TABLE "Username" (
	"id" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"principalType" text NOT NULL,
	"userId" text,
	"agentNodeId" text,
	"retiredAt" timestamp with time zone,
	"createdAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "Username" ADD CONSTRAINT "Username_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "Username_username_key" ON "Username" USING btree ("username");--> statement-breakpoint
CREATE UNIQUE INDEX "Username_current_userId_key" ON "Username" USING btree ("userId") WHERE "Username"."retiredAt" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "Username_current_agentNodeId_key" ON "Username" USING btree ("agentNodeId") WHERE "Username"."retiredAt" is null;--> statement-breakpoint
CREATE INDEX "Username_userId_idx" ON "Username" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "Username_agentNodeId_idx" ON "Username" USING btree ("agentNodeId");