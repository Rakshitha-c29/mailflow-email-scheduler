import { nodemailer } from '../lib/nodemailer';
import { DelayedError, UnrecoverableError, type Job } from 'bullmq';
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { env } from '../config/env';
import { db } from '../lib/db';
import { logger } from '../lib/logger';
import { campaigns, emailEvents, emails, type Email, type EmailStatus } from '../db/schema';
import { enqueueIndex, notifyQueue, type EmailJobData, type Reservation } from '../queues';
import {
  acquireSendStart, claimLimitNotification, effectiveGap, effectiveLimit, reserveSendSlot, windowOf,
  resetSenderCooldownLevel, senderCooldownUntil, startSenderCooldown, type SlotReservation,
} from '../scheduler/rateLimiter';
import { getSender, getTransport } from '../modules/senders/sender.service';
import { loadCampaignAttachments } from '../modules/attachments/attachment.service';

/**
 * How late a woken job may be and still use the slot it reserved before sleeping.
 * Later than this, sending "now" could crowd the emails whose slots come right after
 * it (min-gap violation), so it reserves a fresh slot instead. The old slot stays
 * counted: over-counting only ever makes the limiter stricter, never looser.
 */
const RESERVATION_GRACE_MS = 60_000;

/** Where in the pipeline an error happened decides whether a retry is safe. */
type Phase = 'prepare' | 'smtp' | 'sent';

/**
 * One job = one email. Pipeline:
 *
 *   claim ─▶ (sender cooling down? defer) ─▶ reserve slot ─▶ (slot in future? defer & sleep)
 *         ─▶ SENDING ─▶ SMTP ─▶ SENT
 *                         └─ 4xx: throttled ─▶ sender cooldown, defer (not a failed attempt)
 *
 * Postgres is the source of truth for state. Every transition is a conditional UPDATE,
 * so a cancelled, already-sent or deleted email makes the job a no-op, and a job that
 * finds its email in SENDING (a previous run died mid-SMTP) marks it UNCERTAIN instead
 * of risking a duplicate send.
 */
export async function processEmailJob(job: Job<EmailJobData>, token?: string): Promise<void> {
  const { emailId } = job.data;
  const log = logger.child({ emailId, jobId: job.id, attempt: job.attemptsMade + 1 });

  const email = await claim(emailId, log);
  if (!email) return;

  let phase: Phase = 'prepare';
  try {
    const [campaign, sender] = await Promise.all([
      db.query.campaigns.findFirst({
        where: eq(campaigns.id, email.campaignId),
        columns: { body: true, delayMs: true, hourlyLimit: true },
      }),
      getSender(email.senderId),
    ]);
    if (!campaign || !sender) throw new UnrecoverableError('Campaign or sender no longer exists');

    const limit = effectiveLimit(campaign.hourlyLimit);
    const gapMs = effectiveGap(campaign.delayMs);
    const now = Date.now();

    // The provider asked this sender to slow down: wait out the cooldown without using a slot.
    const cooldownUntil = await senderCooldownUntil(sender.id);
    if (cooldownUntil) await defer(job, token, emailId, cooldownUntil, { reason: 'sender cooldown' }, log);

    let reservation = job.data.reservation;
    if (!reservation || !isReusable(reservation, now)) {
      const r = await reserveSendSlot({
        senderId: sender.id, limit, gapMs, earliest: email.scheduledAt.getTime(), now,
      });
      reservation = { slotAt: r.slotAt, window: r.window };
      await maybeNotifyLimit(email.userId, sender.id, limit, r, now, log);
    }

    if (reservation.slotAt > now) {
      // Only a move into a later window is the limit; a wait inside this window is just the gap.
      const reason = reservation.window > windowOf(now) ? 'rate limit' : 'min gap';
      await defer(job, token, emailId, reservation.slotAt, { reservation, reason, limit }, log);
    }

    const [sending] = await db
      .update(emails)
      .set({ status: 'SENDING', attempts: sql`${emails.attempts} + 1` })
      .where(and(eq(emails.id, emailId), eq(emails.status, 'PROCESSING')))
      .returning({ attempts: emails.attempts });
    if (!sending) return; // state moved under us; nothing safe to do
    await reindex(emailId, log);
    const transport = await getTransport(sender);
    // Loaded from Postgres by campaign (cached per worker); job data never holds file contents.
    const files = await loadCampaignAttachments(email.campaignId);

    // Nothing slow between the gate and sendMail: the gate's time IS the send start.
    const gate = await acquireSendStart(sender.id, gapMs, reservation.window);
    if ('windowEndedAt' in gate) {
      // Woke just before its window ended and would start just after: starting now would be
      // one send too many for the new window. SMTP hasn't started, so undoing SENDING is safe.
      // Count it in the current window instead (or a later one if that is full). The old slot
      // stays counted, which only errs on the strict side.
      await db
        .update(emails)
        .set({ status: 'PROCESSING', attempts: sql`${emails.attempts} - 1` })
        .where(and(eq(emails.id, emailId), eq(emails.status, 'SENDING')));
      const r = await reserveSendSlot({ senderId: sender.id, limit, gapMs, earliest: gate.windowEndedAt, now: Date.now() });
      await maybeNotifyLimit(email.userId, sender.id, limit, r, Date.now(), log);
      // Always back through the queue: the next run re-checks the gap and the window at the gate.
      return await defer(job, token, emailId, Math.max(r.slotAt, Date.now()), {
        reservation: { slotAt: r.slotAt, window: r.window }, reason: 'window ended', limit, previousWindow: reservation.window,
      }, log);
    }
    if ('retryInMs' in gate) {
      // Too long to hold a worker slot. SMTP hasn't started, so undoing SENDING is safe.
      await db
        .update(emails)
        .set({ status: 'PROCESSING', attempts: sql`${emails.attempts} - 1` })
        .where(and(eq(emails.id, emailId), eq(emails.status, 'SENDING')));
      // Same window as the counted slot: on wake it's reused if still in that window,
      // otherwise re-reserved (over-counting, i.e. stricter, never looser).
      const until = Date.now() + gate.retryInMs;
      return await defer(job, token, emailId, until, { reservation: { slotAt: until, window: reservation.window }, reason: 'min gap' }, log);
    }
    const smtpStartedAt = gate.startedAt; // recorded so the gap is auditable (see load test)

    phase = 'smtp';
    const smtpT0 = Date.now(); // local clock, for duration only
    const info = await transport.sendMail({
      messageId: `<${emailId}@mailflow.local>`,
      from: { name: sender.name, address: sender.email },
      to: email.toEmail,
      subject: email.subject,
      ...(looksLikeHtml(campaign.body) ? { html: campaign.body } : { text: campaign.body }),
      headers: { 'X-MailFlow-Email-Id': emailId },
      attachments: files.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
    });

    // From here on the email is out. Never let anything below trigger a resend.
    phase = 'sent';
    const previewUrl = nodemailer.getTestMessageUrl(info) || null;
    await withRetry(() => db
      .update(emails)
      .set({ status: 'SENT', sentAt: new Date(), sendStartedAt: new Date(smtpStartedAt), messageId: info.messageId, previewUrl, lastError: null })
      .where(and(eq(emails.id, emailId), eq(emails.status, 'SENDING'))));
    await record(emailId, 'SENT', {
      attempt: sending.attempts, previewUrl,
      slotAt: new Date(reservation.slotAt).toISOString(),
      smtpStartedAt: new Date(smtpStartedAt).toISOString(), smtpMs: Date.now() - smtpT0,
    }, log);
    await resetSenderCooldownLevel(sender.id).catch(() => undefined);
    log.info({ to: email.toEmail, previewUrl }, 'email sent');
  } catch (err) {
    if (err instanceof DelayedError) throw err;
    if (phase === 'sent') {
      // Row stays SENDING, so the retry's claim marks it UNCERTAIN: never a duplicate.
      log.error({ err }, 'email was sent but could not be marked SENT');
      throw err;
    }
    if (phase === 'smtp' && isThrottle(err)) {
      await handleThrottle(job, token, email, err, log); // always throws (Delayed or Unrecoverable)
    }
    await handleFailure(job, emailId, err, log);
    throw err;
  }
}

/**
 * SCHEDULED|PROCESSING → PROCESSING. PROCESSING is claimable because a job that
 * stalled before reaching SMTP is safe to run again. SENDING → UNCERTAIN.
 */
async function claim(emailId: string, log: Logger): Promise<Email | null> {
  const [row] = await db
    .update(emails)
    .set({ status: 'PROCESSING' })
    .where(and(eq(emails.id, emailId), inArray(emails.status, ['SCHEDULED', 'PROCESSING'])))
    .returning();
  if (row) {
    await reindex(emailId, log);
    return row;
  }

  const reason = 'Interrupted during SMTP delivery; may or may not have been sent. Not retried automatically.';
  const [uncertain] = await db
    .update(emails)
    .set({ status: 'UNCERTAIN', lastError: reason })
    .where(and(eq(emails.id, emailId), eq(emails.status, 'SENDING')))
    .returning({ id: emails.id });
  if (uncertain) {
    log.warn('email found mid-send from an earlier run, marked UNCERTAIN');
    await record(emailId, 'UNCERTAIN', { reason }, log);
  } else {
    log.debug('email not claimable (sent, cancelled, failed or deleted), skipping');
  }
  return null;
}

const isReusable = (r: Reservation, now: number) =>
  now <= r.slotAt || (windowOf(now) === r.window && now - r.slotAt <= RESERVATION_GRACE_MS);

/**
 * Not yet: put the row back to SCHEDULED with the real send time (so the dashboard is
 * accurate) and park the job until then. A reserved slot is remembered on the job so
 * waking up doesn't count it twice; without one, the job reserves a fresh slot on wake.
 * Moving to delayed never counts as a BullMQ attempt.
 */
async function defer(
  job: Job<EmailJobData>, token: string | undefined, emailId: string, until: number,
  opts: { reason: string; reservation?: Reservation; limit?: number; previousWindow?: number }, log: Logger,
): Promise<never> {
  await db
    .update(emails)
    .set({ status: 'SCHEDULED', scheduledAt: new Date(until) })
    .where(and(eq(emails.id, emailId), eq(emails.status, 'PROCESSING')));
  await record(emailId, 'DEFERRED', {
    until: new Date(until).toISOString(), reason: opts.reason,
    ...(opts.reservation ? { window: opts.reservation.window } : {}),
    ...((opts.reason === 'rate limit' || opts.reason === 'window ended') && opts.limit ? { limit: opts.limit } : {}),
    ...(opts.previousWindow !== undefined ? { previousWindow: opts.previousWindow } : {}),
  }, log);
  await job.updateData(opts.reservation ? { emailId, reservation: opts.reservation } : { emailId });
  await job.moveToDelayed(until, token);
  log.debug({ until: new Date(until).toISOString(), reason: opts.reason }, 'email deferred');
  throw new DelayedError();
}

/**
 * Provider throttling (temporary 4xx reply): nothing was delivered, and retrying right
 * away would only dig deeper, so the whole sender cools down (60s → doubling → 15 min
 * by default) and this email waits it out. It is NOT a failed attempt: the attempt count
 * is undone and the job is delayed rather than failed. Each email may be deferred at
 * most THROTTLE_MAX_DEFERRALS times (counted from its THROTTLED events, so it survives
 * restarts); after that it fails with a clear reason instead of looping forever.
 */
async function handleThrottle(
  job: Job<EmailJobData>, token: string | undefined, email: Email, err: unknown, log: Logger,
): Promise<never> {
  const code = smtpCode(err);
  const message = errorMessage(err);
  const [{ n: prior }] = await db
    .select({ n: count() })
    .from(emailEvents)
    .where(and(eq(emailEvents.emailId, email.id), eq(emailEvents.type, 'THROTTLED')));

  if (prior >= env.THROTTLE_MAX_DEFERRALS) {
    const reason = `Provider kept rate-limiting this sender (${prior} deferrals); last reply: ${message}`;
    await db
      .update(emails)
      .set({ status: 'FAILED', lastError: reason })
      .where(and(eq(emails.id, email.id), inArray(emails.status, ['SENDING', 'PROCESSING'])));
    await record(email.id, 'FAILED', { error: reason, permanent: true, throttled: true }, log);
    log.warn({ code, deferrals: prior }, 'email failed: throttling deferral cap reached');
    throw new UnrecoverableError(reason);
  }

  const cooldown = await startSenderCooldown(email.senderId);
  await db
    .update(emails)
    .set({
      status: 'SCHEDULED',
      scheduledAt: new Date(cooldown.until),
      attempts: sql`greatest(${emails.attempts} - 1, 0)`, // not a failed attempt
      lastError: `Throttled by the provider (${code}); retrying after a ${cooldown.seconds}s cooldown`,
    })
    .where(and(eq(emails.id, email.id), eq(emails.status, 'SENDING')));
  await record(email.id, 'THROTTLED', {
    code, message, cooldownSeconds: cooldown.seconds, until: new Date(cooldown.until).toISOString(),
    deferral: prior + 1, maxDeferrals: env.THROTTLE_MAX_DEFERRALS,
  }, log);
  await job.updateData({ emailId: email.id }); // the used slot is dropped; a fresh one is reserved on wake
  await job.moveToDelayed(cooldown.until, token);
  log.warn({ code, cooldownSeconds: cooldown.seconds, deferral: prior + 1 }, 'provider throttled sender, cooling down');
  throw new DelayedError();
}

/**
 * One Slack message per (sender, window) when the current hour's limit is reached:
 * either this reservation took the last slot, or the current window was already full.
 * A notification problem must never fail the email.
 */
export async function maybeNotifyLimit(
  userId: string, senderId: string, limit: number, r: SlotReservation, now: number, log: Logger,
): Promise<void> {
  const nowWindow = windowOf(now);
  const hit = (r.window === nowWindow && r.countInWindow >= limit) || r.skippedFullWindow === nowWindow;
  if (!hit) return;
  try {
    if (!(await claimLimitNotification(senderId, nowWindow))) return;
    await notifyQueue.add(
      'rate-limit',
      { kind: 'RATE_LIMIT_HIT', userId, senderId, window: nowWindow, limit },
      { jobId: `rate-limit-${senderId}-${nowWindow}` },
    );
  } catch (err) {
    log.warn({ err }, 'could not enqueue rate-limit notification');
  }
}

/**
 * 5xx SMTP reply or UnrecoverableError → FAILED, no retries.
 * Last attempt → FAILED. Otherwise → SCHEDULED, and BullMQ retries with backoff.
 * Bookkeeping errors here are logged, never allowed to hide the original error.
 */
async function handleFailure(job: Job<EmailJobData>, emailId: string, err: unknown, log: Logger): Promise<void> {
  const message = errorMessage(err);
  const permanent = err instanceof UnrecoverableError || isPermanentSmtpError(err);
  const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
  const active: EmailStatus[] = ['SCHEDULED', 'PROCESSING', 'SENDING'];

  try {
    if (permanent || lastAttempt) {
      await db
        .update(emails)
        .set({ status: 'FAILED', lastError: message })
        .where(and(eq(emails.id, emailId), inArray(emails.status, active)));
      await record(emailId, 'FAILED', { error: message, permanent }, log);
      log.warn({ err, permanent }, 'email failed');
      // Make BullMQ skip remaining attempts too (the row is already FAILED).
      if (permanent && !(err instanceof UnrecoverableError)) throw new UnrecoverableError(message);
      return;
    }

    const retryAt = new Date(Date.now() + env.EMAIL_JOB_BACKOFF_MS * 2 ** job.attemptsMade);
    await db
      .update(emails)
      .set({ status: 'SCHEDULED', scheduledAt: retryAt, lastError: message })
      .where(and(eq(emails.id, emailId), inArray(emails.status, active)));
    // Drop the used slot: the retry reserves a fresh one, so it respects the min gap.
    await job.updateData({ emailId });
    await record(emailId, 'RETRY_SCHEDULED', { error: message, retryAt: retryAt.toISOString() }, log);
    log.warn({ err, retryAt }, 'email send failed, will retry');
  } catch (bookkeepingErr) {
    if (bookkeepingErr instanceof UnrecoverableError) throw bookkeepingErr;
    log.error({ err: bookkeepingErr, original: message }, 'could not record email failure');
  }
}

/** Audit event + search reindex. Best effort: history must never break delivery. */
async function record(emailId: string, type: string, detail: Record<string, unknown>, log: Logger): Promise<void> {
  await Promise.all([
    db.insert(emailEvents).values({ emailId, type, detail })
      .catch((err) => log.warn({ err, type }, 'could not write email event')),
    reindex(emailId, log),
  ]);
}

const reindex = (emailId: string, log: Logger) =>
  enqueueIndex([emailId]).catch((err) => log.warn({ err }, 'index enqueue failed'));

async function withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= tries) throw err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** (i - 1)));
    }
  }
}

/**
 * SMTP reply code of a failed send. Nodemailer sets it on the error, including for
 * "all recipients were rejected" (taken from the RCPT reply); fall back to the first
 * per-recipient rejection just in case.
 */
function smtpCode(err: unknown): number | null {
  const e = err as { responseCode?: unknown; rejectedErrors?: { responseCode?: unknown }[] } | undefined;
  const code = e?.responseCode ?? e?.rejectedErrors?.[0]?.responseCode;
  return typeof code === 'number' ? code : null;
}

function isPermanentSmtpError(err: unknown): boolean {
  const code = smtpCode(err);
  return code !== null && code >= 500 && code < 600;
}

/** Temporary rejection (421, 450, 451, 452, 454, Ethereal's 429, …) = the provider throttling us. */
function isThrottle(err: unknown): boolean {
  const code = smtpCode(err);
  return code !== null && code >= 400 && code < 500;
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 1000);

const looksLikeHtml = (body: string) => /<\/?[a-z][\s\S]*>/i.test(body);
