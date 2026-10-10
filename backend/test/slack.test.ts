/**
 * Slack integration through the HTTP API. Slack's OAuth endpoints are faked (fetch is
 * intercepted for slack.com); the incoming webhook is a real local HTTP server.
 */
import './helpers/slackEnv'; // must be the first import
import { after, before, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq, like } from 'drizzle-orm';
import { db, pool } from '../src/lib/db';
import { redis } from '../src/lib/redis';
import { decrypt } from '../src/lib/crypto';
import { slackIntegrations, users } from '../src/db/schema';
import { closeQueues } from '../src/queues';
import { createApp } from '../src/app';
import { runMigrations } from '../src/db/migrate';
import { SESSION_COOKIE, signSession } from '../src/modules/auth/session';
import { env } from '../src/config/env';
import { processNotifyJob } from '../src/workers/notification.processor';
import { TEST_MESSAGE, limitName, rateLimitAlert, windowLabel } from '../src/modules/slack/messages';

const DOMAIN = `slack-test-${randomUUID().slice(0, 8)}.local`;
let app: Server;
let base: string;
let hook: Server;
let hookUrl: string;
const hookCalls: { path: string; body: any }[] = [];
let hookReply: { status: number; text: string } = { status: 200, text: 'ok' };
const slackApiCalls: string[] = [];
let cookie: string;
let userId: string;

before(async () => {
  await runMigrations();
  const [u] = await db.insert(users).values({ googleId: `g-${randomUUID()}`, email: `owner@${DOMAIN}`, name: 'Owner' }).returning();
  userId = u.id;
  cookie = `${SESSION_COOKIE}=${signSession(u)}`;

  // The "Slack" incoming webhook.
  hook = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      hookCalls.push({ path: req.url ?? '', body: JSON.parse(data || '{}') });
      res.writeHead(hookReply.status).end(hookReply.text);
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => hook.once('listening', r));
  hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/services/T1/B1/secret`;

  // Fake slack.com; everything else (the app, the webhook) goes through the real fetch.
  const realFetch = globalThis.fetch;
  mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://slack.com/api/')) {
      slackApiCalls.push(url);
      if (url.endsWith('/oauth.v2.access')) {
        const code = new URLSearchParams(String(init?.body)).get('code');
        return Response.json(code === 'good-code'
          ? { ok: true, access_token: 'xoxb-test', team: { id: 'T1', name: 'Acme' }, incoming_webhook: { url: hookUrl, channel: '#outreach', channel_id: 'C1' } }
          : { ok: false, error: 'invalid_code' });
      }
      return Response.json({ ok: true });
    }
    return realFetch(input, init);
  });

  app = createApp().listen(0);
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});

after(async () => {
  mock.restoreAll();
  await db.delete(users).where(like(users.email, `%@${DOMAIN}`));
  app.close();
  hook.close();
  await closeQueues();
  await Promise.allSettled([redis.quit(), pool.end()]);
});

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${base}/api/integrations/slack${path}`, { redirect: 'manual', ...init, headers: { Cookie: cookie, ...(init.headers ?? {}) } });
const status = async () => (await (await api('')).json()) as any;

describe('Slack integration', () => {
  test('status starts disconnected', async () => {
    assert.deepEqual(await status(), { enabled: true, connected: false, status: null, teamName: null, channelName: null });
  });

  test('install redirects to Slack with a one-time state', async () => {
    const r = await api('/install');
    assert.equal(r.status, 302);
    const url = new URL(r.headers.get('location')!);
    assert.equal(url.origin + url.pathname, 'https://slack.com/oauth/v2/authorize');
    assert.equal(url.searchParams.get('client_id'), 'test-client-id');
    assert.equal(url.searchParams.get('scope'), 'incoming-webhook');
    assert.equal(url.searchParams.get('redirect_uri'), process.env.SLACK_REDIRECT_URI);
    assert.equal(await redis.get(`slack:oauth:${url.searchParams.get('state')}`), userId, 'state maps to the user');
  });

  test('callback outcomes redirect to the dashboard with ?slack=cancelled|error', async () => {
    const back = (r: Response) => new URL(r.headers.get('location')!);
    const cancelled = await api('/callback?error=access_denied&state=x');
    assert.equal(back(cancelled).search, '?slack=cancelled');
    assert.equal(back(cancelled).origin + back(cancelled).pathname, `${env.FRONTEND_URL}/dashboard`);
    assert.equal(back(await api('/callback?code=good-code&state=unknown-state')).search, '?slack=error', 'unknown/expired state');

    const state = new URL((await api('/install')).headers.get('location')!).searchParams.get('state')!;
    assert.equal(back(await api(`/callback?code=bad-code&state=${state}`)).search, '?slack=error', 'Slack refused the code');
  });

  test('a successful callback connects; the state is single-use', async () => {
    const state = new URL((await api('/install')).headers.get('location')!).searchParams.get('state')!;
    const r = await api(`/callback?code=good-code&state=${state}`);
    assert.equal(new URL(r.headers.get('location')!).search, '?slack=connected');
    assert.deepEqual(await status(), { enabled: true, connected: true, status: 'CONNECTED', teamName: 'Acme', channelName: '#outreach' });

    const row = await db.query.slackIntegrations.findFirst({ where: eq(slackIntegrations.userId, userId) });
    assert.notEqual(row?.webhookUrlEnc, hookUrl, 'webhook URL is encrypted at rest');
    assert.equal(decrypt(row!.webhookUrlEnc), hookUrl);

    const replay = await api(`/callback?code=good-code&state=${state}`);
    assert.equal(new URL(replay.headers.get('location')!).search, '?slack=error', 'state cannot be reused');
  });

  test('"Send test message" posts to the channel webhook', async () => {
    hookCalls.length = 0;
    const r = await api('/test', { method: 'POST' });
    assert.equal(r.status, 200);
    assert.equal(hookCalls.length, 1);
    assert.match(hookCalls[0].body.text, /MailFlow is connected/);
  });

  test('a webhook Slack has removed marks the integration REVOKED', async () => {
    hookReply = { status: 404, text: 'no_service' };
    const r = await api('/test', { method: 'POST' });
    assert.equal(r.status, 409);
    assert.equal(((await r.json()) as any).error.code, 'SLACK_NOT_CONNECTED');
    const s = await status();
    assert.equal(s.connected, false);
    assert.equal(s.status, 'REVOKED');
    hookReply = { status: 200, text: 'ok' };
  });

  test('disconnect removes the integration (and revokes the token at Slack)', async () => {
    slackApiCalls.length = 0;
    const r = await api('', { method: 'DELETE' });
    assert.equal(r.status, 204);
    assert.deepEqual(slackApiCalls, ['https://slack.com/api/auth.revoke']);
    assert.equal((await status()).status, null);
  });

  test('requires a session', async () => {
    const r = await fetch(`${base}/api/integrations/slack`);
    assert.equal(r.status, 401);
  });
});

describe('rate-limit alert (worker side)', () => {
  const job = (limit: number) => ({ id: `n-${limit}`, data: { kind: 'RATE_LIMIT_HIT', userId, senderId: randomUUID(), window: 1, limit } }) as any;

  test('not connected → skipped quietly (no crash, nothing sent)', async () => {
    assert.equal((await status()).connected, false);
    hookCalls.length = 0;
    await processNotifyJob(job(7)); // resolves: no throw means the job completes, no retries
    assert.equal(hookCalls.length, 0);
  });

  test('connecting later makes alerts work immediately (no restart/redeploy)', async () => {
    const state = new URL((await api('/install')).headers.get('location')!).searchParams.get('state')!;
    await api(`/callback?code=good-code&state=${state}`);
    hookCalls.length = 0;
    await processNotifyJob(job(10));
    assert.equal(hookCalls.length, 1);
    const msg = hookCalls[0].body;
    // Follows the configured window; a shortened (demo) window says so.
    const title = `⚠️ ${limitName(env.RATE_WINDOW_MS)} limit reached${env.RATE_WINDOW_MS === 3_600_000 ? '' : ' (demo mode)'}`;
    assert.ok(msg.text.startsWith(title)); // notification fallback
    assert.match(msg.text, /limit of \*10\*/);
    const [header, , details, actions] = msg.blocks;
    assert.equal(header.type, 'header');
    assert.equal(header.text.text, title);
    const fields = details.fields.map((f: { text: string }) => f.text).join('\n');
    for (const label of ['*Sender*', '*Limit*\n10 emails per', '*Current window*', '*Waiting for a later', '\n0 emails', '*Sending resumes*']) {
      assert.ok(fields.includes(label), `field ${label}`);
    }
    assert.equal(actions.elements[0].url, `${env.FRONTEND_URL}/dashboard`);
    await api('', { method: 'DELETE' });
  });
});

describe('Slack message layout', () => {
  const input = {
    senderName: 'Oliver Brown', senderEmail: 'oliver@ethereal.email', limit: 200,
    windowStartMs: Date.UTC(2026, 8, 27, 14), windowEndMs: Date.UTC(2026, 8, 27, 15), windowMs: 3_600_000,
    waiting: 1234, dashboardUrl: 'http://localhost:5173/dashboard',
  };

  test('window length in words', () => {
    assert.equal(windowLabel(3_600_000), 'hour');
    assert.equal(windowLabel(7_200_000), '2 hours');
    assert.equal(windowLabel(60_000), 'minute');
    assert.equal(windowLabel(900_000), '15 minutes');
  });

  test('the title names the real window length', () => {
    assert.equal(limitName(3_600_000), 'Hourly');
    assert.equal(limitName(60_000), 'Per-minute');
    assert.equal(limitName(900_000), '15-minute');
    assert.equal(limitName(7_200_000), '2-hour');
  });

  test('demo mode (window ≠ 1 hour) is labelled; the default 1-hour window is not', () => {
    const demo = rateLimitAlert({ ...input, windowMs: 60_000 });
    assert.equal(demo.blocks[0].text!.text, '⚠️ Per-minute limit reached (demo mode)');
    assert.equal(demo.blocks[2].fields![1].text, '*Limit*\n200 emails per minute (demo mode)');
    assert.ok(demo.text.startsWith('⚠️ Per-minute limit reached (demo mode):'), 'notification text too');

    const hourly = rateLimitAlert(input);
    assert.equal(hourly.blocks[0].text!.text, '⚠️ Hourly limit reached');
    assert.equal(hourly.blocks[2].fields![1].text, '*Limit*\n200 emails per hour');
    assert.doesNotMatch(JSON.stringify(hourly), /demo/i);
  });

  test('rate-limit alert: header, five fields, dashboard button, fallback text', () => {
    const m = rateLimitAlert(input);
    assert.deepEqual(m.blocks.map((b) => b.type), ['header', 'section', 'section', 'actions', 'context']);
    const fields = (m.blocks[2] as { fields: { text: string }[] }).fields.map((f) => f.text);
    assert.deepEqual(fields.map((f) => f.split('\n')[0]), ['*Sender*', '*Limit*', '*Current window*', '*Waiting for a later hour*', '*Sending resumes*']);
    assert.equal(fields[0], '*Sender*\nOliver Brown (oliver@ethereal.email)');
    assert.equal(fields[1], '*Limit*\n200 emails per hour');
    assert.equal(fields[3], '*Waiting for a later hour*\n1,234 emails');
    assert.equal(rateLimitAlert({ ...input, waiting: 1 }).blocks[2].fields![3].text, '*Waiting for a later hour*\n1 email');
    assert.ok(fields[4].includes(`<!date^${input.windowEndMs / 1000}^`)); // resumes when the window ends
    assert.match(m.text, /oliver@ethereal\.email hit its limit of \*200\* emails per hour\. 1,234 emails waiting for a later hour/);
  });

  test('no duplicate name when the sender has none, and an unknown sender still renders', () => {
    const same = rateLimitAlert({ ...input, senderName: 'oliver@ethereal.email' });
    assert.equal((same.blocks[2] as { fields: { text: string }[] }).fields[0].text, '*Sender*\noliver@ethereal.email');
    const unknown = rateLimitAlert({ ...input, senderName: null, senderEmail: null });
    assert.match(unknown.text, /Unknown sender/);
    const tricky = rateLimitAlert({ ...input, senderName: 'A <b> & C' });
    assert.match(JSON.stringify(tricky.blocks), /A &lt;b&gt; &amp; C/); // no accidental Slack links or mentions
  });

  test('test message stays one short line', () => {
    assert.ok(!TEST_MESSAGE.text.includes('\n') && TEST_MESSAGE.text.length < 80);
  });

  test('interactions endpoint answers 200 (the button click)', async () => {
    const r = await fetch(`${base}/api/integrations/slack/interactions`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'payload=%7B%7D',
    });
    assert.equal(r.status, 200);
  });
});
