CREATE TABLE "Extension" (
	"folder" text PRIMARY KEY NOT NULL,
	"sourceUrl" text,
	"registryName" text,
	"authStoreId" text,
	"authUsernameKey" text,
	"authTokenKey" text,
	"ref" text,
	"commit" text,
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL
);
