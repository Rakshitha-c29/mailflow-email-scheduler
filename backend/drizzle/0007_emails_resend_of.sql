DROP INDEX "emails_campaign_to_uq";--> statement-breakpoint
ALTER TABLE "emails" ADD COLUMN "resend_of" uuid;--> statement-breakpoint
ALTER TABLE "emails" ADD CONSTRAINT "emails_resend_of_emails_id_fk" FOREIGN KEY ("resend_of") REFERENCES "public"."emails"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "emails_resend_of_uq" ON "emails" USING btree ("resend_of") WHERE "emails"."resend_of" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "emails_campaign_to_uq" ON "emails" USING btree ("campaign_id","to_email") WHERE "emails"."resend_of" is null;