/**
 * Multiple senders: every user has at least 2 Ethereal mailboxes (accounts made when the
 * setting was lower are topped up on their next visit), Compose lists them all, and a
 * campaign is sent from the one the user picked. Ethereal itself is stubbed.
 */
import { after, before, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import nodemailer from 'nodemailer';
import { eq, like } from 'drizzle-orm';
import { db, pool } from '../src/lib/db';
import { redis } from '../src/lib/redis';
import { encrypt } from '../src/lib/crypto';
import { env } from '../src/config/env';
import { campaigns, emails, senders, users } from '../src/db/schema';
import { closeQueues, emailQueue } from '../src/queues';
import { createApp } from '../src/app';
import { runMigrations } from '../src/db/migrate';
import { SESSION_COOKIE, signSession } from '../src/modules/auth/session';

const RUN = randomUUID().slice(0, 8);
const DOMAIN = `senders-${RUN}.local`;
const MONTH = 30 * 86_400_000;
let server: Server;
let base: string;
const jobs: string[] = [];

/** A user as they were with SENDERS_PER_USER=1: exactly one sender. */
async function userWithOneSender(tag: string) {
  const [u] = await db.insert(users).values({ googleId: `g-${randomUUID()}`, email: `${tag}@${DOMAIN}`, name: tag }).returning();
  await db.insert(senders).values({
    userId: u.id, name: 'Sender 1', email: `old-${randomUUID().slice(0, 8)}@ethereal.email`, smtpHost: 'smtp.ethereal.email', smtpPort: 587,
    smtpUser: 'x', smtpPassEnc: encrypt('x'),
  });
  return { user: u, cookie: `${SESSION_COOKIE}=${signSession(u)}` };
}

const listSenders = async (cookie: string) =>
  (await (await fetch(`${base}/api/senders`, { headers: { Cookie: cookie } })).json()) as { senders: { id: string; email: string }[] };

before(async () => {
  let n = 0;
  mock.method(nodemailer, 'createTestAccount', async () => ({
    user: `stub-${RUN}-${n++}@ethereal.email`, pass: 'stub',
    smtp: { host: 'smtp.ethereal.email', port: 587, secure: false },
    imap: { host: '', port: 0, secure: false }, pop3: { host: '', port: 0, secure: false }, web: '',
  }));
  await runMigrations();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await Promise.allSettled(jobs.map((id) => emailQueue.remove(id)));
  await db.delete(users).where(like(users.email, `%@${DOMAIN}`));
  server.close();
  await closeQueues();
  await Promise.allSettled([redis.quit(), pool.end()]);
});

describe('multiple senders', () => {
  test('the setting is at least 2', () => {
    assert.ok(env.SENDERS_PER_USER >= 2, `SENDERS_PER_USER = ${env.SENDERS_PER_USER}`);
  });

  test('a user with only one sender is topped up to at least 2, all listed for Compose', async () => {
    const { user, cookie } = await userWithOneSender('topup');
    const { senders: list } = await listSenders(cookie);
    assert.equal(list.length, env.SENDERS_PER_USER);
    assert.equal(new Set(list.map((s) => s.email)).size, list.length, 'different mailboxes');
    assert.equal((await db.select().from(senders).where(eq(senders.userId, user.id))).length, env.SENDERS_PER_USER);

    // Visiting again doesn't add more.
    assert.equal((await listSenders(cookie)).senders.length, env.SENDERS_PER_USER);
  });

  test('a campaign is sent from the sender picked in From, and each sender is usable', async () => {
    const { cookie } = await userWithOneSender('pick');
    const { senders: list } = await listSenders(cookie);
    for (const s of list) {
      const r = await fetch(`${base}/api/emails/schedule`, {
        method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subject: 'From test', body: 'hi', recipients: ['a@example.com'], senderId: s.id,
          startAt: new Date(Date.now() + MONTH).toISOString(), delayMs: 2000, hourlyLimit: 10,
        }),
      });
      assert.equal(r.status, 201);
      const { campaign } = (await r.json()) as { campaign: { id: string; senderId: string } };
      assert.equal(campaign.senderId, s.id, `campaign uses ${s.email}`);
      const rows = await db.select().from(emails).where(eq(emails.campaignId, campaign.id));
      jobs.push(...rows.map((e) => e.id));
      assert.ok(rows.every((e) => e.senderId === s.id), 'its emails too');
      assert.equal((await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaign.id) }))?.senderId, s.id);
    }
  });

  test("another user's sender can't be picked", async () => {
    const a = await userWithOneSender('owner');
    const b = await userWithOneSender('other');
    const theirs = (await listSenders(a.cookie)).senders[1];
    const r = await fetch(`${base}/api/emails/schedule`, {
      method: 'POST', headers: { Cookie: b.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subject: 'x', body: 'x', recipients: ['a@example.com'], senderId: theirs.id,
        startAt: new Date(Date.now() + MONTH).toISOString(), delayMs: 2000, hourlyLimit: 10,
      }),
    });
    assert.equal(r.status, 400);
  });
});
