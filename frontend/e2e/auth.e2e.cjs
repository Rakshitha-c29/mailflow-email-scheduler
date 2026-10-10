/**
 * Browser end-to-end: auth. Run with `npm run e2e` (see e2e/README.md).
 */
const { BASE, ES_URL, SHOTS, FIXTURES, DEMO, launch, psql, resetAuthCounters, log, assert, finish } = require('./lib.cjs');
const path = require('path');
const email = `e2e-${Date.now()}@example.com`;
const PASS = 'a-strong-password';

(async () => {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const shot = (n) => page.screenshot({ path: path.join(SHOTS, n + '.png') });
  const toastText = async () => (await page.locator('[role=alert]').last().textContent({ timeout: 5000 })).replace('✕', '').trim();

  // Sign up: empty submit → validation
  await page.goto(BASE + '/signup');
  await page.waitForSelector('text=Sign up with Google');
  await shot('01-signup');
  await page.click('button[type=submit]');
  for (const m of ['Name is required', 'Email is required', 'Password is required']) assert(await page.isVisible(`text=${m}`), `shows "${m}"`);
  await shot('02-signup-errors');

  // Live validation after first submit
  await page.fill('#f-name', 'E2E User');
  await page.fill('#f-email', 'not-an-email');
  await page.fill('#f-password', 'short');
  assert(await page.isVisible('text=Enter a valid email address'), 'invalid email message');
  assert(await page.isVisible('text=Password must be at least 8 characters'), 'min length message');
  assert(!(await page.isVisible('text=Name is required')), 'name error clears when typed');

  // Valid → loading state (response delayed) → dashboard
  await page.fill('#f-email', email);
  await page.fill('#f-password', PASS);
  await page.route('**/api/auth/signup', async (r) => { await new Promise((x) => setTimeout(x, 1500)); await r.continue(); });
  await page.click('button[type=submit]');
  await page.waitForSelector('text=Creating account…');
  assert(await page.isDisabled('button[type=submit]'), 'button disabled while loading');
  await shot('03-signup-loading');
  await page.waitForURL('**/dashboard', { timeout: 60000 });
  await page.waitForSelector(`text=${email}`); // shown in the sidebar user card
  assert(true, 'signed in after signup');
  await page.unroute('**/api/auth/signup');

  // Log out → login page; wrong password → generic toast
  await page.getByRole('button', { name: /E2E User/ }).click();
  await page.getByRole('menuitem', { name: 'Log out' }).click();
  await page.waitForURL('**/login');
  await page.fill('#f-email', email);
  await page.fill('#f-password', 'wrong-password');
  await page.click('button[type=submit]');
  assert((await toastText()) === 'Invalid email or password', 'generic error toast on wrong password');
  await shot('04-login-wrong-password');

  // Correct password (email typed in caps) → dashboard
  await page.fill('#f-email', email.toUpperCase());
  await page.fill('#f-password', PASS);
  await page.click('button[type=submit]');
  await page.waitForURL('**/dashboard');
  assert(true, 'login with correct password (email in caps)');

  // Refresh keeps the session (httpOnly cookie)
  await page.reload();
  await page.waitForSelector(`text=${email}`);
  assert(true, 'session survives reload');

  // Duplicate signup → toast
  await page.getByRole('button', { name: /E2E User/ }).click();
  await page.getByRole('menuitem', { name: 'Log out' }).click();
  await page.waitForURL('**/login');
  await page.getByRole('link', { name: 'Sign up', exact: true }).click();
  await page.fill('#f-name', 'Dup');
  await page.fill('#f-email', email);
  await page.fill('#f-password', PASS);
  await page.click('button[type=submit]');
  assert((await toastText()).startsWith('An account with this email already exists'), 'duplicate signup toast');
  await shot('05-signup-duplicate');

  // Google callback error → toast on login page, param removed from URL
  await page.goto(BASE + '/login?error=' + encodeURIComponent('Google sign-in failed'));
  assert((await toastText()) === 'Google sign-in failed', 'OAuth error shown as toast');
  assert(!page.url().includes('error='), 'error param removed from URL');

  // Rate limit: 5 failures then 429 toast
  await page.goto(BASE + '/login');
  for (let i = 0; i < 5; i++) {
    await page.fill('#f-email', email); await page.fill('#f-password', 'wrong-' + i);
    await page.click('button[type=submit]');
    await page.waitForResponse('**/api/auth/login');
  }
  await page.fill('#f-password', PASS);
  const [resp] = await Promise.all([page.waitForResponse('**/api/auth/login'), page.click('button[type=submit]')]);
  assert(resp.status() === 429, 'server answered 429');
  await page.waitForSelector('text=Too many login attempts');
  log('toast:', await toastText());
  assert(/^Too many login attempts\. Please try again in \d+ minutes?\.$/.test(await toastText()), '429 toast after 5 failures');
  await shot('06-login-rate-limited');

  await finish(browser);
  log('ALL PASSED', email);
})().then(() => { removeAccount(); process.exit(0); }).catch((e) => { console.error(e.message); removeAccount(); process.exit(1); });

/** The account this suite signed up (and its senders): removed on finish, pass or fail. */
function removeAccount() {
  try {
    psql(`delete from users where email = '${email}'`);
    log(`removed the test account ${email}: ${psql(`select count(*) from users where email = '${email}'`) === '0' ? 'gone' : 'STILL THERE'}`);
  } catch (err) {
    console.error('could not remove the test account', email, err.message);
  }
}
