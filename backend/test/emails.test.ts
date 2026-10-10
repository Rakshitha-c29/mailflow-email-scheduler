/**
 * Dashboard list endpoints: previews, status filter, starring. Rows are inserted
 * directly (no queue jobs), so nothing here can ever be sent by a running worker.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { eq, like } from 'drizzle-orm';
import { env } from '../src/config/env';
import { db, pool } from '../src/lib/db';
import { redis } from '../src/lib/redis';
import { encrypt } from '../src/lib/crypto';
import { campaigns, emails, senders, users, type EmailStatus } from '../src/db/schema';
import { allQueues } from '../src/queues';
import { createApp } from '../src/app';
import { runMigrations } from '../src/db/migrate';
import { toPreview } from '../src/lib/text';
import { SESSION_COOKIE, signSession } from '../src/modules/auth/session';

const DOMAIN = `emails-test-${randomUUID().slice(0, 8)}.local`;
let server: Server;
let base: string;

async function makeUser(tag: string) {
  const [u] = await db.insert(users)
    .values({ googleId: `g-${randomUUID()}`, email: `${tag}@${DOMAIN}`, name: tag }).returning();
  const [s] = await db.insert(senders).values({
    userId: u.id, name: 'Sender 1', email: `s-${randomUUID()}@${DOMAIN}`, smtpHost: 'localhost', smtpPort: 25,
    smtpUser: 'x', smtpPassEnc: encrypt('x'),
  }).returning();
  const [c] = await db.insert(campaigns).values({
    userId: u.id, senderId: s.id, subject: 'Meeting follow-up',
    body: '<p>Hi John,&nbsp;just wanted to <b>follow up</b> on our meeting.</p>',
    startAt: new Date(), delayMs: 2000, hourlyLimit: 100, totalCount: 3,
  }).returning();
  const add = (to: string, status: EmailStatus) => db.insert(emails).values({
    campaignId: c.id, userId: u.id, senderId: s.id, toEmail: `${to}@example.com`, subject: c.subject,
    status, scheduledAt: new Date(Date.now() + 3_600_000),
  }).returning().then((r) => r[0]);
  return { user: u, cookie: `${SESSION_COOKIE}=${signSession(u)}`, add };
}

const get = async (path: string, cookie: string) => {
  const r = await fetch(`${base}/api/emails${path}`, { headers: { Cookie: cookie } });
  return { status: r.status, body: (await r.json()) as any };
};
const star = async (id: string, starred: boolean, cookie: string) => {
  const r = await fetch(`${base}/api/emails/${id}/star`, {
    method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ starred }),
  });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
};

before(async () => {
  await runMigrations();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await db.delete(users).where(like(users.email, `%@${DOMAIN}`));
  server.close();
  await Promise.allSettled(allQueues.map((q) => q.close()));
  await Promise.allSettled([redis.quit(), pool.end()]);
});

describe('toPreview', () => {
  test('strips HTML, decodes entities, collapses whitespace, truncates', () => {
    assert.equal(toPreview('<p>Hi&nbsp;<b>John</b>,\n\n  thanks</p><p>Bye</p>'), 'Hi John, thanks Bye');
    assert.equal(toPreview('<style>p{color:red}</style>Hello'), 'Hello');
    assert.equal(toPreview('a'.repeat(300), 20), `${'a'.repeat(19)}…`);
  });
});

describe('GET /api/emails', () => {
  test('returns a plain-text preview and the starred flag', async () => {
    const { cookie, add } = await makeUser('list');
    await add('john', 'SCHEDULED');
    const { status, body } = await get('?view=scheduled', cookie);
    assert.equal(status, 200);
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].preview, 'Hi John, just wanted to follow up on our meeting.');
    assert.equal(body.items[0].starred, false);
    assert.equal(body.items[0].bodyStart, undefined, 'raw body not exposed');
  });

  test('status filter narrows within a tab and rejects statuses from another tab', async () => {
    const { cookie, add } = await makeUser('filter');
    await add('a', 'SENT');
    await add('b', 'FAILED');
    await add('c', 'SCHEDULED');

    const sent = await get('?view=sent', cookie);
    assert.deepEqual(sent.body.items.map((i: any) => i.status).sort(), ['FAILED', 'SENT']);

    const failed = await get('?view=sent&status=FAILED', cookie);
    assert.deepEqual(failed.body.items.map((i: any) => i.toEmail), ['b@example.com']);

    assert.equal((await get('?view=scheduled&status=SENT', cookie)).status, 400);
  });
});

describe('GET /api/emails/:id', () => {
  test('returns the full body, the sender and the event history', async () => {
    const { cookie, add } = await makeUser('detail');
    const e = await add('d', 'SCHEDULED');
    const { status, body } = await get(`/${e.id}`, cookie);
    assert.equal(status, 200);
    assert.equal(body.email.body, '<p>Hi John,&nbsp;just wanted to <b>follow up</b> on our meeting.</p>');
    assert.equal(body.email.sender.name, 'Sender 1');
    assert.ok(body.email.sender.email.endsWith(`@${DOMAIN}`));
    assert.deepEqual(body.email.events, []);
  });

  test('includes the campaign settings: entered values and what the server used', async () => {
    const { cookie, add } = await makeUser('settings');
    const e = await add('s', 'SCHEDULED');
    const campaign = (await get(`/${e.id}`, cookie)).body.email.campaign;
    assert.deepEqual(
      { ...campaign, startAt: typeof campaign.startAt },
      { startAt: 'string', delayMs: 2000, hourlyLimit: 100, totalCount: 3, windowMs: env.RATE_WINDOW_MS, effective: { delayMs: 2000, hourlyLimit: 100 } },
    );

    // Values outside the system limits are kept as entered, and the clamped ones are shown too.
    await db.update(campaigns).set({ delayMs: 0, hourlyLimit: 1_000_000 }).where(eq(campaigns.id, e.campaignId));
    const clamped = (await get(`/${e.id}`, cookie)).body.email.campaign;
    assert.deepEqual(
      { delayMs: clamped.delayMs, hourlyLimit: clamped.hourlyLimit, effective: clamped.effective },
      { delayMs: 0, hourlyLimit: 1_000_000, effective: { delayMs: env.MIN_DELAY_BETWEEN_EMAILS_MS, hourlyLimit: env.MAX_EMAILS_PER_HOUR_PER_SENDER } },
    );
  });

  test("another user's email is 404", async () => {
    const owner = await makeUser('detail-owner');
    const other = await makeUser('detail-other');
    const e = await owner.add('d', 'SENT');
    assert.equal((await get(`/${e.id}`, other.cookie)).status, 404);
  });
});

describe('DELETE /api/emails/:id (cancel)', () => {
  const del = (id: string, cookie: string) =>
    fetch(`${base}/api/emails/${id}`, { method: 'DELETE', headers: { Cookie: cookie } });

  test('cancels a scheduled email and records it', async () => {
    const { cookie, add } = await makeUser('cancel');
    const e = await add('c', 'SCHEDULED');
    assert.equal((await del(e.id, cookie)).status, 204);
    const { body } = await get(`/${e.id}`, cookie);
    assert.equal(body.email.status, 'CANCELLED');
    assert.deepEqual(body.email.events.map((ev: any) => ev.type), ['CANCELLED']);
  });

  test('refuses once the email is no longer scheduled', async () => {
    const { cookie, add } = await makeUser('cancel-late');
    const e = await add('c', 'SENT');
    const r = await del(e.id, cookie);
    assert.equal(r.status, 409);
    assert.match(((await r.json()) as any).error.message, /already sent/);
  });
});

describe('PUT /api/emails/:id/star', () => {
  test('stars and unstars an own email', async () => {
    const { cookie, add } = await makeUser('star');
    const e = await add('x', 'SCHEDULED');

    assert.deepEqual((await star(e.id, true, cookie)).body, { id: e.id, starred: true });
    assert.equal((await get('?view=scheduled', cookie)).body.items[0].starred, true);
    assert.equal((await star(e.id, false, cookie)).body.starred, false);
  });

  test("can't star another user's email", async () => {
    const owner = await makeUser('owner');
    const other = await makeUser('other');
    const e = await owner.add('y', 'SENT');
    assert.equal((await star(e.id, true, other.cookie)).status, 404);
  });

  test('validates the body', async () => {
    const { cookie, add } = await makeUser('bad');
    const e = await add('z', 'SENT');
    const r = await fetch(`${base}/api/emails/${e.id}/star`, {
      method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{"starred":"yes"}',
    });
    assert.equal(r.status, 400);
  });
});
