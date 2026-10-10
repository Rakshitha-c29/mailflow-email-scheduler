/**
 * Removes leftovers of tests and test tools from the app's real data. Nothing else.
 *
 *   npm run cleanup:test-leftovers                          # dry run: prints what it would remove
 *   npm run cleanup:test-leftovers -- --apply               # removes it
 *   npm run cleanup:test-leftovers -- --load-test [--apply] # also the load-test account (npm run load-test)
 *
 * What counts as a leftover:
 *   - accounts made by the browser sign-up test: e2e-…@example.com (with their senders);
 *   - with --load-test: the account load-test@mailflow.local, its emails and all their jobs;
 *   - queue jobs whose email (email-send, search-index) or user (slack-notify) no longer
 *     exists, once the accounts above are gone;
 *   - rate-limit keys of senders that no longer exist;
 *   - search documents whose email no longer exists.
 *
 * Never touched: any other account and its emails, jobs of existing emails, active jobs.
 */
import { inArray, like, or, eq } from 'drizzle-orm';
import type { Job, Queue } from 'bullmq';
import { db, pool } from '../src/lib/db';
import { redis } from '../src/lib/redis';
import { es, ES_INDEX } from '../src/lib/elastic';
import { emails, senders, users } from '../src/db/schema';
import { closeQueues, emailQueue, indexQueue, notifyQueue } from '../src/queues';

const APPLY = process.argv.includes('--apply');
const LOAD_TEST = process.argv.includes('--load-test');
const E2E_PATTERN = 'e2e-%@example.com';
const LOAD_TEST_EMAIL = 'load-test@mailflow.local';
const STATES = ['waiting', 'delayed', 'completed', 'failed', 'paused', 'prioritized'] as const; // never 'active'

async function allJobs(q: Queue): Promise<Job[]> {
  const out: Job[] = [];
  for (let start = 0; ; start += 1000) {
    const page = await q.getJobs([...STATES], start, start + 999, true);
    out.push(...page.filter(Boolean));
    if (page.length < 1000) return out;
  }
}

async function scanKeys(pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 1000);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== '0');
  return keys;
}

async function allSearchDocIds(): Promise<string[]> {
  if (!(await es.indices.exists({ index: ES_INDEX }))) return [];
  const ids: string[] = [];
  let res = await es.search({ index: ES_INDEX, scroll: '1m', size: 5000, _source: false, query: { match_all: {} } });
  while (res.hits.hits.length) {
    ids.push(...res.hits.hits.map((h) => h._id!));
    res = await es.scroll({ scroll_id: res._scroll_id!, scroll: '1m' });
  }
  if (res._scroll_id) await es.clearScroll({ scroll_id: res._scroll_id }).catch(() => undefined);
  return ids;
}

const byState = async (jobs: Job[]) => {
  const counts: Record<string, number> = {};
  for (const j of jobs) { const s = await j.getState(); counts[s] = (counts[s] ?? 0) + 1; }
  return Object.entries(counts).map(([s, n]) => `${n} ${s}`).join(', ') || 'none';
};

(async () => {
  // ── The plan (identical for dry run and --apply) ──
  const doomedUsers = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(LOAD_TEST ? or(like(users.email, E2E_PATTERN), eq(users.email, LOAD_TEST_EMAIL)) : like(users.email, E2E_PATTERN));
  const doomedUserIds = new Set(doomedUsers.map((u) => u.id));
  const allUsers = await db.select({ id: users.id, email: users.email }).from(users);
  const keptUsers = allUsers.filter((u) => !doomedUserIds.has(u.id));

  const allEmails = await db.select({ id: emails.id, userId: emails.userId }).from(emails);
  const keptEmailIds = new Set(allEmails.filter((e) => !doomedUserIds.has(e.userId)).map((e) => e.id));
  const doomedEmailCount = allEmails.length - keptEmailIds.size;
  const allSenders = await db.select({ id: senders.id, userId: senders.userId }).from(senders);
  const keptSenderIds = new Set(allSenders.filter((s) => !doomedUserIds.has(s.userId)).map((s) => s.id));
  const doomedSenderCount = allSenders.length - keptSenderIds.size;
  const keptUserIds = new Set(keptUsers.map((u) => u.id));

  const emailJobs = (await allJobs(emailQueue)).filter((j) => !keptEmailIds.has(j.data?.emailId ?? j.id!));
  const indexJobs = (await allJobs(indexQueue)).filter((j) => !(j.data?.emailIds ?? []).some((id: string) => keptEmailIds.has(id)));
  const notifyJobs = (await allJobs(notifyQueue)).filter((j) => !keptUserIds.has(j.data?.userId));
  const rateKeys = (await scanKeys('rl:{*')).filter((k) => !keptSenderIds.has(k.slice(4, k.indexOf('}'))));
  const docIds = (await allSearchDocIds()).filter((id) => !keptEmailIds.has(id));

  const e2eUsers = doomedUsers.filter((u) => u.email !== LOAD_TEST_EMAIL);
  console.log(APPLY ? '── Removing test leftovers ──' : '── DRY RUN: nothing is removed (add --apply) ──');
  console.log(`Postgres  accounts e2e-…@example.com: ${e2eUsers.length}`);
  if (LOAD_TEST) console.log(`Postgres  account ${LOAD_TEST_EMAIL}: ${doomedUsers.length - e2eUsers.length}`);
  console.log(`          → with their senders: ${doomedSenderCount}, emails: ${doomedEmailCount} (and their campaigns, events, attachments)`);
  console.log(`Redis     email-send jobs without an email: ${emailJobs.length} (${await byState(emailJobs)})`);
  console.log(`Redis     search-index jobs whose emails are all gone: ${indexJobs.length} (${await byState(indexJobs)})`);
  console.log(`Redis     slack-notify jobs of removed users: ${notifyJobs.length} (${await byState(notifyJobs)})`);
  console.log(`Redis     rate-limit keys of removed senders: ${rateKeys.length}`);
  console.log(`Search    documents without an email: ${docIds.length}`);
  console.log(`Kept      accounts: ${keptUsers.map((u) => u.email).join(', ')} (${keptEmailIds.size} emails)`);

  if (APPLY) {
    // Jobs first (while their emails still exist nothing picks them up: removing is the point).
    let removed = 0;
    for (const j of [...emailJobs, ...indexJobs, ...notifyJobs]) {
      try { await j.remove(); removed++; } catch { /* became active or was removed meanwhile: leave it */ }
    }
    if (doomedUserIds.size) await db.delete(users).where(inArray(users.id, [...doomedUserIds])); // cascades
    for (let i = 0; i < rateKeys.length; i += 500) await redis.del(...rateKeys.slice(i, i + 500));
    for (let i = 0; i < docIds.length; i += 1000) {
      await es.bulk({ refresh: true, operations: docIds.slice(i, i + 1000).map((id) => ({ delete: { _index: ES_INDEX, _id: id } })) });
    }
    console.log(`Done: removed ${doomedUsers.length} accounts, ${removed} jobs, ${rateKeys.length} keys, ${docIds.length} search documents.`);
  }

  await closeQueues();
  await Promise.allSettled([redis.quit(), pool.end()]);
})().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
