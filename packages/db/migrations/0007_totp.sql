ALTER TABLE "telrad"."users" ADD COLUMN "totp_secret" text;--> statement-breakpoint
ALTER TABLE "telrad"."users" ADD COLUMN "totp_enabled" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "telrad"."users" ADD COLUMN "totp_backup_codes" jsonb;