/**
 * Restart test B: the worker was off past the send time. On restart, overdue emails must go
 * out in their original (planned) order, still within the limit and the gap, each once.
 * Without startup slot allocation they race for slots and the order is random.
 */
import './helpers/shortWindowEnv'; // must be the first import: 2-second rate windows
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { SMTPServer } from 'smtp-server';
import { Worker } from 'bullmq';
import { asc, eq, inArray, like } from 'drizzle-orm';
import { db, pool } from '../src/lib/db';
import { createRedisConnection, redis } from '../src/lib/redis';
import { encrypt } from '../src/lib/crypto';
import { env } from '../src/config/env';
import { campaigns, emailEvents, emails, senders, users } from '../src/db/schema';
import { closeQueues, emailJob, emailQueue } from '../src/queues';
import { runMigrations } from '../src/db/migrate';
import { planSendTimes } from '../src/scheduler/planner';
import { effectiveGap, startSenderCooldown, windowOf } from '../src/scheduler/rateLimiter';
import { reconcile } from '../src/recovery/reconcile';
import { processEmailJob } from '../src/workers/email.processor';
import { closeTransports } from '../src/modules/senders/sender.service';

const RUN = randomUUID().slice(0, 8);
const DOMAIN = `restart-order-${RUN}.local`;
const W = env.RATE_WINDOW_MS;
const LIMIT = 3;
const DELAY = 300;
const GAP = effectiveGap(DELAY);
const RECIPIENTS = ['ann', 'bob', 'cara', 'dan', 'eve', 'fay', 'gus', 'hal'];

const delivered: string[] = [];
const smtp = new SMTPServer({
  authOptional: true, allowInsecureAuth: true, disabledCommands: ['STARTTLS'], logger: false,
  onAuth: (_a, _s, cb) => cb(null, { user: 'test' }),
  onData: (stream, session, cb) => {
    stream.on('data', () => undefined);
    stream.on('end', () => { for (const r of session.envelope.rcptTo) delivered.push(r.address); cb(); });
  },
});

let userId: string;
let worker: Worker | undefined;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, fn: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

/** Schedules a campaign the way the API does (planned times + one delayed job each), with no worker running. */
async function scheduleWithWorkerOff(tag: string, to: string[]) {
  const [s] = await db.insert(senders).values({
    userId, name: tag, email: `${tag}@${DOMAIN}`, smtpHost: '127.0.0.1', smtpPort: (smtp.server.address() as AddressInfo).port,
    smtpUser: 'u', smtpPassEnc: encrypt('p'),
  }).returning();
  const startAt = Date.now() + 300;
  const [c] = await db.insert(campaigns).values({
    userId, senderId: s.id, subject: `Restart order ${tag}`, body: 'hello', startAt: new Date(startAt),
    delayMs: DELAY, hourlyLimit: LIMIT, totalCount: to.length,
  }).returning();
  const times = planSendTimes({ count: to.length, startAt, gapMs: GAP, limit: LIMIT, windowMs: W });
  const rows = await db.insert(emails).values(to.map((name, i) => ({
    campaignId: c.id, userId, senderId: s.id, toEmail: `${name}.${RUN}@example.com`, subject: c.subject, scheduledAt: new Date(times[i]),
  }))).returning();
  const byName = new Map(rows.map((r) => [r.toEmail.split('.')[0], r]));
  const ordered = to.map((n) => byName.get(n)!);
  await emailQueue.addBulk(ordered.map((r) => emailJob(r.id, r.scheduledAt)));
  return { senderId: s.id, emails: ordered, lastPlanned: times[times.length - 1] };
}

before(async () => {
  await runMigrations();
  await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', r));
  const [u] = await db.insert(users).values({ googleId: `g-${RUN}`, email: `owner@${DOMAIN}`, name: 'Owner' }).returning();
  userId = u.id;
});

after(async () => {
  await worker?.close();
  const mine = await db.select({ id: emails.id }).from(emails).where(eq(emails.userId, userId));
  await Promise.allSettled(mine.map((e) => emailQueue.remove(e.id)));
  closeTransports();
  await db.delete(users).where(like(users.email, `%@${DOMAIN}`));
  await new Promise<void>((r) => smtp.close(() => r()));
  await closeQueues();
  await Promise.allSettled([redis.quit(), pool.end()]);
});

describe('restart after the send time', () => {
  test('overdue emails go out in the original order, within the limit and the gap, once each', async () => {
    const { emails: list, lastPlanned } = await scheduleWithWorkerOff('order', RECIPIENTS);

    // Worker "off" until every planned send time has passed.
    await sleep(Math.max(0, lastPlanned - Date.now()) + 500);
    assert.ok(list.every((e) => e.scheduledAt.getTime() < Date.now()), 'all overdue');

    // Restart at a moment where no handed-out slot lands in the last instant of a window: the
    // first slot (1 s after startup) then falls ~100 ms into a window. (A slot at the very end
    // of a window whose job wakes late is moved to the next free place by the window-ended
    // check; that edge case is covered by windowBoundary.test.ts, not here.)
    await sleep(((W - 900) - (Date.now() % W) + W) % W);

    // Restart exactly like src/worker.ts: build the worker (not running), recover, then start
    // taking jobs, all of them at once.
    worker = new Worker(emailQueue.name, processEmailJob, {
      connection: createRedisConnection('restart-order-w'), concurrency: RECIPIENTS.length, autorun: false,
    });
    const result = await reconcile();
    assert.ok(result.ordered >= RECIPIENTS.length, `slots assigned in order at startup (${result.ordered})`);
    void worker.run();
    try {

      const rows = await until('all sent', async () => {
        const r = await db.select().from(emails).where(inArray(emails.id, list.map((e) => e.id)));
        return r.every((e) => e.status === 'SENT') ? r : undefined;
      });
      const started = new Map(rows.map((r) => [r.id, r.sendStartedAt!.getTime()]));
      const starts = list.map((e) => started.get(e.id)!);

      // Original order.
      const sentOrder = [...list].sort((a, b) => started.get(a.id)! - started.get(b.id)!).map((e) => e.toEmail.split('.')[0]);
      assert.deepEqual(sentOrder, RECIPIENTS, 'sent in the original (planned) order');

      // Limit per window and the gap between starts still hold.
      const perWindow = new Map<number, number>();
      for (const t of starts) perWindow.set(windowOf(t), (perWindow.get(windowOf(t)) ?? 0) + 1);
      assert.ok([...perWindow.values()].every((n) => n <= LIMIT), `at most ${LIMIT} starts per window: ${[...perWindow.values()]}`);
      for (let i = 1; i < starts.length; i++) {
        assert.ok(starts[i] - starts[i - 1] >= GAP, `gap ${starts[i] - starts[i - 1]} ms ≥ ${GAP} between ${RECIPIENTS[i - 1]} and ${RECIPIENTS[i]}`);
      }

      // No duplicates.
      const mine = delivered.filter((a) => a.includes(`.${RUN}@`));
      assert.equal(mine.length, RECIPIENTS.length, 'each delivered exactly once');
      assert.equal(new Set(mine).size, RECIPIENTS.length);

      // Emails moved at startup say so in their history.
      const moves = await db.select().from(emailEvents)
        .where(inArray(emailEvents.emailId, list.map((e) => e.id))).orderBy(asc(emailEvents.id));
      const byReconcile = moves.filter((e) => e.type === 'DEFERRED' && (e.detail as { by?: string }).by === 'reconcile');
      assert.ok(byReconcile.length >= LIMIT, `moves recorded at startup (${byReconcile.length})`);
    } finally {
      await worker.close(); // never leave it running into the next test
      worker = undefined;
    }
  });

  test('a sender in a provider cooldown is left to reserve at run time, as before', async () => {
    const { senderId, emails: list, lastPlanned } = await scheduleWithWorkerOff('cooldown', ['ann', 'bob']);
    await sleep(Math.max(0, lastPlanned - Date.now()) + 300);
    await startSenderCooldown(senderId);

    await reconcile();
    for (const e of list) {
      const job = await emailQueue.getJob(e.id);
      assert.equal(job?.data.reservation, undefined, 'no slot handed out during a cooldown');
    }
    await redis.del(`rl:{${senderId}}:cooldown`, `rl:{${senderId}}:cooldownLevel`);
  });
});
