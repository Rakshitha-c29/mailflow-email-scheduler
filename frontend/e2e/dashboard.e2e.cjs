/**
 * Browser end-to-end: dashboard. Run with `npm run e2e` (see e2e/README.md).
 */
const { BASE, ES_URL, SHOTS, FIXTURES, DEMO, launch, psql, deleteCampaigns, resetAuthCounters, log, assert, finish } = require('./lib.cjs');
const path = require('path');
const EMAIL = DEMO.email;
const PASS = DEMO.password;

/** Next given weekday (0=Sun) at h:m:s local time, at least a day ahead. */
function next(weekday, h, m, s) {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  while (d.getDay() !== weekday) d.setDate(d.getDate() + 1);
  d.setHours(h, m, s, 0);
  return d.toISOString();
}

(async () => {
  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const shot = (n) => page.screenshot({ path: path.join(SHOTS, n + '.png') });
  const rows = () => page.locator('main li:not([aria-hidden])');

  resetAuthCounters();

  // ── Seed through the real API (same session cookie as the browser) ──
  let r = await page.request.post(BASE + '/api/auth/login', { data: { email: EMAIL, password: PASS } });
  if (r.status() === 401) r = await page.request.post(BASE + '/api/auth/signup', { data: { name: 'Oliver Brown', email: EMAIL, password: PASS } });
  assert(r.ok(), `signed in as ${EMAIL} (${r.status()})`);
  const userId = (await r.json()).user.id;

  deleteCampaigns(`c.user_id = '${userId}'`); // idempotent reruns (their queue jobs go too)
  // Direct SQL bypasses the app, so drop this user's search docs too.
  await page.request.post(ES_URL + '/emails/_delete_by_query?refresh=true', { data: { query: { term: { userId } } } });
  for (const c of [
    { to: 'john.smith@example.com', subject: 'Meeting follow-up - Scheduled', body: 'Hi John, just wanted to follow up on our meeting last week and share the notes.', at: next(2, 9, 15, 12) },
    { to: 'olive@example.com', subject: 'Ramit, great to meet you - you\'ll love it', body: 'Hi Olive, just wanted to follow up on our meeting and introduce you to Ramit.', at: next(4, 20, 15, 12) },
  ]) {
    const s = await page.request.post(BASE + '/api/emails/schedule', {
      data: { subject: c.subject, body: c.body, recipients: [c.to], startAt: c.at, delayMs: 2000, hourlyLimit: 100 },
    });
    assert(s.status() === 201, `scheduled "${c.subject}"`);
  }
  // Sent-tab rows (inserted directly: no jobs, nothing is sent).
  const [campaignId, senderId] = psql(`select id, sender_id from campaigns where user_id = '${userId}' limit 1`).split('|');
  const add = (to, status, extra = '') => psql(`insert into emails (campaign_id, user_id, sender_id, to_email, subject, status, scheduled_at ${extra ? ', sent_at, preview_url' : ''}) values ('${campaignId}', '${userId}', '${senderId}', '${to}', 'Quick question about Q3', '${status}', now() - interval '2 hours' ${extra})`);
  add('ana@example.com', 'SENT', ", now() - interval '1 hour', 'https://ethereal.email/message/demo'");
  // Sending started 3 s before the server accepted it (a slow server, like Ethereal).
  const anaStarted = psql(`update emails set send_started_at = sent_at - interval '3 seconds' where campaign_id = '${campaignId}' and to_email = 'ana@example.com'
    returning to_char(send_started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);
  add('bob@example.com', 'FAILED');
  add('cara@example.com', 'UNCERTAIN');

  // ── Scheduled tab ──
  await page.goto(BASE + '/dashboard');
  await page.waitForSelector('text=Meeting follow-up - Scheduled');
  assert((await rows().count()) === 2, '2 scheduled rows');
  const nav = (name) => page.getByRole('link', { name: new RegExp(`^${name}`) });
  assert((await nav('Scheduled').textContent()).endsWith('2'), 'Scheduled count = 2');
  assert((await nav('Sent').textContent()).endsWith('3'), 'Sent count = 3 (sent + failed + uncertain)');
  const first = await rows().first().textContent();
  assert(first.includes('To: john.smith@example.com') && first.includes('Tue 9:15:12 AM'), 'pill shows "Tue 9:15:12 AM"');
  assert(first.includes('- Hi John, just wanted to follow up'), 'preview snippet shown');
  assert((await rows().nth(1).textContent()).includes('Thu 8:15:12 PM'), 'second row "Thu 8:15:12 PM"');
  // Status next to the time: a grey chip in the Sent pill's style.
  const chipOf = (i) => rows().nth(i).locator('span.rounded-full.bg-gray-100');
  assert((await chipOf(0).textContent()) === 'Scheduled' && (await chipOf(1).textContent()) === 'Scheduled',
    'each scheduled row shows the status chip "Scheduled"');
  assert(await rows().first().locator('span.bg-orange-100', { hasText: 'Tue 9:15:12 AM' }).isVisible(), 'the orange time pill is unchanged');

  // While an email is being sent: time pill stays, chip says "Sending".
  await page.route('**/api/emails?*view=scheduled*', async (route) => {
    const res = await route.fetch();
    const json = await res.json();
    json.items[0] = { ...json.items[0], status: 'SENDING' };
    await route.fulfill({ response: res, json });
  });
  await page.reload();
  await page.waitForSelector('text=Meeting follow-up - Scheduled');
  assert((await chipOf(0).textContent()) === 'Sending', 'an email being sent shows "Sending"');
  assert(await rows().first().locator('span.bg-orange-100', { hasText: 'Tue 9:15:12 AM' }).isVisible(), '...and keeps its time pill');
  await page.unroute('**/api/emails?*view=scheduled*');
  await page.reload();
  await page.waitForSelector('text=Meeting follow-up - Scheduled');
  await page.mouse.move(0, 0);
  await shot('10-dashboard');

  // ── Star persists ──
  const starBtn = rows().first().getByRole('button', { name: 'Star' });
  await Promise.all([page.waitForResponse('**/star'), starBtn.click()]);
  await page.reload();
  await page.waitForSelector('text=Meeting follow-up - Scheduled');
  assert(await rows().first().getByRole('button', { name: 'Unstar' }).isVisible(), 'star saved on the server (survives reload)');

  // ── Search (Elasticsearch, indexed by the worker) ──
  await page.fill('input[type=search]', 'Ramit');
  await page.waitForFunction(() => location.search.includes('q=Ramit'));
  await page.waitForFunction(() => document.querySelectorAll('main li:not([aria-hidden])').length === 1, null, { timeout: 15000 });
  assert((await rows().first().textContent()).includes('olive@example.com'), 'search "Ramit" finds the Olive email only');
  await shot('11-search');
  await page.getByRole('button', { name: 'Clear search' }).click();
  await page.waitForFunction(() => document.querySelectorAll('main li:not([aria-hidden])').length === 2);
  assert(true, 'clearing search restores the list');

  // ── Sent tab + filter ──
  await nav('Sent').click();
  await page.waitForSelector('text=ana@example.com');
  const sent = await rows().allTextContents();
  assert(sent.length === 3, '3 rows in Sent');
  // \s also matches the narrow no-break space (U+202F) browsers put before AM/PM.
  const TIME = /\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun|[A-Z][a-z]{2}\s\d{1,2})\s\d{1,2}:\d{2}:\d{2}\s(AM|PM)/;
  const sentRow = sent.find((t) => t.includes('ana@example.com'));
  assert(TIME.test(sentRow), `sent rows show the sent time ("${sentRow.match(TIME)?.[0]}")`);
  assert(TIME.test(sent.find((t) => t.includes('Failed'))), 'failed rows show a time too');
  const anaTime = rows().filter({ hasText: 'ana@example.com' }).locator('time');
  assert(Date.parse(await anaTime.getAttribute('datetime')) === Date.parse(anaStarted),
    'a sent row shows when sending STARTED (what the limit counts), not when it finished');
  assert(/^Sending started .+ · accepted by the server .+/.test(await anaTime.getAttribute('title')), 'its tooltip shows both start and finish');
  assert(sent.some((t) => t.includes('Failed')) && sent.some((t) => t.includes('Uncertain')), 'Failed and Uncertain pills');
  await shot('12-sent');
  await page.getByRole('button', { name: 'Filter' }).click();
  await page.getByLabel('Status').selectOption('FAILED');
  await page.waitForFunction(() => document.querySelectorAll('main li:not([aria-hidden])').length === 1);
  assert(page.url().includes('status=FAILED') && (await rows().first().textContent()).includes('bob@example.com'), 'status filter → only the failed email, kept in URL');
  await page.keyboard.press('Escape');
  await shot('13-sent-filtered');

  // ── Mobile ──
  await page.setViewportSize({ width: 400, height: 800 });
  await page.goto(BASE + '/dashboard');
  await page.waitForSelector('text=Meeting follow-up - Scheduled');
  await shot('14-mobile');
  await page.getByRole('button', { name: 'Open menu' }).click();
  await shot('15-mobile-drawer');
  await page.setViewportSize({ width: 1440, height: 900 });

  // ── Server errors: a failed refresh and failed counts are reported, not silent ──
  const serverError = (r) => r.fulfill({ status: 500, json: { error: { code: 'ERROR', message: 'Server error' } } });
  const isList = (url) => url.pathname === '/api/emails';
  const isStats = (url) => url.pathname === '/api/emails/stats';
  await page.goto(BASE + '/dashboard');
  await page.waitForSelector('text=Meeting follow-up - Scheduled');
  await page.route(isList, serverError);
  await page.getByRole('button', { name: 'Refresh' }).click();
  await page.getByText('Couldn’t refresh the list').waitFor({ timeout: 10000 });
  assert((await rows().count()) === 2, 'a failed refresh shows a toast, and the loaded rows stay');
  await page.unroute(isList);

  await page.route(isStats, serverError);
  await page.reload();
  await page.waitForSelector('text=Meeting follow-up - Scheduled');
  await page.getByText('Couldn’t load the email counts').waitFor({ timeout: 10000 });
  assert(await nav('Scheduled').getByLabel('Count unavailable').isVisible(), 'failed counts: a toast, and a dash instead of a number');
  await page.unroute(isStats);
  await page.reload();
  await page.waitForFunction(() => /2$/.test(document.querySelector('nav[aria-label="Mailboxes"] a')?.textContent ?? ''));
  assert(true, 'counts come back once the server answers');

  // ── Log out via the user menu ──
  await page.goto(BASE + '/dashboard');
  await page.getByRole('button', { name: /Oliver Brown/ }).click();
  await page.getByRole('menuitem', { name: 'Log out' }).click();
  await page.waitForURL('**/login');
  assert(true, 'user menu → Log out → /login');

  await finish(browser);
  log('ALL PASSED');
})().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
