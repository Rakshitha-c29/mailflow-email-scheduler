/**
 * Bull Board at /admin/queues: only ADMIN_EMAILS may open it, and it is read-only
 * (viewing works; retry, promote, clean, add and pause are refused server-side).
 */
import './helpers/adminEnv'; // must be the first import
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { like } from 'drizzle-orm';
import { db, pool } from '../src/lib/db';
import { redis } from '../src/lib/redis';
import { users } from '../src/db/schema';
import { closeQueues, QUEUE } from '../src/queues';
import { createApp } from '../src/app';
import { runMigrations } from '../src/db/migrate';
import { SESSION_COOKIE, signSession } from '../src/modules/auth/session';

let server: Server;
let base: string;
let adminCookie: string;
let userCookie: string;

const call = (path: string, cookie?: string, method = 'GET') =>
  fetch(`${base}/admin/queues${path}`, { method, redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });

before(async () => {
  await runMigrations();
  await db.delete(users).where(like(users.email, '%@admin-test.local'));
  const [admin] = await db.insert(users).values({ googleId: `g-${randomUUID()}`, email: 'boss@admin-test.local', name: 'Boss' }).returning();
  const [user] = await db.insert(users).values({ googleId: `g-${randomUUID()}`, email: 'someone@admin-test.local', name: 'Someone' }).returning();
  adminCookie = `${SESSION_COOKIE}=${signSession(admin)}`;
  userCookie = `${SESSION_COOKIE}=${signSession(user)}`;
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await db.delete(users).where(like(users.email, '%@admin-test.local'));
  server.close();
  await closeQueues();
  await Promise.allSettled([redis.quit(), pool.end()]);
});

describe('/admin/queues access', () => {
  test('not signed in → sent to the login page', async () => {
    const r = await call('');
    assert.equal(r.status, 302);
    assert.match(r.headers.get('location') ?? '', /\/login$/);
  });

  test('signed in but not in ADMIN_EMAILS → 403', async () => {
    assert.equal((await call('', userCookie)).status, 403);
    assert.equal((await call('/api/queues', userCookie)).status, 403);
  });

  test('an admin can view the queues', async () => {
    assert.equal((await call('', adminCookie)).status, 200);
    const r = await call('/api/queues', adminCookie);
    assert.equal(r.status, 200);
    const body = (await r.json()) as { queues: { name: string; readOnlyMode: boolean }[] };
    const email = body.queues.find((q) => q.name === QUEUE.EMAIL);
    assert.ok(email, 'email-send queue listed');
    assert.ok(body.queues.every((q) => q.readOnlyMode), 'every queue is read-only');
  });

  test('read-only: even an admin cannot retry, promote, clean, add or pause', async () => {
    for (const [method, path] of [
      ['PUT', `/api/queues/${QUEUE.EMAIL}/retry/failed`],
      ['PUT', `/api/queues/${QUEUE.EMAIL}/promote`],
      ['PUT', `/api/queues/${QUEUE.EMAIL}/clean/failed`],
      ['PUT', `/api/queues/${QUEUE.EMAIL}/empty`],
      ['POST', `/api/queues/${QUEUE.EMAIL}/add`],
      ['PUT', `/api/queues/${QUEUE.EMAIL}/pause`],
    ] as const) {
      assert.equal((await call(path, adminCookie, method)).status, 405, `${method} ${path} refused`);
    }
  });
});
