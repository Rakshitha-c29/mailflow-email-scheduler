/**
 * Persistence and idempotency, the two hard constraints:
 *   - after a restart, future emails are still sent at the right time (boot reconciliation
 *     restores missing jobs with the original send time, keeps existing ones);
 *   - no email is ever sent twice (duplicate jobs, re-runs, crashed sends, retried requests).
 * Sending runs the real email processor against a local SMTP server, on its own queue.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { SMTPServer } from 'smtp-server';
import { Queue, Worker } from 'bullmq';
import { asc, eq, like } from 'drizzle-orm';
import { db, pool } from '../src/lib/db';
import { createRedisConnection, redis } from '../src/lib/redis';
import { encrypt } from '../src/lib/crypto';
import { campaigns, emailEvents, emails, senders, users, type EmailStatus } from '../src/db/schema';
import { closeQueues, emailJob, emailQueue } from '../src/queues';
import { createApp } from '../src/app';
import { runMigrations } from '../src/db/migrate';
import { reconcile } from '../src/recovery/reconcile';
import { processEmailJob } from '../src/workers/email.processor';
import { closeTransports } from '../src/modules/senders/sender.service';
import { SESSION_COOKIE, signSession } from '../src/modules/auth/session';

const RUN = randomUUID().slice(0, 8);
const DOMAIN = `restart-${RUN}.local`;
const MONTH = 30 * 86_400_000;

const delivered: string[] = [];
const smtp = new SMTPServer({
  authOptional: true, allowInsecureAuth: true, disabledCommands: ['STARTTLS'], logger: false,
  onAuth: (_a, _s, cb) => cb(null, { user: 'test' }),
  onData: (stream, session, cb) => {
    stream.on('data', () => undefined);
    stream.on('end', () => { for (const r of session.envelope.rcptTo) delivered.push(r.address); cb(); });
  },
});

let server: Server;
let base: string;
let testQueue: Queue;
let worker: Worker;
let userId: string;
let cookie: string;
let senderId: string;
let campaignId: string;
const realQueueJobs: string[] = [];

async function addEmail(status: EmailStatus, scheduledAt = new Date(Date.now() + MONTH)) {
  const [e] = await db.insert(emails).values({
    campaignId, userId, senderId, toEmail: `lead-${randomUUID().slice(0, 8)}@example.com`, subject: 'Restart test', status, scheduledAt,
  }).returning();
  realQueueJobs.push(e.id);
  return e;
}

const status = async (id: string) => (await db.query.emails.findFirst({ where: eq(emails.id, id) }))!.status;
const events = async (id: string) => (await db.select().from(emailEvents).where(eq(emailEvents.emailId, id)).orderBy(asc(emailEvents.id))).map((e) => e.type);

async function until<T>(what: string, fn: () => Promise<T | undefined>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

before(async () => {
  await runMigrations();
  await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', r));
  const [u] = await db.insert(users).values({ googleId: `g-${RUN}`, email: `owner@${DOMAIN}`, name: 'Owner' }).returning();
  userId = u.id;
  cookie = `${SESSION_COOKIE}=${signSession(u)}`;
  const [s] = await db.insert(senders).values({
    userId, name: 'Sender 1', email: `sender@${DOMAIN}`, smtpHost: '127.0.0.1', smtpPort: (smtp.server.address() as AddressInfo).port,
    smtpUser: 'u', smtpPassEnc: encrypt('p'),
  }).returning();
  senderId = s.id;
  const [c] = await db.insert(campaigns).values({
    userId, senderId, subject: 'Restart test', body: 'hello', startAt: new Date(), delayMs: 0, hourlyLimit: 1000, totalCount: 1,
  }).returning();
  campaignId = c.id;

  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  testQueue = new Queue(`email-send-restart-${RUN}`, { connection: createRedisConnection('restart-q') });
  worker = new Worker(testQueue.name, processEmailJob, { connection: createRedisConnection('restart-w'), concurrency: 4 });
});

after(async () => {
  await worker.close();
  await testQueue.obliterate({ force: true }).catch(() => undefined);
  await testQueue.close();
  await Promise.allSettled(realQueueJobs.map((id) => emailQueue.remove(id)));
  closeTransports();
  await db.delete(users).where(eq(users.id, userId));
  await db.delete(users).where(like(users.email, `%@${DOMAIN}`));
  server.close();
  await new Promise<void>((r) => smtp.close(() => r()));
  await closeQueues();
  await Promise.allSettled([redis.quit(), pool.end()]);
});

describe('restart: boot reconciliation', () => {
  test('a scheduled email whose job was lost gets it back, still due at its original time', async () => {
    const e = await addEmail('SCHEDULED'); // e.g. the API died between commit and enqueue
    assert.equal(await emailQueue.getJob(e.id), undefined);

    const result = await reconcile();
    assert.ok(result.requeued >= 1);
    const job = await emailQueue.getJob(e.id);
    assert.ok(job, 'job restored');
    assert.equal(await job.getState(), 'delayed');
    assert.ok(Math.abs(job.timestamp + job.opts.delay! - e.scheduledAt.getTime()) < 5_000, 'due at the original scheduled time');
    assert.equal(await status(e.id), 'SCHEDULED');
  });

  test('an email that still has its job is left alone (no duplicate, same due time)', async () => {
    const e = await addEmail('SCHEDULED');
    const job = emailJob(e.id, e.scheduledAt);
    await emailQueue.add(job.name, job.data, job.opts);
    const before = await emailQueue.getJob(e.id);

    await reconcile();
    const afterJob = await emailQueue.getJob(e.id);
    assert.equal(afterJob?.timestamp, before?.timestamp, 'same job, not re-added');
    assert.deepEqual(await events(e.id), [], 'nothing recorded');
  });

  test('a worker that died before SMTP (PROCESSING) → back to SCHEDULED with a job', async () => {
    const e = await addEmail('PROCESSING');
    await reconcile();
    assert.equal(await status(e.id), 'SCHEDULED');
    assert.ok(await emailQueue.getJob(e.id), 'job restored');
    assert.deepEqual(await events(e.id), ['RECOVERED']);
  });

  test('a worker that died mid-SMTP (SENDING) → UNCERTAIN, never re-sent', async () => {
    const e = await addEmail('SENDING');
    await reconcile();
    assert.equal(await status(e.id), 'UNCERTAIN');
    assert.equal(await emailQueue.getJob(e.id), undefined, 'no job: it will not be sent again');
  });

  test('only one worker reconciles at a time (Redis lock)', async () => {
    await redis.set('lock:reconcile', 'someone-else', 'PX', 5_000);
    try {
      assert.equal((await reconcile()).skipped, 'locked');
    } finally {
      await redis.del('lock:reconcile');
    }
  });
});

describe('idempotency: never sent twice', () => {
  const deliveredTo = (to: string) => delivered.filter((d) => d === to).length;

  test('a second job for an already-sent email delivers nothing', async () => {
    const e = await addEmail('SCHEDULED', new Date());
    await testQueue.add('send', { emailId: e.id }, { jobId: e.id });
    await until('sent', async () => ((await status(e.id)) === 'SENT' ? true : undefined));
    assert.equal(deliveredTo(e.toEmail), 1);

    // A stray duplicate (e.g. a replayed job with another id) runs the processor again.
    const dup = await testQueue.add('send', { emailId: e.id }, { jobId: `${e.id}-dup` });
    await until('duplicate job finished', async () => ((await dup.getState()) === 'completed' ? true : undefined));
    assert.equal(deliveredTo(e.toEmail), 1, 'still exactly one delivery');
    assert.equal(await status(e.id), 'SENT');
  });

  test('an email found mid-send (SENDING) becomes UNCERTAIN and is not delivered', async () => {
    const e = await addEmail('SENDING', new Date());
    const job = await testQueue.add('send', { emailId: e.id }, { jobId: e.id });
    await until('job finished', async () => ((await job.getState()) === 'completed' ? true : undefined));
    assert.equal(await status(e.id), 'UNCERTAIN');
    assert.equal(deliveredTo(e.toEmail), 0);
  });

  test('a cancelled email is never delivered', async () => {
    const e = await addEmail('CANCELLED', new Date());
    const job = await testQueue.add('send', { emailId: e.id }, { jobId: e.id });
    await until('job finished', async () => ((await job.getState()) === 'completed' ? true : undefined));
    assert.equal(await status(e.id), 'CANCELLED');
    assert.equal(deliveredTo(e.toEmail), 0);
  });

  test('enqueueing the same email twice creates one job (jobId = emailId)', async () => {
    const e = await addEmail('SCHEDULED');
    const job = emailJob(e.id, e.scheduledAt);
    await emailQueue.add(job.name, job.data, job.opts);
    await emailQueue.add(job.name, job.data, job.opts);
    const delayed = await emailQueue.getDelayed(0, -1);
    assert.equal(delayed.filter((j) => j.id === e.id).length, 1);
  });

  test('retrying a schedule request with the same Idempotency-Key creates one campaign', async () => {
    const key = `retry-${randomUUID()}`;
    const req = () => fetch(`${base}/api/emails/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, 'Idempotency-Key': key },
      body: JSON.stringify({ subject: 'Once', body: 'hi', recipients: ['a@example.com', 'b@example.com'], startAt: new Date(Date.now() + MONTH).toISOString(), delayMs: 0, hourlyLimit: 100 }),
    }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));

    const [first, second] = [await req(), await req()];
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(second.body.replayed, true);
    assert.equal(second.body.campaign.id, first.body.campaign.id);
    const rows = await db.select({ id: emails.id }).from(emails).where(eq(emails.campaignId, first.body.campaign.id));
    realQueueJobs.push(...rows.map((r) => r.id));
    assert.equal(rows.length, 2, 'two emails, not four');
  });
});
