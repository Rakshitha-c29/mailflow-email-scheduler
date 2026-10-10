import { sql } from 'drizzle-orm';
import {
  pgTable, pgEnum, uuid, text, integer, boolean, timestamp, jsonb, bigserial, index, uniqueIndex, check, customType,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

/**
 * Email lifecycle:
 *
 *   SCHEDULED ──claim──▶ PROCESSING ──▶ SENDING ──smtp ok──▶ SENT
 *       ▲                    │             │
 *       └── deferred/retry ──┘             └── crash mid-SMTP ──▶ UNCERTAIN (never auto-resent)
 *   SCHEDULED/PROCESSING ──final failure──▶ FAILED        SCHEDULED ──user──▶ CANCELLED
 */
export const emailStatus = pgEnum('email_status', [
  'SCHEDULED', 'PROCESSING', 'SENDING', 'SENT', 'FAILED', 'UNCERTAIN', 'CANCELLED',
]);
export const slackStatus = pgEnum('slack_status', ['CONNECTED', 'REVOKED']);

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
};

/**
 * A user signs in with Google, a password, or both (linked by email). Emails are stored
 * trimmed + lowercased and are unique, so one person = one account either way.
 */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  googleId: text('google_id').unique(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash'), // argon2id, PHC string format
  // Embedded in every session JWT; bumping it logs the user out everywhere.
  sessionVersion: integer('session_version').notNull().default(1),
  name: text('name').notNull(),
  avatarUrl: text('avatar_url'),
  ...timestamps,
}, () => [
  check('users_has_login_method', sql`google_id is not null or password_hash is not null`),
]);

/** One real Ethereal SMTP mailbox per sender. Password is AES-GCM encrypted. */
export const senders = pgTable('senders', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  smtpHost: text('smtp_host').notNull(),
  smtpPort: integer('smtp_port').notNull(),
  smtpSecure: boolean('smtp_secure').notNull().default(false),
  smtpUser: text('smtp_user').notNull(),
  smtpPassEnc: text('smtp_pass_enc').notNull(),
  ...timestamps,
}, (t) => [index('senders_user_idx').on(t.userId)]);

/** One "Compose" request: one subject/body sent to many leads with pacing rules. */
export const campaigns = pgTable('campaigns', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  senderId: uuid('sender_id').notNull().references(() => senders.id),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  startAt: timestamp('start_at', { withTimezone: true }).notNull(),
  delayMs: integer('delay_ms').notNull(),
  hourlyLimit: integer('hourly_limit').notNull(),
  totalCount: integer('total_count').notNull(),
  idempotencyKey: text('idempotency_key'),
  ...timestamps,
}, (t) => [
  index('campaigns_user_idx').on(t.userId),
  // A client retrying the same request (same key) can never create a second campaign.
  uniqueIndex('campaigns_user_idem_uq').on(t.userId, t.idempotencyKey).where(sql`${t.idempotencyKey} is not null`),
]);

export const emails = pgTable('emails', {
  id: uuid('id').primaryKey().defaultRandom(),
  campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  senderId: uuid('sender_id').notNull().references(() => senders.id),
  toEmail: text('to_email').notNull(),
  subject: text('subject').notNull(),
  status: emailStatus('status').notNull().default('SCHEDULED'),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  /** When SMTP started (send-start gate, Redis clock). Limits and gaps apply to starts. */
  sendStartedAt: timestamp('send_started_at', { withTimezone: true }),
  attempts: integer('attempts').notNull().default(0),
  messageId: text('message_id'),
  previewUrl: text('preview_url'),
  lastError: text('last_error'),
  starred: boolean('starred').notNull().default(false),
  /** Set on a "Send again" copy of an UNCERTAIN email; the original row is never modified. */
  resendOf: uuid('resend_of').references((): AnyPgColumn => emails.id, { onDelete: 'set null' }),
  ...timestamps,
}, (t) => [
  // A lead appears at most once per campaign (duplicate rows in a CSV collapse to one email);
  // an explicit "Send again" copy is the one exception.
  uniqueIndex('emails_campaign_to_uq').on(t.campaignId, t.toEmail).where(sql`${t.resendOf} is null`),
  // At most one "Send again" per original: repeated/concurrent clicks can't send it twice.
  uniqueIndex('emails_resend_of_uq').on(t.resendOf).where(sql`${t.resendOf} is not null`),
  index('emails_user_status_sched_idx').on(t.userId, t.status, t.scheduledAt),
  index('emails_status_idx').on(t.status),
]);

/**
 * Files attached to a campaign. Stored ONCE per campaign (every email of the campaign
 * references the same rows), in Postgres so they survive restarts. Queue jobs never
 * carry file contents: the worker loads them by campaign id.
 */
export const attachments = pgTable('attachments', {
  id: uuid('id').primaryKey().defaultRandom(),
  campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  filename: text('filename').notNull(), // sanitized
  contentType: text('content_type').notNull(), // derived from the verified type, never client-supplied
  size: integer('size').notNull(),
  sha256: text('sha256').notNull(),
  position: integer('position').notNull().default(0), // order the user attached them in
  content: bytea('content').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('attachments_campaign_idx').on(t.campaignId)]);

/** Append-only audit trail per email (deferrals, retries, sends). */
export const emailEvents = pgTable('email_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  emailId: uuid('email_id').notNull().references(() => emails.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  detail: jsonb('detail').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('email_events_email_idx').on(t.emailId)]);

export const slackIntegrations = pgTable('slack_integrations', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().unique().references(() => users.id, { onDelete: 'cascade' }),
  teamId: text('team_id').notNull(),
  teamName: text('team_name').notNull(),
  channelName: text('channel_name'),
  webhookUrlEnc: text('webhook_url_enc').notNull(),
  accessTokenEnc: text('access_token_enc').notNull(),
  status: slackStatus('status').notNull().default('CONNECTED'),
  ...timestamps,
});

export type User = typeof users.$inferSelect;
export type Sender = typeof senders.$inferSelect;
export type Campaign = typeof campaigns.$inferSelect;
export type Email = typeof emails.$inferSelect;
export type EmailStatus = (typeof emailStatus.enumValues)[number];
export type SlackIntegration = typeof slackIntegrations.$inferSelect;
export type Attachment = typeof attachments.$inferSelect;
