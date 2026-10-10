import { and, asc, eq, gt, inArray, lte } from 'drizzle-orm';
import { db } from '../lib/db';
import { redis } from '../lib/redis';
import { logger } from '../lib/logger';
import { randomToken } from '../lib/crypto';
import { campaigns, emailEvents, emails, type EmailStatus } from '../db/schema';
import { emailJob, emailQueue, enqueueIndex, type EmailJobData } from '../queues';
import { effectiveGap, effectiveLimit, reserveSendSlot, senderCooldownUntil, windowOf } from '../scheduler/rateLimiter';
import { maybeNotifyLimit } from '../workers/email.processor';

/**
 * Makes Redis (jobs) agree with Postgres (truth) after a crash. Runs ONCE at worker boot,
 * before the worker starts taking jobs. No timers, no repeatable jobs.
 *
 *   SCHEDULED  without a live job   → re-add the job (e.g. API died between commit and enqueue,
 *                                     or Redis lost data)
 *   PROCESSING without an active job → back to SCHEDULED + re-add (died before SMTP: safe to redo)
 *   SENDING    without an active job → UNCERTAIN (died mid-SMTP: may have been sent, never resend)
 *   SCHEDULED  and overdue           → rate-limit slots handed out in planned order (see
 *                                     assignOverdueSlots), so they don't race for them
 *
 * Rows whose job is *active* are left alone: either another worker is handling it right
 * now, or its lock will expire and BullMQ's stalled check re-runs it, where the
 * processor's claim applies the same rules.
 *
 * A Redis lock makes sure only one booting worker reconciles at a time.
 */
const LOCK_KEY = 'lock:reconcile';
const LOCK_TTL_MS = 5 * 60_000;
const BATCH = 500;

/**
 * Handed-out slots for overdue emails start this long after startup. When the worker starts
 * taking jobs, every overdue email then wakes at its own slot, one gap after the previous one,
 * as in normal running; otherwise several slots would already have passed and those emails
 * would race again at the send-start gate.
 */
const STARTUP_MARGIN_MS = 1000;

const LIVE_STATES = new Set(['waiting', 'delayed', 'prioritized', 'waiting-children', 'active']);

// Only the owner of the lock may extend or release it.
const EXTEND_LUA = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE_LUA = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;

export interface ReconcileResult {
  requeued: number;
  reset: number;
  uncertain: number;
  /** Overdue emails given their slot in planned order. */
  ordered: number;
  skipped?: 'locked';
}

export async function reconcile(): Promise<ReconcileResult> {
  const token = randomToken();
  const acquired = await redis.set(LOCK_KEY, token, 'PX', LOCK_TTL_MS, 'NX');
  if (acquired !== 'OK') {
    logger.info('reconciliation already running in another worker, skipping');
    return { requeued: 0, reset: 0, uncertain: 0, ordered: 0, skipped: 'locked' };
  }

  const started = Date.now();
  const result: ReconcileResult = { requeued: 0, reset: 0, uncertain: 0, ordered: 0 };
  const keepLock = () => redis.eval(EXTEND_LUA, 1, LOCK_KEY, token, LOCK_TTL_MS);

  try {
    // SENDING first so nothing below can touch those rows.
    await forEachBatch('SENDING', keepLock, async (rows, states) => {
      const ids = rows.filter((r) => states.get(r.id) !== 'active').map((r) => r.id);
      result.uncertain += await markUncertain(ids);
    });

    await forEachBatch('SCHEDULED', keepLock, async (rows, states) => {
      const missing = rows.filter((r) => !LIVE_STATES.has(states.get(r.id)!));
      result.requeued += await requeue(missing, states, 'REQUEUED');
    });

    await forEachBatch('PROCESSING', keepLock, async (rows, states) => {
      const stuck = rows.filter((r) => states.get(r.id) !== 'active');
      const reset = await resetToScheduled(stuck.map((r) => r.id));
      result.reset += reset.length;
      const needJob = stuck.filter((r) => reset.includes(r.id) && !LIVE_STATES.has(states.get(r.id)!));
      result.requeued += await requeue(needJob, states, null);
    });

    // Last, so every overdue email above already has its job.
    result.ordered = await assignOverdueSlots(keepLock);

    logger.info({ ...result, ms: Date.now() - started }, 'reconciliation finished');
    return result;
  } finally {
    await redis.eval(RELEASE_LUA, 1, LOCK_KEY, token).catch(() => undefined);
  }
}

type Row = { id: string; scheduledAt: Date };

/** Keyset-paginates rows in one status and looks up each row's BullMQ job state (jobId = emailId). */
async function forEachBatch(
  status: EmailStatus,
  keepLock: () => Promise<unknown>,
  fn: (rows: Row[], states: Map<string, string>) => Promise<void>,
): Promise<void> {
  let lastId: string | undefined;
  for (;;) {
    const rows = await db
      .select({ id: emails.id, scheduledAt: emails.scheduledAt })
      .from(emails)
      .where(and(eq(emails.status, status), lastId ? gt(emails.id, lastId) : undefined))
      .orderBy(asc(emails.id))
      .limit(BATCH);
    if (!rows.length) return;

    const states = new Map(
      await Promise.all(rows.map(async (r) => [r.id, await emailQueue.getJobState(r.id)] as const)),
    );
    await fn(rows, states);
    await keepLock();
    lastId = rows[rows.length - 1].id;
    if (rows.length < BATCH) return;
  }
}

/**
 * A finished (completed/failed) job with the same id would make add() a silent no-op,
 * so it is removed first. Past-due emails get delay 0 and go out as soon as the
 * worker starts; the rate limiter spaces them out.
 */
async function requeue(rows: Row[], states: Map<string, string>, eventType: string | null): Promise<number> {
  if (!rows.length) return 0;
  const finished = rows.filter((r) => states.get(r.id) === 'completed' || states.get(r.id) === 'failed');
  await Promise.all(finished.map((r) => emailQueue.remove(r.id)));

  const now = Date.now();
  await emailQueue.addBulk(rows.map((r) => emailJob(r.id, r.scheduledAt, now)));
  if (eventType) {
    await db.insert(emailEvents).values(rows.map((r) => ({ emailId: r.id, type: eventType, detail: { by: 'reconcile' } })));
  }
  return rows.length;
}

/**
 * After the worker was off past their send time, every overdue email would be released at
 * once and they would race for rate-limit slots: whichever reached Redis first got the
 * earlier slot, so they could go out in any order. Instead, before any job is taken, each
 * sender's overdue emails get their slots here, one by one in planned order (planned times
 * already follow recipient order within a campaign; ties across campaigns go by campaign,
 * then email creation, then id). The same Redis script as the worker hands them out, so the
 * limit and the gap are unchanged. Each job keeps its slot and wakes at it, the worker reuses
 * it, and the send-start gate still checks the gap and that the window hasn't ended.
 *
 * Skipped (they reserve at run time, as before): senders in a provider cooldown, and jobs
 * that are not waiting or delayed (e.g. running in another worker). A slot that ends up
 * unused stays counted, which only errs on the strict side.
 */
async function assignOverdueSlots(keepLock: () => Promise<unknown>): Promise<number> {
  const rows = await db
    .select({
      id: emails.id, userId: emails.userId, senderId: emails.senderId, scheduledAt: emails.scheduledAt,
      hourlyLimit: campaigns.hourlyLimit, delayMs: campaigns.delayMs,
    })
    .from(emails)
    .innerJoin(campaigns, eq(campaigns.id, emails.campaignId))
    .where(and(eq(emails.status, 'SCHEDULED'), lte(emails.scheduledAt, new Date())))
    .orderBy(asc(emails.senderId), asc(emails.scheduledAt), asc(campaigns.createdAt), asc(emails.createdAt), asc(emails.id));

  const coolingDown = new Map<string, boolean>();
  const moved: string[] = [];
  let ordered = 0;
  for (const [i, row] of rows.entries()) {
    if (i && i % BATCH === 0) await keepLock();
    if (!coolingDown.has(row.senderId)) coolingDown.set(row.senderId, Boolean(await senderCooldownUntil(row.senderId)));
    if (coolingDown.get(row.senderId)) continue;

    const job = await emailQueue.getJob(row.id);
    const state = job ? await job.getState() : 'missing';
    if (!job || (state !== 'delayed' && state !== 'waiting')) continue;

    const limit = effectiveLimit(row.hourlyLimit);
    const now = Date.now();
    const r = await reserveSendSlot({
      senderId: row.senderId, limit, gapMs: effectiveGap(row.delayMs), earliest: now + STARTUP_MARGIN_MS, now,
    });
    const data: EmailJobData = { emailId: row.id, reservation: { slotAt: r.slotAt, window: r.window } };
    try {
      if (state === 'delayed') {
        await job.updateData(data);
        await job.changeDelay(Math.max(0, r.slotAt - Date.now()));
      } else {
        // A waiting job can't be delayed in place: replace it (same id) with one due at the slot.
        await job.remove();
        const next = emailJob(row.id, new Date(r.slotAt));
        await emailQueue.add(next.name, data, next.opts);
      }
    } catch (err) {
      logger.warn({ err, emailId: row.id }, 'could not assign the overdue slot; the email reserves one when it runs');
      continue;
    }
    ordered++;
    await maybeNotifyLimit(row.userId, row.senderId, limit, r, now, logger);

    if (r.slotAt > now) {
      // Same record the worker writes when it moves an email: the dashboard shows the real time.
      const reason = r.window > windowOf(now) ? 'rate limit' : 'min gap';
      await db.update(emails).set({ scheduledAt: new Date(r.slotAt) })
        .where(and(eq(emails.id, row.id), eq(emails.status, 'SCHEDULED')));
      await db.insert(emailEvents).values({
        emailId: row.id, type: 'DEFERRED',
        detail: { until: new Date(r.slotAt).toISOString(), reason, window: r.window, ...(reason === 'rate limit' ? { limit } : {}), by: 'reconcile' },
      });
      moved.push(row.id);
    }
  }
  if (moved.length) await enqueueIndex(moved).catch((err) => logger.warn({ err }, 'index enqueue failed'));
  if (ordered) logger.info({ ordered, moved: moved.length }, 'overdue emails given their slots in planned order');
  return ordered;
}

async function resetToScheduled(ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const rows = await db
    .update(emails)
    .set({ status: 'SCHEDULED' })
    .where(and(inArray(emails.id, ids), eq(emails.status, 'PROCESSING')))
    .returning({ id: emails.id });
  const reset = rows.map((r) => r.id);
  if (reset.length) {
    await db.insert(emailEvents).values(reset.map((id) => ({
      emailId: id, type: 'RECOVERED', detail: { from: 'PROCESSING', by: 'reconcile' },
    })));
    await enqueueIndex(reset).catch((err) => logger.warn({ err }, 'index enqueue failed'));
  }
  return reset;
}

async function markUncertain(ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const reason = 'Worker stopped during SMTP delivery; may or may not have been sent. Not retried automatically.';
  const rows = await db
    .update(emails)
    .set({ status: 'UNCERTAIN', lastError: reason })
    .where(and(inArray(emails.id, ids), eq(emails.status, 'SENDING')))
    .returning({ id: emails.id });
  const marked = rows.map((r) => r.id);
  if (marked.length) {
    await db.insert(emailEvents).values(marked.map((id) => ({ emailId: id, type: 'UNCERTAIN', detail: { reason, by: 'reconcile' } })));
    await enqueueIndex(marked).catch((err) => logger.warn({ err }, 'index enqueue failed'));
    logger.warn({ count: marked.length }, 'emails interrupted mid-send marked UNCERTAIN');
  }
  return marked.length;
}
