/**
 * Provider throttling, end to end through the real email processor against a local SMTP
 * server that answers with scripted replies (421 twice then OK, always 421, 550, ...).
 * Runs on its own queue so a running dev worker never picks these jobs up.
 */
import './helpers/throttleEnv'; // short cooldowns: must be the first import
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { SMTPServer, type SMTPServerAddress, type SMTPServerSession } from 'smtp-server';
import { Queue, Worker } from 'bullmq';
import { asc, eq } from 'drizzle-orm';
import { db, pool } from '../src/lib/db';
import { createRedisConnection, redis } from '../src/lib/redis';
import { encrypt } from '../src/lib/crypto';
import { campaigns, emailEvents, emails, senders, users } from '../src/db/schema';
import { allQueues } from '../src/queues';
import { runMigrations } from '../src/db/migrate';
import { processEmailJob } from '../src/workers/email.processor';
import { closeTransports } from '../src/modules/senders/sender.service';
import { resetSenderCooldownLevel, senderCooldownUntil, startSenderCooldown } from '../src/scheduler/rateLimiter';

const RUN = randomUUID().slice(0, 8);
const DOMAIN = `throttle-${RUN}.local`;


// ── Scripted SMTP server ──────────────────────────────────────────────────────
/** Per-recipient behaviour, by local part: "t2" = 421 twice then OK, "t429" = 429 once, "always" = 421, "perm" = 550. */
const rejections = new Map<string, number>();
const delivered: { to: string; at: number }[] = [];
function reply(address: string): { code: number; message: string } | null {
  const local = address.split('@')[0].split('.')[0];
  const seen = (rejections.get(address) ?? 0) + 1;
  rejections.set(address, seen);
  if (local === 'perm') return { code: 550, message: 'Mailbox unavailable' };
  if (local === 'always') return { code: 421, message: 'Too many messages, slow down' };
  if (local === 't2' && seen <= 2) return { code: 421, message: 'Too many messages, slow down' };
  if (local === 't429' && seen <= 1) return { code: 429, message: 'Rate limited' };
  return null;
}
const smtp = new SMTPServer({
  authOptional: true,
  allowInsecureAuth: true,
  disabledCommands: ['STARTTLS'],
  logger: false,
  onAuth: (_auth, _session, cb) => cb(null, { user: 'test' }),
  onRcptTo: (address: SMTPServerAddress, _s: SMTPServerSession, cb: (err?: Error | null) => void) => {
    const r = reply(address.address);
    if (!r) return cb();
    cb(Object.assign(new Error(r.message), { responseCode: r.code }));
  },
  onData: (stream, session, cb) => {
    stream.on('data', () => undefined);
    stream.on('end', () => {
      for (const rcpt of session.envelope.rcptTo) delivered.push({ to: rcpt.address, at: Date.now() });
      cb();
    });
  },
});

let port = 0;
let queue: Queue;
let worker: Worker;
let userId: string;

async function makeSender() {
  const [s] = await db.insert(senders).values({
    userId, name: 'Throttle test', email: `sender-${randomUUID().slice(0, 6)}@${DOMAIN}`,
    smtpHost: '127.0.0.1', smtpPort: port, smtpSecure: false, smtpUser: 'u', smtpPassEnc: encrypt('p'),
  }).returning();
  const [c] = await db.insert(campaigns).values({
    userId, senderId: s.id, subject: 'Throttle test', body: 'hello', startAt: new Date(), delayMs: 0, hourlyLimit: 1000, totalCount: 1,
  }).returning();
  return { sender: s, campaign: c };
}

async function send(senderId: string, campaignId: string, local: string) {
  const [e] = await db.insert(emails).values({
    campaignId, userId, senderId, toEmail: `${local}.${randomUUID().slice(0, 6)}@example.com`, subject: 'Throttle test',
    scheduledAt: new Date(),
  }).returning();
  await queue.add('send', { emailId: e.id }, { jobId: e.id, attempts: 3, backoff: { type: 'fixed', delay: 200 } });
  return e;
}

async function until<T>(what: string, fn: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

const finalRow = (id: string) => until(`email ${id} to finish`, async () => {
  const row = await db.query.emails.findFirst({ where: eq(emails.id, id) });
  return row && ['SENT', 'FAILED', 'UNCERTAIN'].includes(row.status) ? row : undefined;
});

const events = (id: string) => db.select().from(emailEvents)
  .where(eq(emailEvents.emailId, id)).orderBy(asc(emailEvents.id));

before(async () => {
  await runMigrations();
  await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', r));
  port = (smtp.server.address() as AddressInfo).port;
  const [u] = await db.insert(users).values({ googleId: `g-${RUN}`, email: `owner@${DOMAIN}`, name: 'Owner' }).returning();
  userId = u.id;
  const name = `email-send-test-${RUN}`;
  queue = new Queue(name, { connection: createRedisConnection('throttle-test-q') });
  worker = new Worker(name, processEmailJob, { connection: createRedisConnection('throttle-test-w'), concurrency: 4 });
});

after(async () => {
  await worker?.close();
  await queue?.obliterate({ force: true }).catch(() => undefined);
  await queue?.close();
  closeTransports();
  await db.delete(users).where(eq(users.id, userId));
  await new Promise<void>((r) => smtp.close(() => r()));
  await Promise.allSettled(allQueues.map((q) => q.close()));
  await Promise.allSettled([redis.quit(), pool.end()]);
});

describe('sender cooldown (Redis)', () => {
  test('starts at base, doubles on repeats up to max; concurrent throttles do not compound; success resets', async () => {
    const id = `cooldown-${randomUUID()}`;
    const starts = await Promise.all(Array.from({ length: 5 }, () => startSenderCooldown(id)));
    assert.equal(new Set(starts.map((s) => s.until)).size, 1, 'five simultaneous throttles share one cooldown');
    assert.equal(starts[0].seconds, 1);
    assert.ok(await senderCooldownUntil(id), 'cooldown is active');

    const lengths = [1];
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, lengths[lengths.length - 1] * 1000 + 50));
      lengths.push((await startSenderCooldown(id)).seconds);
    }
    assert.deepEqual(lengths, [1, 2, 4, 4], 'doubles, capped at THROTTLE_COOLDOWN_MAX_S');

    await new Promise((r) => setTimeout(r, 4050));
    await resetSenderCooldownLevel(id);
    assert.equal((await startSenderCooldown(id)).seconds, 1, 'a successful send resets the backoff');
    await redis.del(`rl:{${id}}:cooldown`, `rl:{${id}}:cooldownLevel`);
  });
});

describe('processing with a throttling provider', () => {
  test('4xx defers after the cooldown without counting as a failed attempt, then sends', async () => {
    const { sender, campaign } = await makeSender();
    const t0 = Date.now();
    const e = await send(sender.id, campaign.id, 't2'); // 421, 421, then accepted
    const row = await finalRow(e.id);

    assert.equal(row.status, 'SENT');
    assert.equal(row.attempts, 1, 'only the successful SMTP attempt is counted');
    // BullMQ counts the final successful run in attemptsMade; throttles (moveToDelayed) add nothing.
    // The row is SENT slightly before the job is marked completed, so wait for the job itself.
    const job = await until('job to complete', async () => {
      const j = await queue.getJob(e.id);
      return j?.finishedOn ? j : undefined;
    });
    assert.equal(job?.attemptsMade, 1, 'BullMQ counted only the successful run');
    assert.equal(job?.failedReason, undefined, 'BullMQ recorded no failure');
    assert.deepEqual(job?.stacktrace ?? [], []);
    const throttles = (await events(e.id)).filter((ev) => ev.type === 'THROTTLED').map((ev) => ev.detail as any);
    assert.deepEqual(throttles.map((d) => [d.code, d.cooldownSeconds, d.deferral]), [[421, 1, 1], [421, 2, 2]], 'logged, cooldown doubled');
    assert.ok(Date.now() - t0 >= 3000, 'waited out 1s + 2s of cooldown');
  });

  test("a cooldown pauses the sender's other emails too", async () => {
    const { sender, campaign } = await makeSender();
    const first = await send(sender.id, campaign.id, 't429'); // Ethereal-style 429 once
    const throttle = await until('first throttle', async () =>
      (await events(first.id)).find((ev) => ev.type === 'THROTTLED'));
    const cooldownEnd = new Date(String((throttle.detail as any).until)).getTime();

    const second = await send(sender.id, campaign.id, 'ok'); // accepted immediately by the server...
    await finalRow(second.id);
    const at = delivered.find((d) => d.to === (second as any).toEmail)?.at ?? 0;
    assert.ok(at >= cooldownEnd - 50, `...but only sent after the sender's cooldown (${at - cooldownEnd} ms after)`);
    const waited = (await events(second.id)).find((ev) => ev.type === 'DEFERRED');
    assert.equal((waited?.detail as any)?.reason, 'sender cooldown');
    assert.equal((await finalRow(first.id)).status, 'SENT');
  });

  test('permanent 5xx still fails immediately', async () => {
    const { sender, campaign } = await makeSender();
    const e = await send(sender.id, campaign.id, 'perm');
    const row = await finalRow(e.id);
    assert.equal(row.status, 'FAILED');
    assert.match(row.lastError ?? '', /Mailbox unavailable/);
    assert.equal((await events(e.id)).filter((ev) => ev.type === 'THROTTLED').length, 0);
    assert.equal(await senderCooldownUntil(sender.id), null, 'no cooldown for a permanent error');
  });

  test('deferrals are capped: after THROTTLE_MAX_DEFERRALS it fails with a clear reason', async () => {
    const { sender, campaign } = await makeSender();
    const e = await send(sender.id, campaign.id, 'always');
    const row = await finalRow(e.id);
    assert.equal(row.status, 'FAILED');
    assert.match(row.lastError ?? '', /^Provider kept rate-limiting this sender \(2 deferrals\); last reply: .*421/);
    // The row turns FAILED a moment before its FAILED history entry is written: wait for it.
    const types = await until('the FAILED event', async () => {
      const t = (await events(e.id)).map((ev) => ev.type);
      return t.at(-1) === 'FAILED' ? t : undefined;
    }, 5_000);
    assert.equal(types.filter((t) => t === 'THROTTLED').length, 2);
    assert.equal(types.at(-1), 'FAILED');
    assert.equal(row.attempts, 1, 'throttled tries were not counted as attempts');
  });
});
