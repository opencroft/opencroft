CREATE TABLE "ChatUsageCostRepair" (
	"turnId" text NOT NULL,
	"migration" text NOT NULL,
	"originalAmount" double precision NOT NULL,
	"originalCurrency" text,
	"repairedAmount" double precision,
	"createdAt" timestamp with time zone NOT NULL,
	CONSTRAINT "ChatUsageCostRepair_turnId_migration_pk" PRIMARY KEY("turnId","migration")
);
--> statement-breakpoint
ALTER TABLE "ChatUsageCostRepair" ADD CONSTRAINT "ChatUsageCostRepair_turnId_ChatUsageTurn_id_fk" FOREIGN KEY ("turnId") REFERENCES "public"."ChatUsageTurn"("id") ON DELETE cascade ON UPDATE no action;