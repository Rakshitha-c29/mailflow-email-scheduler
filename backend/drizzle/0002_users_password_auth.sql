-- Existing (Google) rows: normalise emails before they become unique login identifiers.
UPDATE "users" SET "email" = lower(trim("email")) WHERE "email" <> lower(trim("email"));--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "google_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_hash" text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_email_unique" UNIQUE("email");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_has_login_method" CHECK (google_id is not null or password_hash is not null);