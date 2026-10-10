/**
 * Demo data matching the designs:  npm run seed:demo
 *
 * Creates (or resets) the account oliver.brown@domain.io with:
 *   - 2 scheduled emails (next Tue 9:15:12 AM, next Thu 8:15:12 PM), created through the
 *     real scheduling path, so they have queue jobs and the worker will send them then;
 *   - 3 sent emails (the Sent tab + email detail designs), one with a PDF attachment.
 * Safe to run repeatedly: the account's previous campaigns, queue jobs and search
 * documents are removed first. Needs the docker services, and internet access the first
 * time (Ethereal mailboxes are provisioned for the account).
 *
 * Local development only: refuses to run when NODE_ENV=production (the password is public).
 */
import './lib/refuseInProduction'; // must be the first import: stops before anything connects
import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { db, pool } from '../src/lib/db';
import { redis } from '../src/lib/redis';
import { es, ES_INDEX } from '../src/lib/elastic';
import { logger } from '../src/lib/logger';
import { attachments, campaigns, emails, users } from '../src/db/schema';
import { closeQueues } from '../src/queues';
import { runMigrations } from '../src/db/migrate';
import { removeEmailJobs } from './lib/removeEmailJobs';
import { ensureSenders, listSenders } from '../src/modules/senders/sender.service';
import { scheduleCampaign } from '../src/modules/emails/email.service';
import { ensureIndex, indexEmails } from '../src/modules/search/search.service';
import { validateAttachments } from '../src/modules/attachments/attachment.service';

const EMAIL = 'oliver.brown@domain.io';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'oliver-demo-password';

const DETAIL_BODY = `<p>Hey Oliver,</p>
<p>You've just RECEIVED something</p>
<div style="display:inline-block;background:#fefce8;border-left:3px solid #fdc700;padding:10px 16px;border-radius:4px;margin-bottom:20px">
  <p style="margin:0 0 6px"><b>⚡ Extremely Exclusive—Only 4 Spots Worldwide Per Year | $25,000 investment ⚡</b></p>
  <p style="margin:0">⚡ To explore securing your private transformation, simply reply right now with <b>"FLY OUT FIX"</b>.</p>
</div>
<p>Your coach for world-class performance,</p>
<p>Grant</p>
<p><i style="color:#4b5563">P.S. Always remember that you can develop world class technique! 🚀</i></p>`;

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');

/** Next given weekday (0 = Sunday) at h:m:s local time, at least one day ahead. */
function next(weekday: number, h: number, m: number, s: number): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  while (d.getDay() !== weekday) d.setDate(d.getDate() + 1);
  d.setHours(h, m, s, 0);
  return d.toISOString();
}

async function main(): Promise<void> {
  await runMigrations();

  // Account (password sign-in; the demo password is (re)set every run).
  const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  const [user] = await db
    .insert(users)
    .values({ email: EMAIL, name: 'Oliver Brown', passwordHash })
    .onConflictDoUpdate({ target: users.email, set: { passwordHash, name: 'Oliver Brown' } })
    .returning();
  await ensureSenders(user.id);
  const [sender] = await listSenders(user.id);

  // Reset: queue jobs of still-scheduled emails, search documents, then the rows.
  const old = await db.select({ id: emails.id }).from(emails).where(eq(emails.userId, user.id));
  await removeEmailJobs(old.map((e) => e.id));
  await es.deleteByQuery({ index: ES_INDEX, query: { term: { userId: user.id } }, refresh: true }).catch(() => undefined);
  await db.delete(campaigns).where(eq(campaigns.userId, user.id));

  // Scheduled tab: through the real scheduling path (rows + delayed jobs).
  for (const c of [
    { to: 'john.smith@example.com', subject: 'Meeting follow-up - Scheduled', at: next(2, 9, 15, 12),
      body: '<p>Hi John, just wanted to follow up on our meeting last week and share the notes.</p>' },
    { to: 'olive@example.com', subject: "Ramit, great to meet you - you'll love it", at: next(4, 20, 15, 12),
      body: '<p>Hi Olive, just wanted to follow up on our meeting and introduce you to Ramit.</p>' },
  ]) {
    await scheduleCampaign(user.id, {
      subject: c.subject, body: c.body, recipients: [c.to], startAt: c.at, delayMs: 2000, hourlyLimit: 100, senderId: sender.id,
    });
  }

  // Sent tab + detail: history, inserted directly (no jobs; these are "already sent").
  const sent = [
    { to: 'sarah.wilson@example.com', subject: 'Re: Project Update', body: '<p>Thanks for the update, Sarah. Looks good!</p>', ago: 1 },
    { to: 'support@example.com', subject: 'Issue with login', body: '<p>I am having trouble logging in to the dashboard and keep seeing an error after the redirect.</p>', ago: 2 },
    { to: 'oliver@example.com', subject: 'Oliver, hello there! | MJWYT44 BM#52W01', body: DETAIL_BODY, ago: 3, files: [{ originalname: 'Q3 report.pdf', buffer: PDF }] },
  ];
  for (const s of sent) {
    const when = new Date(Date.now() - s.ago * 3_600_000);
    const [c] = await db.insert(campaigns).values({
      userId: user.id, senderId: sender.id, subject: s.subject, body: s.body, startAt: when, delayMs: 2000, hourlyLimit: 100, totalCount: 1,
    }).returning();
    await db.insert(emails).values({
      campaignId: c.id, userId: user.id, senderId: sender.id, toEmail: s.to, subject: s.subject,
      status: 'SENT', scheduledAt: when, sentAt: when, attempts: 1,
    });
    if (s.files) {
      const files = validateAttachments(s.files);
      await db.insert(attachments).values(files.map((a, position) => ({ ...a, position, campaignId: c.id, userId: user.id })));
    }
  }

  await ensureIndex();
  const all = await db.select({ id: emails.id }).from(emails).where(eq(emails.userId, user.id));
  await indexEmails(all.map((e) => e.id));
  await es.indices.refresh({ index: ES_INDEX });

  logger.info({ email: EMAIL, password: PASSWORD, scheduled: 2, sent: sent.length }, '✅ demo account ready');
}

main()
  .catch((err) => { logger.error({ err }, 'seeding failed'); process.exitCode = 1; })
  .finally(() => Promise.allSettled([closeQueues(), redis.quit(), pool.end(), es.close()]));
