/**
 * Real delivery: schedules a 3-recipient campaign with two attachments through the HTTP
 * API, runs the actual email worker, then logs into the sender's Ethereal mailbox over
 * IMAP and checks every email arrived with byte-identical attachments.
 *
 * Needs internet access (Ethereal). Run with `npm run test:ethereal`; not part of `npm test`.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Worker } from 'bullmq';
import { ImapFlow } from 'imapflow';
import { simpleParser, type ParsedMail } from 'mailparser';
import { eq, inArray } from 'drizzle-orm';
import { db, pool } from '../../src/lib/db';
import { redis, createRedisConnection } from '../../src/lib/redis';
import { decrypt } from '../../src/lib/crypto';
import { emails, users, type Sender, type User } from '../../src/db/schema';
import { allQueues, QUEUE, type EmailJobData } from '../../src/queues';
import { createApp } from '../../src/app';
import { runMigrations } from '../../src/db/migrate';
import { processEmailJob } from '../../src/workers/email.processor';
import { closeTransports, createEtherealSender } from '../../src/modules/senders/sender.service';
import { SESSION_COOKIE, signSession } from '../../src/modules/auth/session';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64',
);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const RUN = randomUUID().slice(0, 8);
const RECIPIENTS = ['ann', 'ben', 'cat'].map((n) => `${n}.${RUN}@example.com`);

let server: Server;
let worker: Worker<EmailJobData>;
let owner: User;
let userId: string;
let sender: Sender;

const until = async <T>(what: string, fn: () => Promise<T | undefined>, timeoutMs: number): Promise<T> => {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
};

before(async () => {
  await runMigrations();
  const [u] = await db.insert(users)
    .values({ googleId: `g-e2e-${RUN}`, email: `e2e-${RUN}@ethereal-test.local`, name: 'Ethereal E2E' }).returning();
  owner = u;
  userId = u.id;
  sender = await createEtherealSender(u.id, 'E2E Sender'); // real Ethereal mailbox
  server = createApp().listen(0);
  worker = new Worker<EmailJobData>(QUEUE.EMAIL, processEmailJob, { connection: createRedisConnection('e2e-worker'), concurrency: 3 });
});

after(async () => {
  await worker?.close();
  closeTransports();
  await db.delete(users).where(eq(users.id, userId));
  server?.close();
  await Promise.allSettled(allQueues.map((q) => q.close()));
  await Promise.allSettled([redis.quit(), pool.end()]);
});

test('every email of a campaign arrives in Ethereal with the attachments', { timeout: 240_000 }, async () => {
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const form = new FormData();
  form.set('payload', JSON.stringify({
    subject: `Attachment delivery ${RUN}`, body: '<p>Files attached.</p>', recipients: RECIPIENTS,
    startAt: new Date().toISOString(), delayMs: 0, hourlyLimit: 100, senderId: sender.id,
  }));
  form.append('attachments', new Blob([new Uint8Array(PNG)]), 'chart.png');
  form.append('attachments', new Blob([new Uint8Array(PDF)]), 'Q3 report.pdf');
  const res = await fetch(`${base}/api/emails/schedule`, {
    method: 'POST', headers: { Cookie: `${SESSION_COOKIE}=${signSession(owner)}` }, body: form,
  });
  assert.equal(res.status, 201, await res.clone().text());

  // 1. The worker sends all of them.
  const rows = await until('all emails to be sent', async () => {
    const r = await db.select().from(emails).where(eq(emails.userId, userId));
    if (r.some((e) => e.status === 'FAILED' || e.status === 'UNCERTAIN')) throw new Error(`send failed: ${JSON.stringify(r.map((e) => [e.status, e.lastError]))}`);
    return r.length === RECIPIENTS.length && r.every((e) => e.status === 'SENT') ? r : undefined;
  }, 120_000);

  // 2. Ethereal captured every message, each with both attachments intact.
  const ids = new Set(rows.map((e) => e.id));
  const client = new ImapFlow({
    host: 'imap.ethereal.email', port: 993, secure: true, logger: false,
    auth: { user: sender.smtpUser, pass: decrypt(sender.smtpPassEnc) },
  });
  await client.connect();
  let received: ParsedMail[] = [];
  try {
    received = await until('messages in the Ethereal mailbox', async () => {
      const lock = await client.getMailboxLock('INBOX');
      try {
        const found: ParsedMail[] = [];
        if (client.mailbox && client.mailbox.exists > 0) {
          for await (const msg of client.fetch('1:*', { source: true })) {
            const parsed = await simpleParser(msg.source!);
            if (ids.has(String(parsed.headers.get('x-mailflow-email-id') ?? ''))) found.push(parsed);
          }
        }
        return found.length >= ids.size ? found : undefined;
      } finally {
        lock.release();
      }
    }, 60_000);
  } finally {
    await client.logout().catch(() => undefined);
  }

  assert.equal(received.length, RECIPIENTS.length, 'one message per recipient');
  const to = received.map((m) => (Array.isArray(m.to) ? m.to[0] : m.to)?.value[0]?.address).sort();
  assert.deepEqual(to, [...RECIPIENTS].sort());
  for (const m of received) {
    const files = m.attachments.map((a) => ({ name: a.filename, type: a.contentType, sha: sha(a.content) }));
    assert.deepEqual(files, [
      { name: 'chart.png', type: 'image/png', sha: sha(PNG) },
      { name: 'Q3 report.pdf', type: 'application/pdf', sha: sha(PDF) },
    ], `attachments intact for ${(Array.isArray(m.to) ? m.to[0] : m.to)?.text}`);
  }
  assert.equal((await db.select().from(emails).where(inArray(emails.id, [...ids]))).every((e) => e.previewUrl), true);
});
