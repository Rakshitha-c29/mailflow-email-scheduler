/**
 * The "last check" campaign case: a slot counted in the last moment of one window, but the
 * job woke a little late and SMTP would start just after the boundary, i.e. inside the next
 * window, which already has its full limit. That would be one send too many for that window.
 *
 * The send-start gate must refuse it; the email is counted in the next free window instead,
 * its history says so, and the minimum gap still holds against the other emails there.
 */
import './helpers/shortWindowEnv'; // must be the first import
import { after, before, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { SMTPServer } from 'smtp-server';
import { Queue, Worker } from 'bullmq';
import { asc, eq, like } from 'drizzle-orm';
import { db, pool } from '../src/lib/db';
import { createRedisConnection, redis } from '../src/lib/redis';
import { encrypt } from '../src/lib/crypto';
import { env } from '../src/config/env';
import { campaigns, emailEvents, emails, senders, users } from '../src/db/schema';
import { closeQueues, emailJob } from '../src/queues';
import { runMigrations } from '../src/db/migrate';
import { acquireSendStart, reserveSendSlot, windowOf } from '../src/scheduler/rateLimiter';
import { processEmailJob } from '../src/workers/email.processor';
import { closeTransports } from '../src/modules/senders/sender.service';

const RUN = randomUUID().slice(0, 8);
const DOMAIN = `boundary-${RUN}.local`;
const W = env.RATE_WINDOW_MS;
const LIMIT = 3;
const GAP = 500;
const LATE_MS = 400; // how late the job "woke": its clock is this far behind the real one

const smtp = new SMTPServer({
  authOptional: true, allowInsecureAuth: true, disabledCommands: ['STARTTLS'], logger: false,
  onAuth: (_a, _s, cb) => cb(null, { user: 'test' }),
  onData: (stream, _session, cb) => { stream.on('data', () => undefined); stream.on('end', () => cb()); },
});

let userId: string;
let senderId: string;
let campaignId: string;
let queue: Queue;
let worker: Worker;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const row = async (id: string) => (await db.query.emails.findFirst({ where: eq(emails.id, id) }))!;
const eventsOf = (id: string) => db.select().from(emailEvents).where(eq(emailEvents.emailId, id)).orderBy(asc(emailEvents.id));
async function until<T>(what: string, fn: () => Promise<T | undefined>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}
async function addEmail(to: string, scheduledAt: number) {
  const [e] = await db.insert(emails).values({
    campaignId, userId, senderId, toEmail: `${to}@example.com`, subject: 'last check', status: 'SCHEDULED', scheduledAt: new Date(scheduledAt),
  }).returning();
  return e;
}

before(async () => {
  await runMigrations();
  await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', r));
  const [u] = await db.insert(users).values({ googleId: `g-${RUN}`, email: `owner@${DOMAIN}`, name: 'Owner' }).returning();
  userId = u.id;
  const [s] = await db.insert(senders).values({
    userId, name: 'Boundary', email: `sender@${DOMAIN}`, smtpHost: '127.0.0.1', smtpPort: (smtp.server.address() as AddressInfo).port,
    smtpUser: 'u', smtpPassEnc: encrypt('p'),
  }).returning();
  senderId = s.id;
  const [c] = await db.insert(campaigns).values({
    userId, senderId, subject: 'last check', body: 'hello', startAt: new Date(), delayMs: GAP, hourlyLimit: LIMIT, totalCount: 5,
  }).returning();
  campaignId = c.id;
  queue = new Queue(`email-send-boundary-${RUN}`, { connection: createRedisConnection('boundary-q') });
  worker = new Worker(queue.name, processEmailJob, { connection: createRedisConnection('boundary-w'), concurrency: 4 });
});

after(async () => {
  mock.restoreAll();
  await worker.close();
  await queue.obliterate({ force: true }).catch(() => undefined);
  await queue.close();
  closeTransports();
  await db.delete(users).where(like(users.email, `%@${DOMAIN}`));
  await new Promise<void>((r) => smtp.close(() => r()));
  await closeQueues();
  await Promise.allSettled([redis.quit(), pool.end()]);
});

test('gate: refuses a start once the slot\'s window has ended', async () => {
  const s = randomUUID();
  const now = Date.now();
  const r = await acquireSendStart(s, GAP, windowOf(now) - 1);
  assert.ok('windowEndedAt' in r, 'previous window → refused');
  const ok = await acquireSendStart(s, GAP, windowOf(Date.now()));
  assert.ok('startedAt' in ok, 'current window → allowed');
  await redis.del(`rl:{${s}}:lastStart`);
});

test('a slot at the end of one window that would start in the next (already full) window is moved, not sent', async () => {
  // Start just after a boundary: window N has just begun.
  await sleep(W - (Date.now() % W) + 20);
  const n = windowOf(Date.now());

  // bob, cara and dan fill window N (limit 3), like the real campaign.
  for (let i = 0; i < LIMIT; i++) await reserveSendSlot({ senderId, limit: LIMIT, gapMs: GAP, earliest: n * W });

  // ann's slot was counted in window N-1 (its last moment), and her job wakes LATE_MS late:
  // the worker's clock still says N-1, but SMTP would really start in window N.
  const realNow = Date.now.bind(Date);
  mock.method(Date, 'now', () => realNow() - LATE_MS);
  const slotAt = Date.now() - 5; // already due by the worker's clock, as when ann woke up
  assert.equal(windowOf(Date.now()), n - 1, 'the worker believes it is still in window N-1');
  assert.equal(windowOf(slotAt), n - 1, 'ann\'s slot was counted in window N-1');
  const ann = await addEmail('ann', slotAt);
  const job = emailJob(ann.id, ann.scheduledAt);
  await queue.add(job.name, { ...job.data, reservation: { slotAt, window: n - 1 } }, { ...job.opts, delay: 0 });

  const moved = await until('ann to be moved', async () =>
    (await eventsOf(ann.id)).find((e) => e.type === 'DEFERRED'));
  mock.restoreAll();
  assert.equal((await eventsOf(ann.id)).filter((e) => e.type === 'DEFERRED').length, 1, 'moved once, straight away');

  const detail = moved.detail as Record<string, unknown>;
  assert.equal(detail.reason, 'window ended', 'history says why it moved');
  assert.equal(detail.previousWindow, n - 1);
  assert.equal(detail.limit, LIMIT);
  const movedTo = new Date(String(detail.until)).getTime();
  assert.equal(windowOf(movedTo), n + 1, 'window N is full, so ann moves to window N+1');
  assert.equal((await row(ann.id)).sendStartedAt, null, 'nothing was sent in window N');

  // eve is due at the same moment in window N+1: the gap must still hold between the two.
  const eve = await addEmail('eve', (n + 1) * W);
  const ej = emailJob(eve.id, eve.scheduledAt);
  await queue.add(ej.name, ej.data, ej.opts);

  const [a, e] = await until('both sent', async () => {
    const rows = [await row(ann.id), await row(eve.id)];
    return rows.every((r) => r.status === 'SENT') ? rows : undefined;
  }, 20_000);
  const annStart = a.sendStartedAt!.getTime();
  const eveStart = e.sendStartedAt!.getTime();
  assert.equal(windowOf(annStart), n + 1, 'ann actually STARTED in window N+1, not N');
  assert.ok(Math.abs(annStart - eveStart) >= GAP, `minimum gap held after the move (${Math.abs(annStart - eveStart)} ms ≥ ${GAP})`);
  assert.ok(a.sentAt!.getTime() >= annStart, 'sent (accepted) is at or after the start');
});
