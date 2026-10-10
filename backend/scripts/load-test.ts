/**
 * End-to-end load test: schedules one big campaign through the real HTTP API (as a
 * dedicated load-test user), then watches Postgres and checks the rate-limit guarantees.
 *
 *   npm run load-test                               1000 emails, 50/window, system min gap
 *   npm run load-test -- --count 200 --hourly 20 --delay 3000 --watch 120
 *
 * Needs the API and at least one worker running. For a quick demo use short windows:
 * RATE_WINDOW_MS=60000 in .env (restart api + worker) makes "hourly" limits per minute.
 *
 * Try killing and restarting the worker mid-run: nothing is lost or sent twice.
 */
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { env } from '../src/config/env';
import { db, pool } from '../src/lib/db';
import { redis } from '../src/lib/redis';
import { emailEvents, emails, users } from '../src/db/schema';
import { SESSION_COOKIE, signSession } from '../src/modules/auth/session';

const { values: args } = parseArgs({
  options: {
    count: { type: 'string', default: '1000' },
    hourly: { type: 'string', default: '50' },
    delay: { type: 'string', default: '0' },
    api: { type: 'string', default: `http://localhost:${env.PORT}` },
    watch: { type: 'string', default: '0' }, // seconds; 0 = until every email is final
  },
});

const count = Number(args.count);
const hourly = Number(args.hourly);
const delayMs = Number(args.delay);
const watchS = Number(args.watch);
const windowMs = env.RATE_WINDOW_MS;
const POLL_MS = 5000;

interface ScheduleResponse {
  campaign: { id: string; senderId: string; effective: { delayMs: number; hourlyLimit: number }; lastSendAt: string };
  warnings: string[];
}

async function main(): Promise<void> {
  const [user] = await db
    .insert(users)
    .values({ googleId: 'load-test', email: 'load-test@mailflow.local', name: 'Load Test' })
    .onConflictDoUpdate({ target: users.googleId, set: { name: 'Load Test' } })
    .returning();
  const cookie = `${SESSION_COOKIE}=${signSession(user)}`;

  const recipients = Array.from({ length: count }, (_, i) => `lead${i + 1}+${Date.now()}@example.com`);
  const t0 = Date.now();
  const res = await fetch(`${args.api}/api/emails/schedule`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({
      subject: `Load test ${new Date().toISOString()}`,
      body: 'Hello from the MailFlow load test.',
      recipients,
      startAt: new Date().toISOString(),
      delayMs,
      hourlyLimit: hourly,
    }),
  });
  if (!res.ok) throw new Error(`schedule failed: ${res.status} ${await res.text()}`);
  const { campaign, warnings } = (await res.json()) as ScheduleResponse;
  const { hourlyLimit: limit, delayMs: gap } = campaign.effective;

  console.log(`\nScheduled ${count} emails in ${Date.now() - t0} ms  (campaign ${campaign.id})`);
  console.log(`Effective limits: ${limit} per ${windowMs / 1000}s window, min gap ${gap} ms`);
  console.log(`Planned last send: ${campaign.lastSendAt}`);
  for (const w of warnings) console.log(`  warning: ${w}`);
  if (windowMs >= 3_600_000 && count > limit) {
    console.log(`  note: with 1h windows this takes ~${Math.ceil(count / limit)} hours. Set RATE_WINDOW_MS=60000 for a demo.`);
  }
  console.log('\nWatching (Ctrl+C to stop and print the report)...\n');

  let stop = false;
  process.once('SIGINT', () => { stop = true; });
  const deadline = watchS > 0 ? Date.now() + watchS * 1000 : Infinity;

  while (!stop && Date.now() < deadline) {
    const by = await statusCounts(campaign.id);
    const pending = (by.SCHEDULED ?? 0) + (by.PROCESSING ?? 0) + (by.SENDING ?? 0);
    console.log(`${new Date().toISOString().slice(11, 19)}  ${Object.entries(by).map(([k, v]) => `${k}=${v}`).join('  ')}`);
    if (pending === 0) break;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  if (!(await report(campaign.id, campaign.senderId, limit, gap))) {
    console.log('\n❌ rate-limit guarantee violated');
    process.exitCode = 1;
  }
}

async function statusCounts(campaignId: string): Promise<Record<string, number>> {
  const rows = await db
    .select({ status: emails.status, n: sql<number>`count(*)::int` })
    .from(emails)
    .where(eq(emails.campaignId, campaignId))
    .groupBy(emails.status);
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

/** Prints the report; returns false if any rate-limit guarantee was violated. */
async function report(campaignId: string, senderId: string, limit: number, gap: number): Promise<boolean> {
  const perWindow = await db
    .select({
      window: sql<number>`floor(extract(epoch from (${emailEvents.detail}->>'slotAt')::timestamptz) * 1000 / ${windowMs})::bigint`,
      n: sql<number>`count(*)::int`,
    })
    .from(emailEvents)
    .innerJoin(emails, eq(emails.id, emailEvents.emailId))
    .where(and(eq(emails.campaignId, campaignId), eq(emailEvents.type, 'SENT'), sql`${emailEvents.detail} ? 'slotAt'`))
    .groupBy(sql`1`)
    .orderBy(sql`1`);

  // SENT events record the reserved slot (worker clock) and the gated SMTP start (Redis
  // clock); each is compared only with itself. Gaps span every campaign on this sender
  // created since this run started: limits are per sender, not per campaign.
  const [t] = await db.execute<{
    minSlotGap: number | null; minStartGap: number | null; avgSmtpMs: number | null; maxSmtpMs: number | null;
  }>(sql`
    with s as (
      select (e.detail->>'slotAt')::timestamptz as slot, (e.detail->>'smtpStartedAt')::timestamptz as started,
             (e.detail->>'smtpMs')::int as smtp_ms
      from email_events e
      join emails m on m.id = e.email_id
      join campaigns c on c.id = m.campaign_id
      where m.sender_id = ${senderId} and e.type = 'SENT' and e.detail ? 'slotAt'
        and c.created_at >= (select created_at from campaigns where id = ${campaignId})
    )
    select
      (select min(extract(epoch from slot - lag) * 1000)::int
         from (select slot, lag(slot) over (order by slot) from s) x) as "minSlotGap",
      (select min(extract(epoch from started - lag) * 1000)::int
         from (select started, lag(started) over (order by started) from s) x) as "minStartGap",
      (select avg(smtp_ms)::int from s) as "avgSmtpMs",
      (select max(smtp_ms) from s) as "maxSmtpMs"`).then((r) => r.rows);

  const by = await statusCounts(campaignId);
  const maxPerWindow = Math.max(0, ...perWindow.map((w) => w.n));
  const ok = (cond: boolean) => (cond ? '✅' : '⚠');

  console.log('\n──────── Report ────────');
  console.log('Status:', by);
  console.log('Sent per window (by reserved slot):');
  for (const w of perWindow) {
    console.log(`  ${new Date(Number(w.window) * windowMs).toISOString()}  ${String(w.n).padStart(5)}  ${w.n > limit ? '⚠ over limit' : ''}`);
  }
  const checks = {
    window: maxPerWindow <= limit,
    slotGap: t.minSlotGap === null || t.minSlotGap >= gap,
    startGap: t.minStartGap === null || t.minStartGap >= gap,
  };
  console.log(`Max per window:              ${maxPerWindow} (limit ${limit})  ${ok(checks.window)}`);
  console.log(`Min gap between slots:       ${t.minSlotGap ?? '-'} ms (min ${gap})  ${ok(checks.slotGap)}`);
  console.log(`Min gap between SMTP starts: ${t.minStartGap ?? '-'} ms (min ${gap})  ${ok(checks.startGap)}`);
  console.log(`SMTP duration:               avg ${t.avgSmtpMs ?? '-'} ms, max ${t.maxSmtpMs ?? '-'} ms`);
  return Object.values(checks).every(Boolean);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => Promise.allSettled([pool.end(), redis.quit()]).then(() => process.exit()));
