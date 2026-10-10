import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { env } from '../../config/env';
import { db } from '../../lib/db';
import { logger } from '../../lib/logger';
import { toPreview } from '../../lib/text';
import { AppError, badRequest, isUniqueViolation, notFound, unavailable } from '../../lib/errors';
import { attachments, campaigns, emailEvents, emails, senders, type EmailStatus } from '../../db/schema';
import { listAttachmentMeta, type ValidatedAttachment } from '../attachments/attachment.service';
import { emailJob, emailQueue, enqueueIndex } from '../../queues';
import { planSendTimes } from '../../scheduler/planner';
import { effectiveGap, effectiveLimit, windowOf } from '../../scheduler/rateLimiter';
import { ensureSenders } from '../senders/sender.service';
import { normalizeRecipients, type ListQuery, type ScheduleInput } from './email.schemas';

export const SCHEDULED_VIEW: EmailStatus[] = ['SCHEDULED', 'PROCESSING', 'SENDING'];
export const SENT_VIEW: EmailStatus[] = ['SENT', 'FAILED', 'UNCERTAIN'];

const INSERT_CHUNK = 1000;
const ENQUEUE_CHUNK = 500;

async function resolveSender(userId: string, senderId?: string) {
  await ensureSenders(userId).catch((err) => {
    logger.error({ err }, 'could not provision senders');
    throw unavailable('Could not provision an Ethereal sender. Please retry in a moment.');
  });
  const rows = await db.select().from(senders).where(eq(senders.userId, userId)).orderBy(asc(senders.createdAt));
  if (!senderId) return rows[0];
  const s = rows.find((r) => r.id === senderId);
  if (!s) throw badRequest('Unknown sender');
  return s;
}

async function campaignSummary(campaignId: string) {
  const c = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaignId) });
  if (!c) throw notFound('Campaign');
  const [range] = await db
    .select({
      // mapWith: aggregates come back from pg as raw strings; parse them like the column.
      first: sql<Date>`min(${emails.scheduledAt})`.mapWith(emails.scheduledAt),
      last: sql<Date>`max(${emails.scheduledAt})`.mapWith(emails.scheduledAt),
    })
    .from(emails)
    .where(eq(emails.campaignId, campaignId));
  return {
    id: c.id,
    scheduledCount: c.totalCount,
    senderId: c.senderId,
    effective: { delayMs: effectiveGap(c.delayMs), hourlyLimit: effectiveLimit(c.hourlyLimit) },
    attachments: await listAttachmentMeta(c.id),
    firstSendAt: range.first,
    lastSendAt: range.last,
  };
}

/**
 * Creates a campaign and one row + one delayed BullMQ job per recipient.
 *
 * Ordering matters for crash safety:
 *   1. Rows are committed in one transaction (all-or-nothing).
 *   2. Jobs are enqueued with jobId = emailId (idempotent).
 *   3. If enqueueing fails, the campaign is deleted and the client gets a 503, so it's safe
 *      to retry. If the *process* dies between 1 and 2, the worker's boot-time reconciliation
 *      finds SCHEDULED rows without jobs and enqueues them. Either way, nothing is lost.
 */
export async function scheduleCampaign(
  userId: string, input: ScheduleInput, idempotencyKey?: string, files: ValidatedAttachment[] = [], isRetry = false,
): Promise<{ campaign: Awaited<ReturnType<typeof campaignSummary>>; replayed: boolean; warnings: string[] }> {
  if (idempotencyKey) {
    const existing = await db.query.campaigns.findFirst({
      where: and(eq(campaigns.userId, userId), eq(campaigns.idempotencyKey, idempotencyKey)),
    });
    if (existing) return { campaign: await campaignSummary(existing.id), replayed: true, warnings: [] as string[] };
  }

  const { valid, invalid, duplicates } = normalizeRecipients(input.recipients);
  if (invalid.length) {
    throw badRequest(`${invalid.length} invalid email address(es)`, { invalid: invalid.slice(0, 20) });
  }
  if (!valid.length) throw badRequest('No valid recipients');

  const sender = await resolveSender(userId, input.senderId);
  const warnings: string[] = [];
  if (duplicates) warnings.push(`${duplicates} duplicate address(es) were removed`);

  const gap = effectiveGap(input.delayMs);
  const limit = effectiveLimit(input.hourlyLimit);
  if (gap !== input.delayMs) warnings.push(`Delay raised to the system minimum of ${gap} ms`);
  if (limit !== input.hourlyLimit) warnings.push(`Hourly limit capped at the system maximum of ${limit}`);

  const now = Date.now();
  const startAt = Math.max(new Date(input.startAt).getTime(), now);
  const times = planSendTimes({ count: valid.length, startAt, gapMs: gap, limit, windowMs: env.RATE_WINDOW_MS });

  let campaignId: string;
  let created: { id: string; scheduledAt: Date }[] = [];
  try {
    ({ campaignId, created } = await db.transaction(async (tx) => {
      const [c] = await tx
        .insert(campaigns)
        .values({
          userId, senderId: sender.id, subject: input.subject, body: input.body,
          startAt: new Date(startAt), delayMs: input.delayMs, hourlyLimit: input.hourlyLimit,
          totalCount: valid.length, idempotencyKey: idempotencyKey ?? null,
        })
        .returning({ id: campaigns.id });

      // Stored once for the campaign; every email (and job) just refers to the campaign.
      if (files.length) {
        await tx.insert(attachments).values(files.map((a, position) => ({ ...a, position, campaignId: c.id, userId })));
      }

      const rows: { id: string; scheduledAt: Date }[] = [];
      for (let i = 0; i < valid.length; i += INSERT_CHUNK) {
        const chunk = valid.slice(i, i + INSERT_CHUNK).map((to, j) => ({
          campaignId: c.id, userId, senderId: sender.id, toEmail: to,
          subject: input.subject, scheduledAt: new Date(times[i + j]),
        }));
        rows.push(...(await tx.insert(emails).values(chunk).returning({ id: emails.id, scheduledAt: emails.scheduledAt })));
      }

      // The limit is usually "hit" here, at scheduling time: the planner already moved these
      // emails into a later window. Record it now, so their history shows when and why.
      const pushed = rows.flatMap((r, i) => (times[i] > startAt + i * gap ? [{
        emailId: r.id,
        type: 'DEFERRED',
        detail: { until: new Date(times[i]).toISOString(), reason: 'rate limit', limit, window: windowOf(times[i]), planned: true },
      }] : []));
      for (let i = 0; i < pushed.length; i += INSERT_CHUNK) {
        await tx.insert(emailEvents).values(pushed.slice(i, i + INSERT_CHUNK));
      }
      return { campaignId: c.id, created: rows };
    }));
  } catch (err) {
    // Concurrent request with the same idempotency key won the race: return its result.
    if (idempotencyKey && !isRetry && isUniqueViolation(err)) {
      return scheduleCampaign(userId, input, idempotencyKey, files, true);
    }
    throw err;
  }

  try {
    for (let i = 0; i < created.length; i += ENQUEUE_CHUNK) {
      await emailQueue.addBulk(created.slice(i, i + ENQUEUE_CHUNK).map((e) => emailJob(e.id, e.scheduledAt, now)));
    }
  } catch (err) {
    logger.error({ err, campaignId }, 'enqueue failed, rolling back campaign');
    await db.delete(campaigns).where(eq(campaigns.id, campaignId)); // orphan jobs no-op in the worker
    throw new AppError(503, 'Queue unavailable, nothing was scheduled. Please retry.', 'QUEUE_UNAVAILABLE');
  }

  // Search indexing is a side effect: never fail the request because of it.
  enqueueIndex(created.map((e) => e.id)).catch((err) => logger.warn({ err }, 'index enqueue failed'));

  logger.info({ campaignId, count: created.length, sender: sender.email, gap, limit }, 'campaign scheduled');
  return { campaign: await campaignSummary(campaignId), replayed: false, warnings };
}

/** The statuses a dashboard tab shows, optionally narrowed to one (which must belong to it). */
export function viewStatuses(view: 'scheduled' | 'sent', status?: EmailStatus): EmailStatus[] {
  const all = view === 'scheduled' ? SCHEDULED_VIEW : SENT_VIEW;
  if (!status) return all;
  if (!all.includes(status)) throw badRequest(`Status ${status} is not part of the ${view} view`);
  return [status];
}

export async function listEmails(userId: string, q: ListQuery) {
  const statuses = viewStatuses(q.view, q.status);
  const where = and(
    eq(emails.userId, userId),
    inArray(emails.status, statuses),
    q.senderId ? eq(emails.senderId, q.senderId) : undefined,
  );
  const order = q.view === 'scheduled'
    ? [asc(emails.scheduledAt), asc(emails.id)]
    // Sent tab: newest send START first (the time the row shows, and what the limit counts).
    : [desc(sql`coalesce(${emails.sendStartedAt}, ${emails.sentAt}, ${emails.updatedAt})`), desc(emails.id)];

  const [items, [{ total }]] = await Promise.all([
    db
      .select({
        id: emails.id, toEmail: emails.toEmail, subject: emails.subject, status: emails.status,
        scheduledAt: emails.scheduledAt, sentAt: emails.sentAt, sendStartedAt: emails.sendStartedAt, attempts: emails.attempts,
        previewUrl: emails.previewUrl, lastError: emails.lastError, campaignId: emails.campaignId,
        starred: emails.starred,
        // Enough of the body for a one-line snippet, without shipping whole bodies.
        bodyStart: sql<string>`substring(${campaigns.body} from 1 for 1000)`,
        sender: { id: senders.id, name: senders.name, email: senders.email },
      })
      .from(emails)
      .innerJoin(senders, eq(senders.id, emails.senderId))
      .innerJoin(campaigns, eq(campaigns.id, emails.campaignId))
      .where(where)
      .orderBy(...order)
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize)
      .then((rows) => rows.map(({ bodyStart, ...r }) => ({ ...r, preview: toPreview(bodyStart) }))),
    db.select({ total: count() }).from(emails).where(where),
  ]);

  return { items, page: q.page, pageSize: q.pageSize, total, totalPages: Math.max(1, Math.ceil(total / q.pageSize)) };
}

export async function getStats(userId: string) {
  const rows = await db
    .select({ status: emails.status, n: count() })
    .from(emails)
    .where(eq(emails.userId, userId))
    .groupBy(emails.status);
  const by = Object.fromEntries(rows.map((r) => [r.status, r.n])) as Partial<Record<EmailStatus, number>>;
  const sum = (s: EmailStatus[]) => s.reduce((acc, k) => acc + (by[k] ?? 0), 0);
  return { scheduled: sum(SCHEDULED_VIEW), sent: by.SENT ?? 0, failed: sum(['FAILED', 'UNCERTAIN']), byStatus: by };
}

export async function getEmail(userId: string, id: string) {
  const row = await db.query.emails.findFirst({ where: and(eq(emails.id, id), eq(emails.userId, userId)) });
  if (!row) throw notFound('Email');
  const [campaign, sender, events, files] = await Promise.all([
    db.query.campaigns.findFirst({
      where: eq(campaigns.id, row.campaignId),
      columns: { body: true, startAt: true, delayMs: true, hourlyLimit: true, totalCount: true },
    }),
    db.query.senders.findFirst({ where: eq(senders.id, row.senderId), columns: { id: true, name: true, email: true } }),
    db.select().from(emailEvents).where(eq(emailEvents.emailId, id)).orderBy(asc(emailEvents.id)),
    listAttachmentMeta(row.campaignId),
  ]);
  const resentAs = await db.query.emails.findFirst({ where: eq(emails.resendOf, id), columns: { id: true, status: true } });
  // What the user entered and what the server actually used (it clamps to the system limits).
  const settings = campaign && {
    startAt: campaign.startAt,
    delayMs: campaign.delayMs,
    hourlyLimit: campaign.hourlyLimit,
    totalCount: campaign.totalCount,
    windowMs: env.RATE_WINDOW_MS,
    effective: { delayMs: effectiveGap(campaign.delayMs), hourlyLimit: effectiveLimit(campaign.hourlyLimit) },
  };
  return {
    ...row, body: campaign?.body ?? '', sender: sender ?? null, attachments: files, events,
    resentAs: resentAs ?? null, campaign: settings ?? null,
  };
}

/**
 * Cancel is a conditional update: it only wins if the worker hasn't claimed the email.
 * If the worker claims first, cancel returns 409; if cancel wins, the worker's claim
 * fails and the job no-ops. Removing the BullMQ job is just cleanup.
 */
export async function cancelEmail(userId: string, id: string) {
  const [row] = await db
    .update(emails)
    .set({ status: 'CANCELLED' })
    .where(and(eq(emails.id, id), eq(emails.userId, userId), eq(emails.status, 'SCHEDULED')))
    .returning({ id: emails.id });
  if (!row) {
    const exists = await db.query.emails.findFirst({ where: and(eq(emails.id, id), eq(emails.userId, userId)) });
    if (!exists) throw notFound('Email');
    throw new AppError(409, `Email is already ${exists.status.toLowerCase()} and can't be cancelled`, 'CONFLICT');
  }
  await db.insert(emailEvents).values({ emailId: id, type: 'CANCELLED' });
  await emailQueue.remove(id).catch(() => undefined);
  enqueueIndex([id]).catch(() => undefined);
}

/** Star/unstar is a user flag, allowed in any status. */
export async function setStarred(userId: string, id: string, starred: boolean) {
  const [row] = await db
    .update(emails)
    .set({ starred })
    .where(and(eq(emails.id, id), eq(emails.userId, userId)))
    .returning({ id: emails.id, starred: emails.starred });
  if (!row) throw notFound('Email');
  enqueueIndex([id]).catch(() => undefined);
  return row;
}

/**
 * "Send again" for an UNCERTAIN email (interrupted mid-SMTP: it may or may not have
 * arrived). Creates a NEW email (new id, same campaign, so the same body and attachments)
 * and leaves the original row untouched.
 *
 * Idempotent: an original can be re-sent once. Asking again returns the existing copy, and
 * two concurrent requests race on a unique index (emails.resend_of): one creates, the other
 * gets the winner's copy. The copy goes through the normal pipeline (rate limits etc.).
 */
export async function resendUncertain(userId: string, id: string): Promise<{ email: { id: string }; created: boolean }> {
  const original = await db.query.emails.findFirst({ where: and(eq(emails.id, id), eq(emails.userId, userId)) });
  if (!original) throw notFound('Email');

  const existingCopy = () => db.query.emails.findFirst({ where: eq(emails.resendOf, id), columns: { id: true } });
  const already = await existingCopy();
  if (already) return { email: already, created: false };
  if (original.status !== 'UNCERTAIN') {
    throw new AppError(409, 'Only emails whose delivery is uncertain can be sent again', 'CONFLICT');
  }

  const now = new Date();
  let copy: { id: string };
  try {
    [copy] = await db.insert(emails).values({
      campaignId: original.campaignId, userId, senderId: original.senderId, toEmail: original.toEmail,
      subject: original.subject, scheduledAt: now, resendOf: original.id,
    }).returning({ id: emails.id });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const winner = await existingCopy(); // a concurrent request created it first
    if (winner) return { email: winner, created: false };
    throw err;
  }

  try {
    const job = emailJob(copy.id, now);
    await emailQueue.add(job.name, job.data, job.opts);
  } catch (err) {
    await db.delete(emails).where(eq(emails.id, copy.id));
    logger.error({ err, emailId: id }, 'resend enqueue failed, rolled back');
    throw new AppError(503, 'Queue unavailable, nothing was sent. Please retry.', 'QUEUE_UNAVAILABLE');
  }
  await db.insert(emailEvents).values([
    { emailId: original.id, type: 'RESENT', detail: { newEmailId: copy.id } },
    { emailId: copy.id, type: 'RESEND_OF', detail: { originalEmailId: original.id } },
  ]);
  enqueueIndex([original.id, copy.id]).catch(() => undefined);
  logger.info({ originalEmailId: id, newEmailId: copy.id }, 'uncertain email sent again as a new email');
  return { email: copy, created: true };
}
