ALTER TABLE "telrad"."critical_events" ADD COLUMN "detail" text;--> statement-breakpoint
ALTER TABLE "telrad"."critical_events" ADD COLUMN "acknowledged_by_user_id" integer;--> statement-breakpoint
ALTER TABLE "telrad"."critical_events" ADD CONSTRAINT "critical_events_acknowledged_by_user_id_users_id_fk" FOREIGN KEY ("acknowledged_by_user_id") REFERENCES "telrad"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "critical_events_open_idx" ON "telrad"."critical_events" USING btree ("acknowledged_at","notified_at");--> statement-breakpoint
CREATE INDEX "critical_events_report_idx" ON "telrad"."critical_events" USING btree ("report_id");