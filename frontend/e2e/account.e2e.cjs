/**
 * Browser end-to-end: account menu (Slack, set/change password) and "Send again" for
 * UNCERTAIN emails. Run with `npm run e2e` (see e2e/README.md).
 *
 * Real backend wherever possible: the connected Slack state uses a real stored integration
 * pointing at a local webhook server; set password and "Send again" hit the real API and
 * worker. States the dev server can't produce (Slack app not configured, a Google-only
 * account outside its 15-minute re-auth window) are mocked at the network layer.
 */
const path = require('path');
const http = require('http');
const { execSync } = require('child_process');
const { BASE, ROOT, SHOTS, DEMO, psql, resetAuthCounters, log, assert, finish, launch } = require('./lib.cjs');

const RUN = Date.now().toString(36);
let currentPage; // for a screenshot if something fails
const NEW_PASSWORD = 'a-brand-new-password-1';

/** Encrypts with the backend's own key (reads backend/.env), like the app stores secrets. */
function backendEncrypt(value) {
  return execSync(`npx tsx -e "import('./src/lib/crypto').then(m => process.stdout.write(m.encrypt(process.argv[1])))" "${value}"`,
    { cwd: path.join(ROOT, 'backend') }).toString().trim();
}

(async () => {
  resetAuthCounters();
  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  currentPage = page;
  const shot = (n) => page.screenshot({ path: path.join(SHOTS, `account-${n}.png`) });
  const toast = async (re) => (await page.locator('[role=alert],[role=status]').filter({ hasText: re }).first().textContent({ timeout: 8000 })).replace('✕', '').trim();
  const openMenu = async () => {
    await page.getByRole('button', { name: /Oliver Brown/ }).click();
    await page.getByRole('menu', { name: 'Account' }).waitFor();
  };

  const login = await page.request.post(BASE + '/api/auth/login', { data: { email: DEMO.email, password: DEMO.password } });
  assert(login.ok(), 'logged in as Oliver');
  const userId = (await login.json()).user.id;

  // ── Slack: not configured on this server → disabled with an explanation ──
  psql(`delete from slack_integrations where user_id = '${userId}'`);
  await page.goto(BASE + '/dashboard');
  await openMenu();
  const connectItem = page.getByRole('menuitem', { name: /Connect Slack/ });
  if (await connectItem.isDisabled()) {
    assert((await connectItem.textContent()).includes('Not configured on this server'), 'Slack not configured: "Connect Slack" disabled with the reason');
  } else {
    log('note: this server has Slack configured; skipping the not-configured check');
  }
  await page.keyboard.press('Escape');

  // ── Slack: configured but not connected → "Connect Slack" goes to the install endpoint ──
  await page.route('**/api/integrations/slack', (r) => (r.request().method() === 'GET'
    ? r.fulfill({ json: { enabled: true, connected: false, status: null, teamName: null, channelName: null } }) : r.fallback()));
  let installRequested = false;
  await page.route('**/api/integrations/slack/install', (r) => { installRequested = true; return r.fulfill({ status: 204 }); });
  await page.reload();
  await openMenu();
  await page.getByRole('menuitem', { name: 'Connect Slack' }).click();
  await page.waitForTimeout(500);
  assert(installRequested, '"Connect Slack" navigates to /api/integrations/slack/install (→ Slack consent)');
  await page.unroute('**/api/integrations/slack/install');

  // ── Slack: revoked → "Reconnect Slack" with the reason ──
  await page.unroute('**/api/integrations/slack');
  await page.route('**/api/integrations/slack', (r) => (r.request().method() === 'GET'
    ? r.fulfill({ json: { enabled: true, connected: false, status: 'REVOKED', teamName: 'Acme', channelName: '#outreach' } }) : r.fallback()));
  await page.goto(BASE + '/dashboard');
  await openMenu();
  assert(await page.getByRole('menuitem', { name: 'Reconnect Slack' }).isVisible()
    && await page.isVisible('text=Slack access was revoked'), 'revoked: "Reconnect Slack" with an explanation');
  await page.keyboard.press('Escape');
  await page.unroute('**/api/integrations/slack');

  // ── Slack: connected (real stored integration → local webhook) ──
  const received = [];
  const hook = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { received.push(JSON.parse(body || '{}')); res.end('ok'); });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => hook.once('listening', r));
  const hookUrl = `http://127.0.0.1:${hook.address().port}/services/T1/B1/e2e`;
  psql(`insert into slack_integrations (user_id, team_id, team_name, channel_name, webhook_url_enc, access_token_enc)
        values ('${userId}', 'T1', 'Acme Outreach', '#sales-alerts', '${backendEncrypt(hookUrl)}', '${backendEncrypt('xoxb-e2e-fake')}')`);
  await page.goto(BASE + '/dashboard');
  await openMenu();
  const conn = page.getByLabel('Slack connection');
  assert((await conn.textContent()).includes('Acme Outreach') && (await conn.textContent()).includes('#sales-alerts'), 'connected: shows workspace and channel');
  await shot('slack-connected');
  await page.getByRole('menuitem', { name: 'Send test message' }).click();
  assert((await toast(/Test message sent/)).includes('#sales-alerts'), 'test message toast');
  assert(received.length === 1 && /MailFlow is connected/.test(received[0].text), 'the test message really reached the channel webhook');

  // Live rate-limit alert: a campaign that hits its limit posts ONE message to the channel.
  const senderRow = psql(`select id from senders where user_id = '${userId}' order by created_at limit 1`);
  execSync(`docker compose -f "${path.join(ROOT, 'docker-compose.yml')}" exec -T redis sh -c "redis-cli --scan --pattern 'rl:{${senderRow}}:notified:*' | xargs -r redis-cli del"`);
  const burst = await page.request.post(BASE + '/api/emails/schedule', {
    data: { subject: `Limit alert ${RUN}`, body: 'Rate limit demo', recipients: Array.from({ length: 8 }, (_, i) => `burst${i}.${RUN}@example.com`),
      startAt: new Date().toISOString(), delayMs: 0, hourlyLimit: 3, senderId: senderRow },
  });
  assert(burst.status() === 201, 'scheduled 8 emails with a limit of 3 per window');
  const alert = await (async () => {
    for (let i = 0; i < 45; i++) {
      const m = received.find((x) => /limit reached/.test(x.text ?? ''));
      if (m) return m;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return null;
  })();
  assert(alert && /limit of \*3\*/.test(alert.text), 'the rate-limit alert reached the Slack channel (limit 3)');
  const header = alert.blocks?.[0]?.text?.text ?? '';
  assert(/^⚠️ (Hourly|Per-minute|[0-9]+-(hour|minute)) limit reached( \(demo mode\))?$/.test(header) && alert.blocks.some((b) => b.type === 'actions'), 'alert uses Block Kit: header + Open dashboard button');
  const windowMs = (await (await page.request.get(BASE + '/api/senders')).json()).limits.windowMs;
  assert(header.endsWith('(demo mode)') === (windowMs !== 3_600_000), `"(demo mode)" only when the window isn't 1 hour ("${header}")`);
  assert(received.filter((x) => /limit reached/.test(x.text ?? '')).length === 1, 'exactly one alert for that window');
  // Don't leave the rest queued: cancel what's still scheduled.
  for (const id of psql(`select id from emails where subject = 'Limit alert ${RUN}' and status = 'SCHEDULED'`).split('\n').filter(Boolean)) {
    await page.request.delete(`${BASE}/api/emails/${id}`);
  }

  await openMenu();
  await page.getByRole('menuitem', { name: 'Disconnect Slack' }).click();
  await page.getByRole('alertdialog').waitFor();
  assert((await page.getByRole('alertdialog').textContent()).includes('#sales-alerts'), 'disconnect asks for confirmation');
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await toast(/Slack disconnected/);
  assert(psql(`select count(*) from slack_integrations where user_id = '${userId}'`) === '0', 'disconnect removed the integration');
  hook.close();

  // ── Slack: OAuth redirect outcomes → toasts, parameter removed ──
  for (const [param, re] of [['connected', /Slack connected/], ['error', /Couldn’t connect Slack/], ['cancelled', /Slack connection cancelled/]]) {
    await page.goto(`${BASE}/dashboard?slack=${param}`);
    await toast(re);
    await page.waitForFunction(() => !location.search.includes('slack='));
    assert(true, `?slack=${param} → toast, parameter removed`);
  }

  // ── Account details fail to load: the dialog says so, shows no guessed form, can retry ──
  const isAccount = (url) => url.pathname === '/api/auth/account';
  await page.route(isAccount, (r) => r.fulfill({ status: 500, json: { error: { code: 'ERROR', message: 'Server error' } } }));
  await page.goto(BASE + '/dashboard');
  await openMenu();
  await page.getByRole('menuitem', { name: 'Password', exact: true }).click();
  const failDlg = page.getByRole('dialog', { name: 'Password' });
  await failDlg.getByText('Couldn’t load your account details').waitFor({ timeout: 10000 });
  assert(!(await failDlg.getByPlaceholder('New password', { exact: true }).isVisible()), 'account failed to load: explained, no guessed form');
  await page.unroute(isAccount);
  await failDlg.getByRole('button', { name: 'Try again' }).click();
  await page.getByRole('dialog', { name: 'Change password' }).waitFor();
  assert(true, '"Try again" loads the account and shows the right form ("Change password")');
  await page.keyboard.press('Escape');

  // ── Change password (Oliver has one) ──
  await page.goto(BASE + '/dashboard');
  await openMenu();
  await page.getByRole('menuitem', { name: 'Change password' }).click();
  const dlg = page.getByRole('dialog', { name: 'Change password' });
  await dlg.waitFor();
  assert(await dlg.getByPlaceholder('Current password', { exact: true }).isVisible(), 'asks for the current password');
  await dlg.getByPlaceholder('New password', { exact: true }).fill(NEW_PASSWORD);
  await dlg.getByPlaceholder('Confirm new password', { exact: true }).fill('something-else-1');
  await dlg.getByRole('button', { name: 'Change password' }).click();
  assert(await dlg.getByText('Passwords don’t match').isVisible(), 'mismatch is caught');
  await dlg.getByPlaceholder('Confirm new password', { exact: true }).fill(NEW_PASSWORD);
  await dlg.getByPlaceholder('Current password', { exact: true }).fill('definitely-wrong');
  await dlg.getByRole('button', { name: 'Change password' }).click();
  await dlg.getByText('Current password is incorrect').waitFor();
  assert(true, 'wrong current password is reported on its field');
  await shot('change-password');
  await dlg.getByPlaceholder('Current password', { exact: true }).fill(DEMO.password);
  await dlg.getByRole('button', { name: 'Change password' }).click();
  assert((await toast(/Password changed/)).includes('other devices'), 'password changed');
  resetAuthCounters();
  const relog = await page.request.post(BASE + '/api/auth/login', { data: { email: DEMO.email, password: NEW_PASSWORD } });
  assert(relog.ok(), 'the new password signs in');
  // Put the demo password back for the other suites.
  const back = await page.request.post(BASE + '/api/auth/password', { data: { password: DEMO.password, currentPassword: NEW_PASSWORD } });
  assert(back.ok(), 'demo password restored');

  // ── Set password on a Google-only account, outside the 15-minute window → REAUTH ──
  await page.route('**/api/auth/account', (r) => r.fulfill({ json: { email: DEMO.email, hasPassword: false, hasGoogle: true } }));
  await page.route('**/api/auth/password', (r) => r.fulfill({ status: 403, json: { error: { code: 'REAUTH_REQUIRED', message: 'For your security, please sign in with Google again before setting a password.' } } }));
  await page.goto(BASE + '/dashboard');
  await openMenu();
  await page.getByRole('menuitem', { name: 'Set password' }).click();
  const setDlg = page.getByRole('dialog', { name: 'Set password' });
  await setDlg.waitFor();
  assert(!(await setDlg.getByPlaceholder('Current password', { exact: true }).isVisible()), 'Google-only: no current-password field');
  await setDlg.getByPlaceholder('New password', { exact: true }).fill(NEW_PASSWORD);
  await setDlg.getByPlaceholder('Confirm new password', { exact: true }).fill(NEW_PASSWORD);
  await setDlg.getByRole('button', { name: 'Set password' }).click();
  await setDlg.getByText('please sign in with Google again').waitFor();
  assert((await setDlg.getByRole('link', { name: 'Sign in with Google' }).getAttribute('href')) === '/api/auth/google', 'REAUTH_REQUIRED → "Sign in with Google" (the right link)');
  await shot('set-password-reauth');
  await page.keyboard.press('Escape');
  await page.unroute('**/api/auth/account');
  await page.unroute('**/api/auth/password');

  // ── A server hiccup on /me must not look like being logged out ──
  let failMe = true;
  await page.route('**/api/auth/me', (r) => (failMe ? r.fulfill({ status: 500, json: { error: { code: 'INTERNAL', message: 'boom' } } }) : r.fallback()));
  await page.goto(BASE + '/dashboard');
  await page.getByText('Couldn’t reach the server.').waitFor();
  assert(page.url().endsWith('/dashboard'), '/me failing (500) shows "Try again", not the login page');
  failMe = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await page.getByRole('button', { name: /Oliver Brown/ }).waitFor();
  assert(true, '"Try again" recovers once the server answers');
  await page.unroute('**/api/auth/me');

  // ── "Send again" for an UNCERTAIN email ──
  const [campaignId, senderId] = psql(`select id, sender_id from campaigns where user_id = '${userId}' order by created_at limit 1`).split('|');
  const to = `uncertain.${RUN}@example.com`;
  const originalId = psql(`insert into emails (campaign_id, user_id, sender_id, to_email, subject, status, scheduled_at, attempts, last_error)
    values ('${campaignId}', '${userId}', '${senderId}', '${to}', 'Uncertain delivery ${RUN}', 'UNCERTAIN', now() - interval '1 hour', 1,
            'Interrupted during SMTP delivery; may or may not have been sent. Not retried automatically.') returning id`).split('\n')[0];
  const rowBefore = psql(`select status, attempts, scheduled_at, updated_at, last_error from emails where id = '${originalId}'`);

  await page.goto(`${BASE}/emails/${originalId}`);
  await page.getByText('This email may or may not have been sent.').waitFor();
  assert(await page.getByText(`we can’t tell whether ${to} received it`).isVisible(), 'clear warning about the uncertain delivery');
  await shot('uncertain');
  await page.getByRole('button', { name: 'Send again' }).click();
  const confirm = page.getByRole('alertdialog');
  assert((await confirm.textContent()).includes('receive it twice'), 'confirmation explains the duplicate risk');
  await confirm.getByRole('button', { name: 'Send again' }).click();
  await page.waitForURL((u) => /\/emails\/[0-9a-f-]{36}$/.test(u.pathname) && !u.pathname.endsWith(originalId));
  const copyId = page.url().split('/').pop();
  assert(copyId !== originalId, 'a NEW email (new id) was created and opened');
  await toast(/Sent again as a new email/);
  await page.getByText('This is a new send of an email whose delivery was uncertain.').waitFor();
  assert(true, 'the copy links back to the original');

  assert(psql(`select status, attempts, scheduled_at, updated_at, last_error from emails where id = '${originalId}'`) === rowBefore, 'original row untouched');
  const again = await page.request.post(`${BASE}/api/emails/${originalId}/resend`);
  assert(again.status() === 200 && (await again.json()).email.id === copyId, 'idempotent: asking again returns the same copy');

  await page.getByRole('link', { name: 'View the original' }).click();
  await page.getByRole('link', { name: /Already sent again as a new email/ }).waitFor();
  assert(!(await page.getByRole('button', { name: 'Send again' }).isVisible()), 'original now links to the copy; no second "Send again"');

  // The worker really sends the copy (Ethereal).
  const sent = await (async () => {
    for (let i = 0; i < 60; i++) {
      const s = psql(`select status from emails where id = '${copyId}'`);
      if (s === 'SENT' || s === 'FAILED') return s;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return psql(`select status from emails where id = '${copyId}'`);
  })();
  assert(sent === 'SENT', `the copy went through the normal pipeline and was sent (${sent})`);

  await finish(browser);
  log('account: ALL PASSED');
})().then(() => process.exit(0)).catch(async (e) => {
  console.error(e.message);
  if (currentPage) {
    console.error('page at failure:', currentPage.url());
    await currentPage.screenshot({ path: path.join(SHOTS, 'account-FAILURE.png') }).catch(() => undefined);
  }
  process.exit(1);
});
