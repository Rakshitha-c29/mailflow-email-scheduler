/**
 * "Send again" for UNCERTAIN emails: a new email is created (new id, same campaign), the
 * original row is untouched, and the action is idempotent even under concurrent clicks.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { eq, like } from 'drizzle-orm';
import { db, pool } from '../src/lib/db';
import { redis } from '../src/lib/redis';
import { encrypt } from '../src/lib/crypto';
import { campaigns, emails, senders, users, type EmailStatus } from '../src/db/schema';
import { closeQueues, emailQueue } from '../src/queues';
import { createApp } from '../src/app';
import { runMigrations } from '../src/db/migrate';
import { SESSION_COOKIE, signSession } from '../src/modules/auth/session';

const DOMAIN = `resend-test-${randomUUID().slice(0, 8)}.local`;
let server: Server;
let base: string;
const created: string[] = [];

async function makeUser(tag: string) {
  const [u] = await db.insert(users).values({ googleId: `g-${randomUUID()}`, email: `${tag}@${DOMAIN}`, name: tag }).returning();
  // Port 9 (discard): if a running dev worker picks a copy up, it fails fast and harmlessly.
  const [s] = await db.insert(senders).values({
    userId: u.id, name: 'Sender 1', email: `s-${randomUUID()}@${DOMAIN}`, smtpHost: '127.0.0.1', smtpPort: 9, smtpUser: 'x', smtpPassEnc: encrypt('x'),
  }).returning();
  const [c] = await db.insert(campaigns).values({
    userId: u.id, senderId: s.id, subject: 'Hello', body: '<p>Hi</p>', startAt: new Date(), delayMs: 2000, hourlyLimit: 100, totalCount: 1,
  }).returning();
  const add = (status: EmailStatus) => db.insert(emails).values({
    campaignId: c.id, userId: u.id, senderId: s.id, toEmail: `lead-${randomUUID().slice(0, 6)}@example.com`, subject: 'Hello',
    status, scheduledAt: new Date(Date.now() - 3_600_000), attempts: 1, lastError: status === 'UNCERTAIN' ? 'Interrupted during SMTP delivery' : null,
  }).returning().then((r) => r[0]);
  return { cookie: `${SESSION_COOKIE}=${signSession(u)}`, add };
}

const resend = async (id: string, cookie: string) => {
  const r = await fetch(`${base}/api/emails/${id}/resend`, { method: 'POST', headers: { Cookie: cookie } });
  const body = (await r.json()) as any;
  if (body?.email?.id) created.push(body.email.id);
  return { status: r.status, body };
};

before(async () => {
  await runMigrations();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await Promise.allSettled(created.map((id) => emailQueue.remove(id)));
  await db.delete(users).where(like(users.email, `%@${DOMAIN}`));
  server.close();
  await closeQueues();
  await Promise.allSettled([redis.quit(), pool.end()]);
});

describe('POST /api/emails/:id/resend', () => {
  test('creates a NEW email and queues it; the original row is untouched', async () => {
    const { cookie, add } = await makeUser('fresh');
    const original = await add('UNCERTAIN');
    const res = await resend(original.id, cookie);

    assert.equal(res.status, 201);
    const copyId = res.body.email.id;
    assert.notEqual(copyId, original.id, 'new id');

    const copy = await db.query.emails.findFirst({ where: eq(emails.id, copyId) });
    assert.equal(copy?.resendOf, original.id);
    assert.equal(copy?.campaignId, original.campaignId, 'same campaign: same body and attachments');
    assert.equal(copy?.toEmail, original.toEmail);
    assert.equal(copy?.attempts, 0);

    const after = await db.query.emails.findFirst({ where: eq(emails.id, original.id) });
    assert.deepEqual(after, original, 'original row unchanged, field for field');

    const job = await emailQueue.getJob(copyId);
    assert.equal(job?.data.emailId, copyId, 'the copy has its own queue job');
  });

  test('is idempotent: asking again returns the same copy', async () => {
    const { cookie, add } = await makeUser('again');
    const original = await add('UNCERTAIN');
    const first = await resend(original.id, cookie);
    const second = await resend(original.id, cookie);
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(second.body.email.id, first.body.email.id);
  });

  test('concurrent clicks create exactly one copy', async () => {
    const { cookie, add } = await makeUser('race');
    const original = await add('UNCERTAIN');
    const results = await Promise.all(Array.from({ length: 5 }, () => resend(original.id, cookie)));
    assert.equal(new Set(results.map((r) => r.body.email.id)).size, 1, 'all five got the same copy');
    assert.equal(results.filter((r) => r.status === 201).length, 1, 'exactly one request created it');
    assert.equal((await db.select().from(emails).where(eq(emails.resendOf, original.id))).length, 1);
  });

  test('only UNCERTAIN emails can be sent again', async () => {
    const { cookie, add } = await makeUser('sent');
    for (const status of ['SENT', 'FAILED', 'SCHEDULED'] as const) {
      const e = await add(status);
      const r = await resend(e.id, cookie);
      assert.equal(r.status, 409, status);
      assert.equal(r.body.error.message, 'Only emails whose delivery is uncertain can be sent again');
    }
  });

  test("can't resend another user's email", async () => {
    const owner = await makeUser('owner');
    const other = await makeUser('other');
    const e = await owner.add('UNCERTAIN');
    assert.equal((await resend(e.id, other.cookie)).status, 404);
  });

  test('the detail view links the original and the copy both ways', async () => {
    const { cookie, add } = await makeUser('links');
    const original = await add('UNCERTAIN');
    const copyId = (await resend(original.id, cookie)).body.email.id;
    const get = async (id: string) => ((await (await fetch(`${base}/api/emails/${id}`, { headers: { Cookie: cookie } })).json()) as any).email;
    const o = await get(original.id);
    const c = await get(copyId);
    assert.equal(o.resentAs.id, copyId);
    assert.equal(c.resendOf, original.id);
    assert.deepEqual(o.events.map((e: any) => e.type), ['RESENT']);
    assert.deepEqual(c.events.map((e: any) => e.type).slice(0, 1), ['RESEND_OF']);
  });
});
