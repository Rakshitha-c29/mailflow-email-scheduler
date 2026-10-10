ALTER TABLE "senders" ALTER COLUMN "smtp_secure" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "senders" ALTER COLUMN "smtp_secure" SET DATA TYPE boolean USING "smtp_secure" <> 0;--> statement-breakpoint
ALTER TABLE "senders" ALTER COLUMN "smtp_secure" SET DEFAULT false;
