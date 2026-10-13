CREATE TABLE "telrad"."idempotency_keys" (
	"key" text PRIMARY KEY,
	"route" text NOT NULL,
	"entity_id" integer NOT NULL,
	"response_status" smallint NOT NULL,
	"response_body" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
