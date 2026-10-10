/**
 * What the user sees when a sender hits its limit:
 *   - the Slack alert's "waiting" count is only the emails pushed past the current window;
 *   - an email's History says *when* the limit moved it (at scheduling time if the planner
 *     did it, at send time if the worker did) and doesn't call a delay-gap wait a "rate limit".
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { SMTPServer } from 'smtp-server';
import { Queue, Worker } from 'bullmq';
import { asc, eq, inArray, like } from 'drizzle-orm';
import { db, pool } from '../src/lib/db';
import { createRedisConnection, redis } from '../src/lib/redis';
import { encrypt } from '../src/lib/crypto';
import { env } from '../src/config/env';
import { campaigns, emailEvents, emails, senders, users, type EmailStatus } from '../src/db/schema';
import { closeQueues, emailJob, emailQueue } from '../src/queues';
import { runMigrations } from '../src/db/migrate';
import { scheduleCampaign } from '../src/modules/emails/email.service';
import { processEmailJob } from '../src/workers/email.processor';
import { countWaitingForLaterWindow } from '../src/workers/notification.processor';
import { closeTransports } from '../src/modules/senders/sender.service';

const RUN = randomUUID().slice(0, 8);
const DOMAIN = `limits-${RUN}.local`;
const W = env.RATE_WINDOW_MS;
const MONTH = 30 * 86_400_000;

const smtp = new SMTPServer({
  authOptional: true, allowInsecureAuth: true, disabledCommands: ['STARTTLS'], logger: false,
  onAuth: (_a, _s, cb) => cb(null, { user: 'test' }),
  onData: (stream, _session, cb) => { stream.on('data', () => undefined); stream.on('end', () => cb()); },
});

let userId: string;
let testQueue: Queue;
let worker: Worker;
const realQueueJobs: string[] = [];

async function makeSender(tag: string) {
  const [s] = await db.insert(senders).values({
    userId, name: tag, email: `${tag}@${DOMAIN}`, smtpHost: '127.0.0.1', smtpPort: (smtp.server.address() as AddressInfo).port,
    smtpUser: 'u', smtpPassEnc: encrypt('p'),
  }).returning();
  return s.id;
}

async function makeCampaign(senderId: string, startAt: number, opts: { delayMs?: number; hourlyLimit?: number } = {}) {
  const [c] = await db.insert(campaigns).values({
    userId, senderId, subject: 'Limit test', body: 'hello', startAt: new Date(startAt),
    delayMs: opts.delayMs ?? 0, hourlyLimit: opts.hourlyLimit ?? 1000, totalCount: 1,
  }).returning();
  return c.id;
}

async function addEmail(campaignId: string, senderId: string, status: EmailStatus, scheduledAt: number) {
  const [e] = await db.insert(emails).values({
    campaignId, userId, senderId, toEmail: `lead-${randomUUID().slice(0, 8)}@example.com`, subject: 'Limit test', status,
    scheduledAt: new Date(scheduledAt),
  }).returning();
  return e;
}

const eventsOf = (id: string) => db.select().from(emailEvents).where(eq(emailEvents.emailId, id)).orderBy(asc(emailEvents.id));

async function until<T>(what: string, fn: () => Promise<T | undefined>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

before(async () => {
  await runMigrations();
  await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', r));
  const [u] = await db.insert(users).values({ googleId: `g-${RUN}`, email: `owner@${DOMAIN}`, name: 'Owner' }).returning();
  userId = u.id;
  testQueue = new Queue(`email-send-limits-${RUN}`, { connection: createRedisConnection('limits-q') });
  worker = new Worker(testQueue.name, processEmailJob, { connection: createRedisConnection('limits-w'), concurrency: 4 });
});

after(async () => {
  await worker.close();
  await testQueue.obliterate({ force: true }).catch(() => undefined);
  await testQueue.close();
  await Promise.allSettled(realQueueJobs.map((id) => emailQueue.remove(id)));
  closeTransports();
  await db.delete(users).where(like(users.email, `%@${DOMAIN}`));
  await new Promise<void>((r) => smtp.close(() => r()));
  await closeQueues();
  await Promise.allSettled([redis.quit(), pool.end()]);
});

describe('Slack alert: "waiting for a later window" count', () => {
  test('5 emails with a limit of 3 → 2 waiting (not the ones still going out in this window)', async () => {
    const sender = await makeSender('count');
    const windowStart = (Math.floor(Date.now() / W) + 10) * W; // a window of our own
    const windowEnd = windowStart + W;
    const c = await makeCampaign(sender, windowStart + 1000, { delayMs: 1000, hourlyLimit: 3 });
    // The moment the alert fires: #1 sent, #2 being sent, #3 (hit the limit) spaced by the delay;
    // #4 and #5 were pushed into the next window.
    await addEmail(c, sender, 'SENT', windowStart + 1000);
    await addEmail(c, sender, 'PROCESSING', windowStart + 2000);
    await addEmail(c, sender, 'SCHEDULED', windowStart + 3000);
    await addEmail(c, sender, 'SCHEDULED', windowEnd);
    await addEmail(c, sender, 'SCHEDULED', windowEnd + 1000);
    // Not waiting because of the limit: a campaign that simply starts later.
    const later = await makeCampaign(sender, windowEnd + 5 * W);
    await addEmail(later, sender, 'SCHEDULED', windowEnd + 5 * W);
    // Another sender's emails don't count either.
    const other = await makeSender('other');
    await addEmail(await makeCampaign(other, windowStart), other, 'SCHEDULED', windowEnd);

    assert.equal(await countWaitingForLaterWindow(sender, windowEnd), 2);
  });
});

describe('History: when and why an email was moved', () => {
  test('the planner pushing emails past the limit is recorded at scheduling time', async () => {
    const sender = await makeSender('planner');
    const startAt = (Math.floor((Date.now() + MONTH) / W)) * W + 1000; // well inside one window
    const t0 = Date.now();
    const { campaign } = await scheduleCampaign(userId, {
      subject: 'Planner', body: 'hi', startAt: new Date(startAt).toISOString(), delayMs: 1000, hourlyLimit: 3, senderId: sender,
      recipients: ['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com', 'e@example.com'],
    } as any);
    const rows = await db.select().from(emails).where(eq(emails.campaignId, campaign.id)).orderBy(asc(emails.scheduledAt));
    realQueueJobs.push(...rows.map((r) => r.id));
    assert.equal(rows.length, 5);

    for (const r of rows.slice(0, 3)) assert.deepEqual(await eventsOf(r.id), [], 'fits in the window: no event');
    for (const r of rows.slice(3)) {
      const [ev] = await eventsOf(r.id);
      assert.equal(ev?.type, 'DEFERRED');
      assert.deepEqual(
        { reason: (ev.detail as any).reason, planned: (ev.detail as any).planned, limit: (ev.detail as any).limit },
        { reason: 'rate limit', planned: true, limit: 3 },
      );
      assert.equal(new Date(String((ev.detail as any).until)).getTime(), r.scheduledAt.getTime(), '"moved to" = its new time');
      assert.ok(r.scheduledAt.getTime() >= Math.floor(startAt / W) * W + W, 'moved into a later window');
      assert.ok(ev.createdAt.getTime() >= t0 - 1000 && ev.createdAt.getTime() <= Date.now() + 1000,
        'timestamped when the limit was hit (scheduling), not when it will send');
    }
  });

  test('the worker labels a delay-gap wait "min gap" and a move to the next window "rate limit", timestamped when it happened', async () => {
    // Keep all three reservations inside the current window.
    const left = W - (Date.now() % W);
    if (left < 6000) await new Promise((r) => setTimeout(r, left + 200));

    const sender = await makeSender('worker');
    const c = await makeCampaign(sender, Date.now(), { delayMs: 1500, hourlyLimit: 2 });
    const now = Date.now();
    const list = [await addEmail(c, sender, 'SCHEDULED', now), await addEmail(c, sender, 'SCHEDULED', now), await addEmail(c, sender, 'SCHEDULED', now)];
    const t0 = Date.now();
    for (const e of list) {
      const j = emailJob(e.id, e.scheduledAt);
      await testQueue.add(j.name, j.data, j.opts);
    }

    // Two fit in this window (one waits the 1.5 s gap); the third is moved to the next window.
    const deferrals = await until('three outcomes', async () => {
      const evs = await db.select().from(emailEvents).where(inArray(emailEvents.emailId, list.map((e) => e.id)));
      const moved = evs.filter((e) => e.type === 'DEFERRED');
      const sent = evs.filter((e) => e.type === 'SENT');
      return sent.length === 2 && moved.length >= 2 ? moved : undefined;
    });
    const gap = deferrals.filter((e) => (e.detail as any).reason === 'min gap');
    const limit = deferrals.filter((e) => (e.detail as any).reason === 'rate limit');
    assert.equal(gap.length, 1, 'the gap wait is not called a rate limit');
    assert.equal(limit.length, 1, 'exactly one email moved by the limit');
    assert.equal((limit[0].detail as any).limit, 2);

    const movedTo = new Date(String((limit[0].detail as any).until)).getTime();
    assert.ok(movedTo >= (Math.floor(t0 / W) + 1) * W, 'moved to the next window');
    assert.ok(limit[0].createdAt.getTime() < t0 + 5000, 'recorded when the limit was hit');
    assert.ok(limit[0].createdAt.getTime() < movedTo, '...which is before the time it was moved to');
  });
});
