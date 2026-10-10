/**
 * Behaviour under load: 1000+ emails scheduled for the same moment against an hourly
 * limit. Nothing is dropped or failed: overflow moves to the next windows, in order, and
 * no window ever exceeds the limit, even with every reservation racing at once.
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
import { emails, senders, users } from '../src/db/schema';
import { closeQueues, emailQueue } from '../src/queues';
import { createApp } from '../src/app';
import { runMigrations } from '../src/db/migrate';
import { planSendTimes } from '../src/scheduler/planner';
import { reserveSendSlot, windowOf } from '../src/scheduler/rateLimiter';
import { SESSION_COOKIE, signSession } from '../src/modules/auth/session';

const W = env.RATE_WINDOW_MS;
const DOMAIN = `load-test-${randomUUID().slice(0, 8)}.local`;
let server: Server;
let base: string;
let scheduledIds: string[] = [];

before(async () => {
  await runMigrations();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  for (let i = 0; i < scheduledIds.length; i += 200) {
    await Promise.allSettled(scheduledIds.slice(i, i + 200).map((id) => emailQueue.remove(id)));
  }
  await db.delete(users).where(like(users.email, `%@${DOMAIN}`));
  server.close();
  await closeQueues();
  await Promise.allSettled([redis.quit(), pool.end()]);
});

const countByWindow = (times: number[]) => {
  const m = new Map<number, number>();
  for (const t of times) m.set(windowOf(t), (m.get(windowOf(t)) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => a[0] - b[0]);
};

describe('planner (send times shown on the dashboard)', () => {
  test('1000 emails at the same time, 200 per window → 5 full windows, in order', () => {
    const start = Math.ceil(Date.now() / W) * W; // a window boundary, for exact counts
    const times = planSendTimes({ count: 1000, startAt: start, gapMs: 0, limit: 200, windowMs: W });
    assert.equal(times.length, 1000, 'every email gets a time: nothing dropped');
    assert.deepEqual(countByWindow(times).map(([, n]) => n), [200, 200, 200, 200, 200]);
    assert.ok(times.every((t, i) => i === 0 || t >= times[i - 1]), 'order preserved');
  });

  test('respects the delay between emails and rolls over to the next window', () => {
    const start = Math.ceil(Date.now() / W) * W;
    const gap = Math.floor(W / 10);
    const times = planSendTimes({ count: 25, startAt: start, gapMs: gap, limit: 5, windowMs: W });
    assert.ok(times.every((t, i) => i === 0 || t - times[i - 1] >= gap || windowOf(t) !== windowOf(times[i - 1])));
    assert.ok(countByWindow(times).every(([, n]) => n <= 5), 'never more than the limit in a window');
  });
});

describe('rate limiter (enforced in Redis at send time)', () => {
  test('1000 concurrent reservations for one sender: exactly 200 per window, none dropped', async () => {
    const senderId = `load-${randomUUID()}`;
    const now = Date.now();
    const slots = await Promise.all(Array.from({ length: 1000 }, () =>
      reserveSendSlot({ senderId, limit: 200, gapMs: 0, earliest: now, now })));

    assert.equal(slots.length, 1000);
    const perWindow = countByWindow(slots.map((s) => s.slotAt));
    assert.equal(perWindow.length, 5, 'overflow spread over the next windows');
    assert.ok(perWindow.every(([, n]) => n === 200), `exactly the limit in each window: ${JSON.stringify(perWindow)}`);
    assert.equal(perWindow[0][0], windowOf(now), 'starts in the current window');
    assert.ok(perWindow.every(([w], i) => i === 0 || w === perWindow[i - 1][0] + 1), 'consecutive windows: next available hour');
    assert.equal(new Set(slots.map((s) => `${s.window}:${s.countInWindow}`)).size, 1000, 'no two reservations share a slot');

    await redis.del(`rl:{${senderId}}:next`, ...perWindow.map(([w]) => `rl:{${senderId}}:w:${w}`));
  });

  test('the minimum gap holds between concurrently reserved slots', async () => {
    const senderId = `gap-${randomUUID()}`;
    const now = Date.now();
    const gap = 2000;
    const slots = (await Promise.all(Array.from({ length: 50 }, () =>
      reserveSendSlot({ senderId, limit: 1000, gapMs: gap, earliest: now, now })))).map((s) => s.slotAt).sort((a, b) => a - b);
    assert.ok(slots.every((t, i) => i === 0 || t - slots[i - 1] >= gap), `min ${gap} ms between slots`);
    await redis.del(`rl:{${senderId}}:next`, ...new Set(slots.map((t) => `rl:{${senderId}}:w:${windowOf(t)}`)));
  });
});

describe('scheduling 1000 emails through the API', () => {
  test('one request → 1000 rows + 1000 delayed jobs, planned within the hourly limit', async () => {
    const [u] = await db.insert(users).values({ googleId: `g-${randomUUID()}`, email: `owner@${DOMAIN}`, name: 'Owner' }).returning();
    for (let i = 0; i < Math.max(env.SENDERS_PER_USER, 1); i++) {
      await db.insert(senders).values({
        userId: u.id, name: `Sender ${i + 1}`, email: `s${i}-${randomUUID()}@${DOMAIN}`, smtpHost: '127.0.0.1', smtpPort: 9, smtpUser: 'x', smtpPassEnc: encrypt('x'),
      });
    }
    const recipients = Array.from({ length: 1000 }, (_, i) => `lead${i}@example.com`);
    const t0 = Date.now();
    const res = await fetch(`${base}/api/emails/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE}=${signSession(u)}` },
      body: JSON.stringify({
        subject: 'Load', body: 'hi', recipients, delayMs: 0, hourlyLimit: 200,
        startAt: new Date(Date.now() + 30 * 86_400_000).toISOString(), // a month out: nothing sends
      }),
    });
    const ms = Date.now() - t0;
    assert.equal(res.status, 201, await res.clone().text());

    const rows = await db.select({ id: emails.id, scheduledAt: emails.scheduledAt }).from(emails).where(eq(emails.userId, u.id));
    scheduledIds = rows.map((r) => r.id);
    assert.equal(rows.length, 1000, '1000 rows');
    const planned = countByWindow(rows.map((r) => r.scheduledAt.getTime()));
    assert.ok(planned.every(([, n]) => n <= 200), 'planned ≤ hourly limit per window');
    assert.equal(planned.reduce((a, [, n]) => a + n, 0), 1000);

    const jobs = await Promise.all(rows.slice(0, 50).map((r) => emailQueue.getJob(r.id)));
    assert.ok(jobs.every((j, i) => j && j.data.emailId === rows[i].id && j.opts.delay! > 0), 'each email has its own delayed job');
    assert.equal(await emailQueue.getJobCountByTypes('delayed') >= 1000, true);
    assert.ok(ms < 30_000, `accepted in ${ms} ms`);
  });
});
