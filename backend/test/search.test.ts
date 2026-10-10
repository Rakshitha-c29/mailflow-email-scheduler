/**
 * Search (Elasticsearch, through GET /api/emails/search): email addresses match by any part
 * ("park", "example", "example.com"), subjects by the start of a word ("redi" → "redis"), and
 * a user only ever sees their own emails. Runs against the test index (a fresh copy).
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { like } from 'drizzle-orm';
import { db, pool } from '../src/lib/db';
import { redis } from '../src/lib/redis';
import { encrypt } from '../src/lib/crypto';
import { es, ES_INDEX } from '../src/lib/elastic';
import { campaigns, emails, senders, users } from '../src/db/schema';
import { closeQueues } from '../src/queues';
import { createApp } from '../src/app';
import { runMigrations } from '../src/db/migrate';
import { ensureIndex, indexEmails } from '../src/modules/search/search.service';
import { SESSION_COOKIE, signSession } from '../src/modules/auth/session';

const RUN = randomUUID().slice(0, 8);
const DOMAIN = `search-${RUN}.local`;
let server: Server;
let base: string;
let alice: string;
let bob: string;

async function makeUser(tag: string, mails: { to: string; subject: string }[]) {
  const [u] = await db.insert(users).values({ googleId: `g-${randomUUID()}`, email: `${tag}@${DOMAIN}`, name: tag }).returning();
  const [s] = await db.insert(senders).values({
    userId: u.id, name: 'Sender 1', email: `${tag}.sender-${RUN}@ethereal.email`, smtpHost: 'localhost', smtpPort: 25, smtpUser: 'x', smtpPassEnc: encrypt('x'),
  }).returning();
  const [c] = await db.insert(campaigns).values({
    userId: u.id, senderId: s.id, subject: 'x', body: '<p>Hello there</p>', startAt: new Date(), delayMs: 2000, hourlyLimit: 100, totalCount: mails.length,
  }).returning();
  const rows = await db.insert(emails).values(mails.map((m) => ({
    campaignId: c.id, userId: u.id, senderId: s.id, toEmail: m.to, subject: m.subject, scheduledAt: new Date(Date.now() + 86_400_000),
  }))).returning({ id: emails.id });
  await indexEmails(rows.map((r) => r.id));
  return `${SESSION_COOKIE}=${signSession(u)}`;
}

/** Recipients found by a search, sorted. */
async function search(cookie: string, q: string): Promise<string[]> {
  const r = await fetch(`${base}/api/emails/search?q=${encodeURIComponent(q)}`, { headers: { Cookie: cookie } });
  assert.equal(r.status, 200);
  const body = (await r.json()) as { items: { toEmail: string; subject: string }[] };
  return body.items.map((i) => `${i.toEmail} | ${i.subject}`).sort();
}

before(async () => {
  await runMigrations();
  // A fresh test index with the current mapping (never the app's own index).
  assert.notEqual(ES_INDEX, 'emails', 'tests must not use the real search index');
  await es.indices.delete({ index: ES_INDEX, ignore_unavailable: true });
  await ensureIndex();
  alice = await makeUser('alice', [
    { to: 'eve.park@example.com', subject: 'Redis tips' },
    { to: 'john_smith-jr+news@acme.io', subject: 'Quarterly report' },
  ]);
  // Bob mails the same address: Alice must never see Bob's email, and the other way round.
  bob = await makeUser('bob', [{ to: 'eve.park@example.com', subject: 'Redis for Bob' }]);
  await es.indices.refresh({ index: ES_INDEX });
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await db.delete(users).where(like(users.email, `%@${DOMAIN}`));
  await es.indices.delete({ index: ES_INDEX, ignore_unavailable: true });
  server.close();
  await closeQueues();
  await Promise.allSettled([redis.quit(), pool.end(), es.close()]);
});

describe('search', () => {
  const EVE = ['eve.park@example.com | Redis tips'];

  test('email addresses match by any part: "eve", "park", "example", "example.com", the full address', async () => {
    for (const q of ['eve', 'park', 'PARK', 'example', 'example.com', 'eve.park', 'eve.park@example.com', 'exam', 'pa']) {
      assert.deepEqual(await search(alice, q), EVE, `"${q}"`);
    }
  });

  test('addresses split on . @ - _ + too', async () => {
    const JOHN = ['john_smith-jr+news@acme.io | Quarterly report'];
    for (const q of ['john', 'smith', 'jr', 'news', 'acme', 'acme.io', 'john_smith']) {
      assert.deepEqual(await search(alice, q), JOHN, `"${q}"`);
    }
  });

  test('partial words in subjects: "redi" finds "Redis"', async () => {
    assert.deepEqual(await search(alice, 'redi'), EVE);
    assert.deepEqual(await search(alice, 'quart'), ['john_smith-jr+news@acme.io | Quarterly report']);
  });

  test('no false matches', async () => {
    assert.deepEqual(await search(alice, 'parker'), []);
    assert.deepEqual(await search(alice, 'example.org'), []);
    assert.deepEqual(await search(alice, 'zzz'), []);
  });

  test("a user only sees their own emails, even for the same address", async () => {
    assert.deepEqual(await search(bob, 'park'), ['eve.park@example.com | Redis for Bob']);
    assert.deepEqual(await search(bob, 'redi'), ['eve.park@example.com | Redis for Bob']);
    assert.deepEqual(await search(bob, 'acme'), []);
    assert.ok(!(await search(alice, 'park')).some((r) => r.includes('Bob')));
  });

  test('requires a session', async () => {
    assert.equal((await fetch(`${base}/api/emails/search?q=park`)).status, 401);
  });
});
