import { z } from 'zod';
import { env } from '../../config/env';

const MAX_DELAY_MS = 24 * 3600 * 1000;

export const scheduleSchema = z.object({
  subject: z.string().trim().min(1, 'Subject is required').max(998),
  body: z.string().min(1, 'Body is required').max(100_000),
  recipients: z
    .array(z.string())
    .min(1, 'At least one recipient is required')
    .max(env.MAX_RECIPIENTS_PER_CAMPAIGN, `At most ${env.MAX_RECIPIENTS_PER_CAMPAIGN} recipients`),
  startAt: z.string().datetime({ offset: true, message: 'startAt must be an ISO-8601 timestamp' }),
  delayMs: z.number().int().min(0).max(MAX_DELAY_MS),
  hourlyLimit: z.number().int().min(1).max(100_000),
  senderId: z.string().uuid().optional(),
});
export type ScheduleInput = z.infer<typeof scheduleSchema>;

const STATUSES = ['SCHEDULED', 'PROCESSING', 'SENDING', 'SENT', 'FAILED', 'UNCERTAIN', 'CANCELLED'] as const;

export const listQuerySchema = z.object({
  view: z.enum(['scheduled', 'sent']).default('scheduled'),
  status: z.enum(STATUSES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  senderId: z.string().uuid().optional(),
});
export type ListQuery = z.infer<typeof listQuerySchema>;

export const searchQuerySchema = z.object({
  q: z.string().trim().max(200).default(''),
  status: z.enum(STATUSES).optional(),
  /** Restrict to a dashboard tab's statuses. */
  view: z.enum(['scheduled', 'sent']).optional(),
  senderId: z.string().uuid().optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;

// Pragmatic RFC-5322 subset: what real ESPs accept.
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/** Trims, lowercases, validates and de-duplicates recipients. */
export function normalizeRecipients(raw: string[]) {
  const seen = new Set<string>();
  const valid: string[] = [];
  const invalid: string[] = [];
  let duplicates = 0;
  for (const r of raw) {
    const e = r.trim().toLowerCase();
    if (!e) continue;
    if (e.length > 254 || !EMAIL_RE.test(e)) { invalid.push(r); continue; }
    if (seen.has(e)) { duplicates++; continue; }
    seen.add(e);
    valid.push(e);
  }
  return { valid, invalid, duplicates };
}

export const starSchema = z.object({ starred: z.boolean() });
