import 'dotenv/config';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    FRONTEND_URL: z.string().url().default('http://localhost:5173'),

    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
    ELASTICSEARCH_URL: z.string().url().default('http://localhost:9200'),
    ELASTICSEARCH_INDEX: z.string().default('emails'),

    SESSION_SECRET: z.string().min(32, 'must be at least 32 characters'),
    ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex chars (32 bytes)'),
    COOKIE_SECURE: bool,

    GOOGLE_CLIENT_ID: z.string().min(1),
    GOOGLE_CLIENT_SECRET: z.string().min(1),
    GOOGLE_REDIRECT_URI: z.string().url(),

    // Slack is optional: without it the app runs and rate-limit notifications are skipped.
    SLACK_CLIENT_ID: z.string().optional(),
    SLACK_CLIENT_SECRET: z.string().optional(),
    SLACK_REDIRECT_URI: z.string().url().optional(),

    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(5),
    EMAIL_JOB_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
    EMAIL_JOB_BACKOFF_MS: z.coerce.number().int().min(100).default(5000),

    // System-wide CEILINGS. A campaign may be stricter than these, never looser.
    MIN_DELAY_BETWEEN_EMAILS_MS: z.coerce.number().int().min(0).default(2000),
    MAX_EMAILS_PER_HOUR_PER_SENDER: z.coerce.number().int().min(1).default(200),
    GLOBAL_MAX_EMAILS_PER_SECOND: z.coerce.number().int().min(1).default(20),
    RATE_WINDOW_MS: z.coerce.number().int().min(1000).default(3_600_000),

    MAX_RECIPIENTS_PER_CAMPAIGN: z.coerce.number().int().min(1).default(10_000),
    // Campaigns are sent from multiple senders: every user gets at least 2 Ethereal mailboxes.
    SENDERS_PER_USER: z.coerce.number().int().min(2, 'must be at least 2 (users send from multiple senders)').max(10).default(2),

    // Provider throttling: a temporary (4xx) SMTP reply puts the sender on a cooldown that
    // doubles on repeats (BASE → … → MAX); an email is deferred at most MAX_DEFERRALS times.
    THROTTLE_COOLDOWN_BASE_S: z.coerce.number().int().min(1).default(60),
    THROTTLE_COOLDOWN_MAX_S: z.coerce.number().int().min(1).default(900),
    THROTTLE_MAX_DEFERRALS: z.coerce.number().int().min(0).default(10),

    // Campaign attachments (enforced server-side; the UI mirrors them).
    ATTACHMENT_MAX_FILES: z.coerce.number().int().min(0).max(20).default(5),
    ATTACHMENT_MAX_TOTAL_BYTES: z.coerce.number().int().min(1).default(10 * 1024 * 1024),

    // Password auth brute-force limits (Redis, fixed window).
    AUTH_ATTEMPT_WINDOW_S: z.coerce.number().int().min(1).default(900),
    LOGIN_MAX_PER_IP: z.coerce.number().int().min(1).default(20),
    LOGIN_MAX_FAILURES_PER_EMAIL: z.coerce.number().int().min(1).default(5),
    SIGNUP_MAX_PER_IP: z.coerce.number().int().min(1).default(10),
    SIGNUP_MAX_PER_EMAIL: z.coerce.number().int().min(1).default(3),

    // Comma-separated emails allowed to open /admin/queues. Empty = any logged-in user.
    ADMIN_EMAILS: z.string().default(''),
  })
  .superRefine((e, ctx) => {
    const set = [e.SLACK_CLIENT_ID, e.SLACK_CLIENT_SECRET, e.SLACK_REDIRECT_URI].filter(Boolean).length;
    if (set !== 0 && set !== 3) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Set all three SLACK_* variables or none' });
    }
    if (e.THROTTLE_COOLDOWN_MAX_S < e.THROTTLE_COOLDOWN_BASE_S) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['THROTTLE_COOLDOWN_MAX_S'], message: 'must be >= THROTTLE_COOLDOWN_BASE_S' });
    }
  });

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('❌ Invalid environment configuration:');
  for (const issue of parsed.error.issues) console.error(`   - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
export const slackEnabled = Boolean(env.SLACK_CLIENT_ID);
export const adminEmails = env.ADMIN_EMAILS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
