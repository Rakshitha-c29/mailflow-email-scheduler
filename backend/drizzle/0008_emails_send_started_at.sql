ALTER TABLE "emails" ADD COLUMN "send_started_at" timestamp with time zone;--> statement-breakpoint
-- Backfill from history: the worker has always recorded the start on each SENT event.
UPDATE "emails" e SET "send_started_at" = (ev."detail"->>'smtpStartedAt')::timestamptz
FROM "email_events" ev
WHERE ev."email_id" = e."id" AND ev."type" = 'SENT' AND ev."detail" ? 'smtpStartedAt' AND e."send_started_at" IS NULL;
