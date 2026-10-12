CREATE TABLE "telrad"."sla_targets" (
  "id" serial PRIMARY KEY NOT NULL,
  "tenant_id" integer REFERENCES "telrad"."tenants"("id"),
  "modality_code" text NOT NULL,
  "priority" text NOT NULL,
  "sla_minutes" integer NOT NULL,
  "effective_from" timestamp with time zone NOT NULL,
  "effective_to" timestamp with time zone
);

CREATE UNIQUE INDEX "sla_targets_tenant_modality_priority_uq" ON "telrad"."sla_targets" ("tenant_id", "modality_code", "priority") WHERE "effective_to" IS NULL;
