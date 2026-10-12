ALTER TABLE "telrad"."studies" ADD COLUMN "pinned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "telrad"."studies" ADD COLUMN "purged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "telrad"."tenants" ADD COLUMN "retention_days" integer;--> statement-breakpoint
ALTER TABLE "telrad"."tenants" ADD CONSTRAINT "tenants_retention_days_positive" CHECK ("telrad"."tenants"."retention_days" is null or "telrad"."tenants"."retention_days" >= 1);