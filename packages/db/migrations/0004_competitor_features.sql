ALTER TABLE "telrad"."tenants" ADD COLUMN "prepaid_balance_paise" integer NOT NULL DEFAULT 0;
ALTER TABLE "telrad"."reports" ADD COLUMN "action_needed" boolean NOT NULL DEFAULT false;
ALTER TABLE "telrad"."reports" ADD COLUMN "action_needed_message" text;

CREATE TABLE "telrad"."report_ratings" (
  "id" serial PRIMARY KEY NOT NULL,
  "report_id" integer NOT NULL REFERENCES "telrad"."reports"("id"),
  "tenant_id" integer REFERENCES "telrad"."tenants"("id"),
  "author_user_id" integer NOT NULL REFERENCES "telrad"."users"("id"),
  "rating" smallint NOT NULL,
  "comment" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX "report_ratings_report_uq" ON "telrad"."report_ratings" ("report_id");
