/**
 * Browser end-to-end: detail. Run with `npm run e2e` (see e2e/README.md).
 */
const { BASE, ES_URL, SHOTS, FIXTURES, DEMO, launch, psql, deleteCampaigns, resetAuthCounters, log, assert, finish } = require('./lib.cjs');
const path = require('path');

// The design's email, plus hostile HTML that must not survive sanitizing.
const BODY = `<p>Hey Oliver,</p>
<p>You've just RECEIVED something</p>
<div style="background:#fefce8;border-left:3px solid #fdc700;padding:10px 14px;border-radius:4px">
  <p style="margin:0 0 6px"><b>⚡ Extremely Exclusive—Only 4 Spots Worldwide Per Year | $25,000 investment ⚡</b></p>
  <p style="margin:0">⚡ To explore securing your private transformation, simply reply right now with <b>"FLY OUT FIX"</b>.</p>
</div>
<p>Your coach for world-class performance,</p>
<p>Grant</p>
<p><i style="color:#4b5563">P.S. Always remember that you can develop world class technique! 🚀</i></p>
<script>window.__pwned = true</script>
<img src="x" onerror="window.__pwned = true">
<a id="evil" href="javascript:window.__pwned=true">click</a>
<a id="good" href="https://example.com">a normal link</a>`;

(async () => {
  resetAuthCounters();
  const browser = await launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const shot = (n) => page.screenshot({ path: path.join(SHOTS, n + '.png') });
  let dialogs = 0;
  page.on('dialog', (d) => { dialogs++; d.dismiss(); });

  const r = await page.request.post(BASE + '/api/auth/login', { data: { email: DEMO.email, password: DEMO.password } });
  assert(r.ok(), 'logged in as Oliver');
  const userId = (await r.json()).user.id;
  const senderId = psql(`select id from senders where user_id = '${userId}' order by created_at limit 1;`);

  // Seed the design's (sent) email directly, with dollar-quoting for the HTML.
  const subject = 'Oliver, hello there! | MJWYT44 BM#52W01';
  deleteCampaigns(`c.user_id = '${userId}' and c.subject = '${subject.replace(/'/g, "''")}'`);
  const campaignId = psql(`insert into campaigns (user_id, sender_id, subject, body, start_at, delay_ms, hourly_limit, total_count)
    values ('${userId}', '${senderId}', $s$${subject}$s$, $b$${BODY}$b$, now(), 2000, 100, 1) returning id;`).split('\n')[0];
  const emailId = psql(`insert into emails (campaign_id, user_id, sender_id, to_email, subject, status, scheduled_at, sent_at, preview_url)
    values ('${campaignId}', '${userId}', '${senderId}', 'oliver@example.com', $s$${subject}$s$, 'SENT', now(), now(), 'https://ethereal.email/message/demo') returning id;`).split('\n')[0];
  // SMTP started 3 s before it finished (a slow server), as the worker records it.
  psql(`insert into email_events (email_id, type, detail) values ('${emailId}', 'SENT', jsonb_build_object('smtpStartedAt', to_char((now() - interval '3 seconds') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));`);

  // ── Open from the Sent list ──
  await page.goto(BASE + '/dashboard?view=sent');
  await page.getByRole('link', { name: /Oliver, hello there!/ }).click();
  await page.waitForURL(`**/emails/${emailId}`);
  await page.waitForSelector('text=Hey Oliver,');
  const title = await page.waitForFunction((s) => document.querySelector('h1')?.textContent === s, subject, { timeout: 5000 })
    .then(() => subject).catch(() => page.locator('h1').allTextContents().then((t) => t.join(' | ')));
  assert(title === subject, `title is the subject (got "${title}")`);
  assert(await page.isVisible('text=You\'ve just RECEIVED something'), 'body rendered');
  assert(await page.isVisible('text=Extremely Exclusive'), 'callout content rendered');
  assert(await page.isVisible('text=Sender 1'), 'sender name shown');
  assert(await page.isVisible('text=to oliver@example.com'), '"to …" line shown');

  // ── Sanitizing ──
  await page.waitForTimeout(300);
  assert(!(await page.evaluate(() => window.__pwned)), 'no injected script ran');
  assert(dialogs === 0, 'no dialogs opened');
  assert((await page.locator('.email-body script').count()) === 0, '<script> removed');
  assert((await page.locator('.email-body [onerror]').count()) === 0, 'onerror handler removed');
  assert(!(await page.locator('#evil').getAttribute('href')), 'javascript: link neutralised');
  assert((await page.locator('#good').getAttribute('target')) === '_blank'
    && (await page.locator('#good').getAttribute('rel')).includes('noopener'), 'normal links open safely in a new tab');
  await page.mouse.move(0, 0);
  await shot('30-detail');

  // ── Details dropdown ──
  await page.getByRole('button', { name: /to oliver@example.com/ }).click();
  assert(await page.isVisible('text=Open in Ethereal'), 'details show the Ethereal preview link');
  const detailRow = async (k) => (await page.locator('dt', { hasText: new RegExp(`^${k}:$`) }).locator('xpath=following-sibling::dd[1]').textContent() ?? '').replace(/\s/g, ' '); // \s: the U+202F before AM/PM
  assert(/accepted by server/.test(await detailRow('sent')), '"sent" says it is when the mail server accepted it');
  const started = Date.parse(await detailRow('started'));
  const sent = Date.parse((await detailRow('sent')).split(' · ')[0]);
  assert(sent - started >= 2000, `"started" shows when sending began (${(sent - started) / 1000}s before "sent")`);
  assert(await page.isVisible('text=Campaign settings'), 'campaign settings block shown');
  assert(Date.parse(await detailRow('start')) > 0, 'start time shown');
  assert((await detailRow('delay')) === '2 s', 'delay between emails: "2 s"');
  const limit = await detailRow('limit');
  const serverWindow = (await (await page.request.get(`${BASE}/api/emails/${emailId}`)).json()).email.campaign.windowMs;
  assert(serverWindow === 3_600_000 ? limit === '100 per hour' : /^100 per window \(.+, demo mode\)$/.test(limit),
    `limit matches this server's window ("${limit}")`);
  assert((await detailRow('recipients')) === '1', 'total recipients: 1');
  await shot('31-detail-settings');
  await page.keyboard.press('Escape');

  // ── Star from detail, reflected in the list after Back ──
  await page.getByRole('button', { name: 'Star', exact: true }).click();
  await page.getByRole('button', { name: 'Unstar' }).waitFor();
  assert(await page.getByRole('button', { name: /Cancel scheduled email/ }).isDisabled(), 'trash disabled for a sent email');
  await page.getByRole('button', { name: 'Back' }).click();
  await page.waitForURL('**/dashboard?view=sent');
  const row = page.locator('li', { hasText: 'Oliver, hello there!' });
  assert(await row.getByRole('button', { name: 'Unstar' }).isVisible(), 'Back returns to the Sent tab; star is reflected in the list');

  // ── Cancel a scheduled email ──
  const s = await page.request.post(BASE + '/api/emails/schedule', {
    data: { subject: 'Cancel me', body: 'This one gets cancelled.', recipients: ['cancel.me@example.com'],
      startAt: new Date(Date.now() + 2 * 86400e3).toISOString(), delayMs: 2000, hourlyLimit: 100 },
  });
  assert(s.status() === 201, 'scheduled an email to cancel');
  await page.goto(BASE + '/dashboard?view=scheduled');
  await page.getByRole('link', { name: /Cancel me/ }).click();
  await page.waitForSelector('text=Scheduled to send');
  await page.getByRole('button', { name: 'Cancel scheduled email' }).click();
  await page.waitForSelector('role=alertdialog');
  await shot('31-cancel-confirm');
  await page.getByRole('button', { name: 'Cancel email' }).click();
  await page.waitForSelector('text=Scheduled email cancelled');
  await page.waitForSelector('text=Cancelled. This email won’t be sent.');
  assert(await page.getByRole('button', { name: 'Cancel scheduled email' }).isDisabled(), 'cancelled: notice shown, trash disabled');
  await page.getByRole('button', { name: /to cancel.me@example.com/ }).click();
  assert(await page.isVisible('text=History') && await page.locator('li', { hasText: 'Cancelled' }).first().isVisible(), 'history lists the cancellation');
  await page.keyboard.press('Escape');

  // ── Unknown id ──
  await page.goto(BASE + '/emails/00000000-0000-4000-8000-000000000000');
  await page.waitForSelector('text=This email doesn’t exist or isn’t yours.');
  assert(true, 'unknown email → friendly not-found');

  // ── Mobile ──
  await page.setViewportSize({ width: 400, height: 800 });
  await page.goto(BASE + `/emails/${emailId}`);
  await page.waitForSelector('text=Hey Oliver,');
  await shot('32-detail-mobile');
  await page.setViewportSize({ width: 1440, height: 900 });

  // ── Limit wording in both window modes (rewrite the window in the server's answer) ──
  const limitWith = async (windowMs) => {
    await page.unroute(`**/api/emails/${emailId}`);
    await page.route(`**/api/emails/${emailId}`, async (route) => {
      const res = await route.fetch();
      const json = await res.json();
      await route.fulfill({ response: res, json: { email: { ...json.email, campaign: { ...json.email.campaign, windowMs } } } });
    });
    await page.goto(BASE + `/emails/${emailId}`);
    await page.getByRole('button', { name: /to oliver@example.com/ }).click();
    return detailRow('limit');
  };
  assert((await limitWith(60_000)) === '100 per window (1 minute, demo mode)', 'demo window: "100 per window (1 minute, demo mode)"');
  assert((await limitWith(3_600_000)) === '100 per hour', 'default 1-hour window: "100 per hour", no demo hint');
  await page.unroute(`**/api/emails/${emailId}`);

  await finish(browser);
  log('ALL PASSED');
})().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
