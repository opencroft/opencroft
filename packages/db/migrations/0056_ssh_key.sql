CREATE TABLE "SshKey" (
	"id" text PRIMARY KEY NOT NULL,
	"storeId" text NOT NULL,
	"name" text NOT NULL,
	"privateKeyEncrypted" text NOT NULL,
	"publicKey" text,
	"keyType" text NOT NULL,
	"fingerprint" text NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "SshKey_storeId_name_key" ON "SshKey" USING btree ("storeId","name");