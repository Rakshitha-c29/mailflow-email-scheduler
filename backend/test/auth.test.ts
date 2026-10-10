/**
 * Email + password auth, end to end through the HTTP app (real Postgres + Redis).
 * Only Ethereal account creation is stubbed (network, and Ethereal throttles).
 */
import { after, before, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import nodemailer from 'nodemailer';
import { eq, like } from 'drizzle-orm';
import { env } from '../src/config/env';
import { db, pool } from '../src/lib/db';
import { redis } from '../src/lib/redis';
import { senders, users } from '../src/db/schema';
import { allQueues } from '../src/queues';
import { createApp } from '../src/app';
import { runMigrations } from '../src/db/migrate';
import jwt from 'jsonwebtoken';
import { findOrCreateGoogleUser, RECENT_SIGN_IN_MS } from '../src/modules/auth/auth.service';
import { attemptKey } from '../src/modules/auth/attemptLimiter';
import { SESSION_COOKIE, signSession, toPublicUser, type SessionSubject } from '../src/modules/auth/session';

const RUN = randomUUID().slice(0, 8);
const DOMAIN = `auth-test-${RUN}.local`;
const usedEmails: string[] = [];
const usedIps: string[] = [];

const newEmail = (tag: string) => {
  const e = `${tag}-${randomUUID().slice(0, 6)}@${DOMAIN}`;
  usedEmails.push(e);
  return e;
};
/** Each test gets its own client IP (the app trusts X-Forwarded-For from loopback). */
const newIp = () => {
  const ip = `10.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
  usedIps.push(ip);
  return ip;
};
const PASSWORD = 'correct horse battery';

let server: Server;
let base: string;

async function post(path: string, body: unknown, ip: string, cookie?: string) {
  const res = await fetch(`${base}/api/auth${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip, ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    body: (await res.json().catch(() => null)) as any,
    cookie: res.headers.get('set-cookie'),
    retryAfter: res.headers.get('retry-after'),
  };
}

const signup = (email: string, ip = newIp(), password = PASSWORD, name = 'Test User') =>
  post('/signup', { name, email, password }, ip);
const login = (email: string, password: string, ip = newIp()) => post('/login', { email, password }, ip);
const setPasswordReq = (cookie: string, body: { password: string; currentPassword?: string }) =>
  post('/password', body, newIp(), cookie);

/** "ri_session=…" from a Set-Cookie header. */
const cookieOf = (res: { cookie: string | null }) => res.cookie!.split(';')[0];
/** Cookie for a session as the Google callback would issue it. */
const googleCookie = (u: SessionSubject) => `${SESSION_COOKIE}=${signSession(u)}`;
const meStatus = async (cookie: string) => (await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie } })).status;
const googleUser = (email: string) =>
  findOrCreateGoogleUser({ sub: `g-${randomUUID()}`, email, name: 'Owner', avatarUrl: null });

before(async () => {
  let n = 0;
  mock.method(nodemailer, 'createTestAccount', async () => ({
    user: `stub-${RUN}-${n++}-${randomUUID().slice(0, 6)}@ethereal.email`,
    pass: 'stub',
    smtp: { host: 'smtp.ethereal.email', port: 587, secure: false },
    imap: { host: '', port: 0, secure: false },
    pop3: { host: '', port: 0, secure: false },
    web: '',
  }));
  await runMigrations();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  const created = await db.select({ id: users.id }).from(users).where(like(users.email, `%@${DOMAIN}`));
  if (created.length) await redis.del(...created.map((u) => `auth:sv:${u.id}`));
  await db.delete(users).where(like(users.email, `%@${DOMAIN}`));
  const keys = [
    ...usedEmails.flatMap((e) => [attemptKey('login', 'email', e), attemptKey('signup', 'email', e)]),
    ...usedIps.flatMap((ip) => [attemptKey('login', 'ip', ip), attemptKey('signup', 'ip', ip)]),
  ];
  if (keys.length) await redis.del(...keys);
  server.close();
  await Promise.allSettled(allQueues.map((q) => q.close()));
  await Promise.allSettled([redis.quit(), pool.end()]);
});

describe('signup', () => {
  test('creates the account, sets the session cookie and provisions senders', async () => {
    const email = newEmail('signup');
    const res = await signup(`  ${email.toUpperCase()}  `);

    assert.equal(res.status, 201);
    assert.equal(res.body.user.email, email, 'email is trimmed and lowercased');
    assert.match(res.cookie ?? '', new RegExp(`^${SESSION_COOKIE}=`));
    assert.match(res.cookie ?? '', /HttpOnly/i);

    const row = await db.query.users.findFirst({ where: eq(users.email, email) });
    assert.ok(row?.passwordHash?.startsWith('$argon2id$'), 'password stored as an argon2id hash');
    assert.equal(row?.googleId, null);

    const own = await db.select().from(senders).where(eq(senders.userId, row!.id));
    assert.equal(own.length, env.SENDERS_PER_USER);

    // The cookie is a normal session, same as Google login.
    const me = await fetch(`${base}/api/auth/me`, { headers: { Cookie: res.cookie!.split(';')[0] } });
    assert.equal(me.status, 200);
    assert.equal(((await me.json()) as any).user.email, email);
  });

  test('enforces password length 8..128', async () => {
    const tooShort = await signup(newEmail('short'), newIp(), '1234567');
    assert.equal(tooShort.status, 400);
    assert.equal(tooShort.body.error.message, 'Password must be at least 8 characters');

    const tooLong = await signup(newEmail('long'), newIp(), 'x'.repeat(129));
    assert.equal(tooLong.status, 400);
    assert.equal(tooLong.body.error.message, 'Password must be at most 128 characters');

    assert.equal((await signup(newEmail('max'), newIp(), 'x'.repeat(128))).status, 201);
  });

  test('rejects an email that is already registered (any case)', async () => {
    const email = newEmail('dup');
    assert.equal((await signup(email)).status, 201);
    const again = await signup(email.toUpperCase());
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'EMAIL_TAKEN');
  });
});

describe('login', () => {
  test('succeeds with the right password (email case/spaces ignored)', async () => {
    const email = newEmail('login');
    await signup(email);
    const res = await login(` ${email.toUpperCase()} `, PASSWORD);
    assert.equal(res.status, 200);
    assert.equal(res.body.user.email, email);
    assert.match(res.cookie ?? '', new RegExp(`^${SESSION_COOKIE}=`));
  });

  test('wrong password and unknown email get the same generic error', async () => {
    const email = newEmail('wrong');
    await signup(email);

    const wrong = await login(email, 'not the password');
    const unknown = await login(newEmail('nobody'), PASSWORD);

    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.deepEqual(wrong.body, unknown.body);
    assert.equal(wrong.body.error.message, 'Invalid email or password');
    assert.equal(wrong.cookie, null, 'no session on failure');
  });

  test('password login on a Google-only account says to use Google', async () => {
    const email = newEmail('google-only');
    await findOrCreateGoogleUser({ sub: `g-${randomUUID()}`, email, name: 'G User', avatarUrl: null });

    const res = await login(email, PASSWORD);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.message, 'This account uses Google sign-in');
  });
});

describe('rate limiting', () => {
  test('too many failed logins for one email → 429, even with the right password, from any IP', async () => {
    const email = newEmail('bruteforce');
    await signup(email);
    for (let i = 0; i < env.LOGIN_MAX_FAILURES_PER_EMAIL; i++) {
      assert.equal((await login(email, `wrong-${i}`)).status, 401); // new IP each time
    }
    const blocked = await login(email, PASSWORD);
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error.code, 'TOO_MANY_ATTEMPTS');
    assert.match(blocked.body.error.message, /^Too many login attempts\. Please try again in \d+ minutes?\.$/);
    assert.ok(Number(blocked.retryAfter) > 0, 'Retry-After header set');
  });

  test('a successful login resets the per-email failure count', async () => {
    const email = newEmail('reset');
    await signup(email);
    for (let i = 0; i < env.LOGIN_MAX_FAILURES_PER_EMAIL - 1; i++) await login(email, 'wrong');
    assert.equal((await login(email, PASSWORD)).status, 200);
    assert.equal((await login(email, 'wrong')).status, 401, 'counter was reset, not 429');
  });

  test('too many login attempts from one IP → 429', async () => {
    const ip = newIp();
    for (let i = 0; i < env.LOGIN_MAX_PER_IP; i++) {
      assert.equal((await login(newEmail('ip'), PASSWORD, ip)).status, 401);
    }
    const blocked = await login(newEmail('ip'), PASSWORD, ip);
    assert.equal(blocked.status, 429);
    assert.match(blocked.body.error.message, /Too many login attempts/);
  });

  test('too many signups from one IP → 429', async () => {
    const ip = newIp();
    for (let i = 0; i < env.SIGNUP_MAX_PER_IP; i++) {
      assert.equal((await signup(newEmail('signup-ip'), ip)).status, 201);
    }
    const blocked = await signup(newEmail('signup-ip'), ip);
    assert.equal(blocked.status, 429);
    assert.match(blocked.body.error.message, /Too many sign-up attempts/);
  });

  test('too many signups for one email → 429', async () => {
    const email = newEmail('signup-email');
    for (let i = 0; i < env.SIGNUP_MAX_PER_EMAIL; i++) await signup(email); // 1× 201, then 409s
    const blocked = await signup(email);
    assert.equal(blocked.status, 429);
  });
});

describe('account linking', () => {
  test('pre-hijacking is closed: attacker password and session stop working once the owner signs in with Google', async () => {
    const email = newEmail('victim');
    const ATTACKER_PASSWORD = 'attacker-chose-this';

    // 1. Attacker registers the victim's email (password sign-up doesn't verify email).
    const attacker = await signup(email, newIp(), ATTACKER_PASSWORD);
    assert.equal(attacker.status, 201);
    const attackerCookie = cookieOf(attacker);
    assert.equal(await meStatus(attackerCookie), 200);

    // 2. The real owner signs in with Google (verified email) → accounts link.
    const owner = await findOrCreateGoogleUser({
      sub: `g-${randomUUID()}`, email: email.toUpperCase(), name: 'Owner', avatarUrl: 'https://example.com/a.png',
    });
    assert.equal(owner.id, attacker.body.user.id, 'same account (data is kept), not a new one');

    const row = await db.query.users.findFirst({ where: eq(users.id, owner.id) });
    assert.ok(row?.googleId, 'Google identity attached');
    assert.equal(row?.passwordHash, null, 'unverified password deleted');
    assert.equal(row?.sessionVersion, 2, 'session version bumped');

    // 3. The attacker's existing session is dead…
    assert.equal(await meStatus(attackerCookie), 401, 'old session revoked');
    // …and their password no longer works.
    const retry = await login(email, ATTACKER_PASSWORD);
    assert.equal(retry.status, 400);
    assert.equal(retry.body.error.message, 'This account uses Google sign-in');
    assert.equal(retry.cookie, null);

    // 4. The owner's Google session works, and the new version is already in the Redis cache.
    assert.equal(await meStatus(googleCookie(owner)), 200);
    assert.equal(await redis.get(`auth:sv:${owner.id}`), '2');

    // 5. Signing in with Google again changes nothing.
    const again = await findOrCreateGoogleUser({ sub: row!.googleId!, email, name: 'Owner', avatarUrl: null });
    assert.equal(again.id, owner.id);
    assert.equal(again.sessionVersion, 2);
    assert.equal((await db.select().from(users).where(eq(users.email, email))).length, 1);
  });

  test('a new Google identity creates a Google-only account', async () => {
    const email = newEmail('google-new');
    const u = await findOrCreateGoogleUser({ sub: `g-${randomUUID()}`, email, name: 'New', avatarUrl: null });
    const row = await db.query.users.findFirst({ where: eq(users.id, u.id) });
    assert.equal(row?.passwordHash, null);
    assert.ok(row?.googleId);
  });
});

describe('set password', () => {
  test('a Google-linked owner can set a new password; it works and every other session is revoked', async () => {
    const email = newEmail('reclaim');
    await signup(email, newIp(), 'attacker-chose-this');
    const owner = await googleUser(email); // links + wipes the attacker's password
    const otherDevice = googleCookie(owner);
    const thisDevice = googleCookie(owner);

    const res = await setPasswordReq(thisDevice, { password: 'owner-new-password' });
    assert.equal(res.status, 200);
    const refreshed = cookieOf(res);

    assert.equal(await meStatus(refreshed), 200, 'this device got a fresh cookie');
    assert.equal(await meStatus(otherDevice), 401, 'other sessions revoked');
    assert.equal(await meStatus(thisDevice), 401, 'the pre-change cookie is revoked too');

    assert.equal((await login(email, 'owner-new-password')).status, 200, 'new password works');
    assert.equal((await login(email, 'attacker-chose-this')).status, 401, 'attacker password still dead');
  });

  test('changing an existing password requires the current one', async () => {
    const email = newEmail('change');
    const cookie = cookieOf(await signup(email));

    const missing = await setPasswordReq(cookie, { password: 'brand-new-password' });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.message, 'Current password is required');

    const wrong = await setPasswordReq(cookie, { password: 'brand-new-password', currentPassword: 'nope-nope' });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.error.message, 'Current password is incorrect');
    assert.equal(await meStatus(cookie), 200, 'failed attempt changes nothing');

    const ok = await setPasswordReq(cookie, { password: 'brand-new-password', currentPassword: PASSWORD });
    assert.equal(ok.status, 200);
    assert.equal(await meStatus(cookie), 401, 'old session revoked');
    assert.equal((await login(email, PASSWORD)).status, 401);
    assert.equal((await login(email, 'brand-new-password')).status, 200);
  });

  test('enforces the password rules', async () => {
    const owner = await googleUser(newEmail('rules'));
    const res = await setPasswordReq(googleCookie(owner), { password: 'short' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.message, 'Password must be at least 8 characters');
  });

  test('a Google-only user with an old session must sign in again first', async () => {
    const owner = await googleUser(newEmail('stale'));
    const oldIat = Math.floor((Date.now() - RECENT_SIGN_IN_MS - 60_000) / 1000);
    const stale = `${SESSION_COOKIE}=${jwt.sign(
      { ...toPublicUser(owner), sv: owner.sessionVersion, iat: oldIat }, env.SESSION_SECRET, { expiresIn: '7d', subject: owner.id },
    )}`;
    assert.equal(await meStatus(stale), 200, 'the session itself is still valid');

    const res = await setPasswordReq(stale, { password: 'a-good-password' });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'REAUTH_REQUIRED');

    assert.equal((await setPasswordReq(googleCookie(owner), { password: 'a-good-password' })).status, 200);
  });

  test('requires a session', async () => {
    assert.equal((await post('/password', { password: 'whatever-123' }, newIp())).status, 401);
  });
});

describe('session revocation', () => {
  test('requireAuth checks the cached version (no DB read) and falls back to the DB on a miss', async () => {
    const owner = await googleUser(newEmail('cache'));
    const cookie = googleCookie(owner);
    const key = `auth:sv:${owner.id}`;

    assert.equal(await meStatus(cookie), 200);
    assert.equal(await redis.get(key), String(owner.sessionVersion), 'cache filled on first request');

    await redis.set(key, owner.sessionVersion + 1); // simulate a bump published by another instance
    assert.equal(await meStatus(cookie), 401, 'decision came from the cache');

    await redis.del(key); // cache miss → Postgres is the truth
    assert.equal(await meStatus(cookie), 200);
  });

  test('tokens without a session version (issued before versioning) are rejected', async () => {
    const owner = await googleUser(newEmail('legacy'));
    const legacy = `${SESSION_COOKIE}=${jwt.sign(toPublicUser(owner), env.SESSION_SECRET, { expiresIn: '7d', subject: owner.id })}`;
    assert.equal(await meStatus(legacy), 401);
  });
});

describe('GET /api/auth/account', () => {
  const account = async (cookie: string) => (await (await fetch(`${base}/api/auth/account`, { headers: { Cookie: cookie } })).json()) as any;

  test('reports the sign-in methods of the account', async () => {
    const pw = newEmail('acct-pw');
    const cookie = cookieOf(await signup(pw));
    assert.deepEqual(await account(cookie), { email: pw, hasPassword: true, hasGoogle: false });

    const g = await googleUser(newEmail('acct-g'));
    assert.deepEqual(await account(googleCookie(g)), { email: g.email, hasPassword: false, hasGoogle: true });

    await setPasswordReq(googleCookie(g), { password: 'a-good-password' });
    const refreshed = await findOrCreateGoogleUser({ sub: (await db.query.users.findFirst({ where: eq(users.id, g.id) }))!.googleId!, email: g.email, name: 'x', avatarUrl: null });
    assert.deepEqual(await account(googleCookie(refreshed)), { email: g.email, hasPassword: true, hasGoogle: true });
  });

  test('requires a session', async () => {
    assert.equal((await fetch(`${base}/api/auth/account`)).status, 401);
  });
});

describe('HTTP rate limit scope', () => {
  test('reading the session is not throttled like login attempts', async () => {
    const ip = newIp();
    const cookie = cookieOf(await signup(newEmail('scope'), ip));
    const statuses = await Promise.all(Array.from({ length: 40 }, () =>
      fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie, 'X-Forwarded-For': ip } }).then((r) => r.status)));
    assert.deepEqual([...new Set(statuses)], [200], '40 × GET /me from one IP all succeed');

    const logins = [];
    for (let i = 0; i < 31; i++) logins.push((await post('/login', { email: newEmail('scope-x'), password: 'x' }, ip)).status);
    assert.equal(logins.at(-1), 429, 'login attempts from the same IP are still capped');
  });
});
