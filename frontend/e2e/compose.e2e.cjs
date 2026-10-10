/**
 * Browser end-to-end: compose. Run with `npm run e2e` (see e2e/README.md).
 */
const { BASE, ES_URL, SHOTS, FIXTURES, DEMO, launch, psql, resetAuthCounters, log, assert, finish } = require('./lib.cjs');
const path = require('path');
const fs = require('fs');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
const RUN = Date.now().toString(36);

(async () => {
  resetAuthCounters();
  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on("dialog", (d) => { log("DIALOG", d.type(), d.message()); d.accept(); });
  const shot = (n) => page.screenshot({ path: path.join(SHOTS, n + '.png') });
  const toast = async (re) => (await page.locator('[role=alert],[role=status]').filter({ hasText: re }).first().textContent({ timeout: 8000 })).replace('✕', '').trim();
  const html = () => page.locator('.compose-editor').innerHTML();

  const r = await page.request.post(BASE + '/api/auth/login', { data: { email: DEMO.email, password: DEMO.password } });
  assert(r.ok(), 'logged in as Oliver');

  // ── Open from the dashboard's Compose button ──
  await page.goto(BASE + '/dashboard');
  await page.getByRole('link', { name: 'Compose' }).click();
  await page.waitForURL('**/compose');
  await page.waitForSelector('text=Compose New Email');
  const from = page.locator('#c-from');
  await page.waitForFunction(() => document.querySelector('#c-from')?.value?.length > 10);
  assert((await from.locator('option').count()) >= 2, 'From lists the user\'s senders (at least 2)');
  // Empty form with the popover open = the design's state, for the visual comparison.
  await page.getByRole('button', { name: 'Send later' }).click();
  await page.waitForSelector('role=dialog[name="Send later"]');
  await page.mouse.move(0, 0);
  await shot('43-compose-empty-popover');
  await page.getByRole('button', { name: 'Cancel' }).click();
  assert(!(await page.isVisible('role=dialog[name="Send later"]')), 'Send Later: Cancel closes without applying');

  // ── Upload List (lead import) ──
  const tmpL = fs.mkdtempSync(path.join(require('os').tmpdir(), 'leads-'));
  const lf = (n, t) => { const p = path.join(tmpL, n); fs.writeFileSync(p, t); return p; };
  const listInput = page.getByLabel('Recipient list file');
  await page.fill('#c-to', `kept.${RUN}@example.com`);
  await page.press('#c-to', 'Enter');
  await listInput.setInputFiles(lf('leads.csv',
    '\uFEFFName,Email,Company\r\n' +
    `"Smith, Ann",ann.${RUN}@example.com,"Acme, Inc"\r\n` +
    `Bob,BOB.${RUN}@EXAMPLE.COM,Beta\r\n` +
    `Bob again,bob.${RUN}@example.com,Beta\r\n` +
    'No Email,,Gamma\r\n' +
    `Kept,kept.${RUN}@example.com,Delta\r\n`));
  let t = await toast(/Imported/);
  assert(t.startsWith('Imported 2 addresses from leads.csv') && t.includes('1 row without a valid address skipped') && t.includes('2 duplicates ignored'),
    `CSV with header, quotes, BOM: ${t}`);
  await listInput.setInputFiles(lf('export.csv', `cara.${RUN}@example.com;Cara;x\ndan.${RUN}@example.com;Dan;y\n`));
  t = await toast(/export\.csv/);
  assert(t.startsWith('Imported 2 addresses from export.csv'), `semicolon list without header: ${t}`);
  await listInput.setInputFiles(lf('plain.txt', `Please add eve.${RUN}@example.com and fay.${RUN}@example.com, thanks`));
  t = await toast(/plain\.txt/);
  assert(t.startsWith('Imported 2 addresses from plain.txt'), `plain text scan: ${t}`);
  await listInput.setInputFiles(lf('nothing.csv', 'name,company\nAnn,Acme\n'));
  assert((await toast(/No email addresses/)).includes('nothing.csv'), 'a list without addresses is reported');
  const visibleChips = await page.locator('#c-to').locator('xpath=..').locator('span[title]').count();
  assert(visibleChips === 3, `collapsed to 3 chips (${visibleChips})`);
  const more = page.getByRole('button', { name: 'Show 4 more recipients' });
  assert((await more.textContent()) === '+4', 'shows "+4" for the other 4 recipients');
  assert(await page.getByText('7 recipients', { exact: true }).isVisible(), 'the number of detected addresses is shown ("7 recipients")');

  // The design's state: one attachment + a scheduled time.
  const tmpA = fs.mkdtempSync(path.join(require('os').tmpdir(), 'one-'));
  fs.writeFileSync(path.join(tmpA, 'sample.png'), fs.readFileSync(path.join(FIXTURES, 'sample.png')));
  await page.getByLabel('Attachment files').setInputFiles(path.join(tmpA, 'sample.png'));
  await page.getByRole('button', { name: /^Attach files \(1 attached\)$/ }).waitFor();
  assert((await page.getByRole('button', { name: /^Attach files/ }).textContent()).includes('1'), 'paperclip shows a count badge');
  await page.getByRole('button', { name: 'Send later' }).click();
  await page.getByRole('button', { name: 'Tomorrow, 10:00 AM' }).click();
  await page.getByRole('button', { name: 'Done' }).click();
  assert(await page.getByRole('button', { name: 'Send Later', exact: true }).isVisible(), 'with a time set the button reads "Send Later"');
  await page.mouse.move(0, 0);
  await page.waitForTimeout(5500); // let the "Will send" toast fade, as in the design
  await shot('46-compose-design7-state');
  const previewOk = await page.locator('ul[aria-label=Attachments] img').evaluate((i) => i.complete && i.naturalWidth > 0);
  assert(previewOk, 'attached image shows as a preview card below the editor');
  await more.click();
  assert((await page.locator('#c-to').locator('xpath=..').locator('span[title]').count()) === 7, '"+4" expands to all 7 recipients');
  await page.getByRole('button', { name: 'Show less' }).click();
  await page.getByRole('button', { name: 'Remove sample.png' }).click({ force: true });
  assert(!(await page.isVisible('ul[aria-label=Attachments]')), 'a preview card can be removed');
  // Start the real flow from a clean page (the draft guard is accepted by the dialog handler).
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#c-from')?.value?.length > 10);

  // ── Validation ──
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  for (const m of ['Add at least one recipient', 'Subject is required', 'Write a message']) assert(await page.isVisible(`text=${m}`), `validation: "${m}"`);

  // ── To: chips ──
  const to = page.locator('#c-to');
  await to.fill(`ann.${RUN}@example.com, not-an-email`);
  await to.press('Enter');
  assert((await page.locator('[title="not-an-email is not a valid email address"]').count()) === 1, 'invalid address shown as a red chip');
  await page.locator('[title="not-an-email is not a valid email address"]').hover();
  await page.getByRole('button', { name: 'Remove not-an-email' }).click();
  assert(!(await page.isVisible('[title="not-an-email is not a valid email address"]')), 'chip × (on hover) removes it');
  await to.focus();
  await page.evaluate((v) => {
    const el = document.querySelector('#c-to');
    const dt = new DataTransfer(); dt.setData('text/plain', v);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, `ben.${RUN}@example.com\nANN.${RUN}@example.com`);
  const chips = await page.locator('[aria-label^="Remove "]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  assert(chips.length === 2 && chips.includes(`Remove ben.${RUN}@example.com`), 'paste adds addresses; duplicates (any case) ignored');

  await page.fill('#c-subject', `Compose test ${RUN}`);

  // ── Editor: every toolbar button ──
  const ed = page.locator('.compose-editor');
  await ed.click();
  const tb = (name) => page.getByRole('toolbar').getByRole('button', { name, exact: true });
  const selectAll = () => page.keyboard.press('Control+A');

  await page.keyboard.type('Hello world');
  await selectAll(); await tb('Bold').click();
  assert((await html()).includes('<strong>Hello world</strong>'), 'Bold → <strong>');
  await tb('Italic').click(); assert((await html()).includes('<em>'), 'Italic → <em>');
  await tb('Underline').click(); assert((await html()).includes('<u>'), 'Underline → <u>');
  await tb('Strikethrough').click(); assert((await html()).includes('<s>'), 'Strikethrough → <s>');
  await tb('Clear formatting').click();
  assert(!/<(strong|em|u|s)>/.test(await html()), 'Clear formatting removes all marks');
  await tb('Undo').click();
  assert((await html()).includes('<s>'), 'Undo restores the formatting');
  await tb('Redo').click();
  assert(!(await html()).includes('<s>'), 'Redo re-applies clear formatting');

  await page.getByRole('button', { name: 'Text size' }).click();
  await page.getByRole('menuitemradio', { name: 'Large' }).click();
  assert((await html()).includes('font-size: 18px'), 'Text size Large → inline font-size: 18px');
  await page.getByRole('button', { name: 'Alignment' }).click();
  await page.getByRole('menuitemradio', { name: 'Align center' }).click();
  assert((await html()).includes('text-align: center'), 'Align center → inline text-align');
  await tb('Indent').click();
  assert((await html()).includes('margin-left: 40px'), 'Indent → margin-left: 40px');
  await tb('Outdent').click();
  assert(!(await html()).includes('margin-left'), 'Outdent removes it');
  await tb('Quote').click();
  assert((await html()).includes('<blockquote>'), 'Quote → <blockquote>');
  await tb('Quote').click();
  assert(!(await html()).includes('<blockquote>'), 'Quote again removes it (no nesting)');
  await page.getByRole('button', { name: 'Line spacing' }).click();
  await page.getByRole('menuitemradio', { name: '1.5 lines' }).click();
  assert((await html()).includes('line-height: 1.5'), 'Line spacing 1.5 → inline line-height');
  await page.getByRole('button', { name: 'Line spacing' }).click();
  await page.getByRole('menuitemradio', { name: 'Single' }).click();
  assert(!(await html()).includes('line-height'), 'Line spacing Single resets it');

  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await tb('Numbered list').click();
  await page.keyboard.type('first');
  await page.keyboard.press('Enter');
  await page.keyboard.type('nested');
  await tb('Indent').click();
  assert(/<ol><li><p>first<\/p><ol><li><p>nested/.test(await html()), 'Numbered list + Indent nests the item');
  await tb('Outdent').click();
  await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
  await tb('Bulleted list').click();
  await page.keyboard.type('bullet');
  assert((await html()).includes('<ul>'), 'Bulleted list → <ul>');
  await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
  await page.keyboard.type('Thanks, Oliver');
  const bodyHtml = await html();

  // ── Delay / hourly limit ──
  await page.fill('#c-delay', '1a'); // non-digits are dropped
  assert((await page.inputValue('#c-delay')) === '1', 'delay accepts digits only');
  await page.fill('#c-hourly', '50');

  // ── Attachments (paperclip) ──
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'att-'));
  const f = (n, b) => { const p = path.join(tmp, n); fs.writeFileSync(p, b); return p; };
  await page.getByLabel('Attachment files').setInputFiles([f('chart.png', PNG), f('Q3 report.pdf', PDF), f('evil.exe', Buffer.from('MZ'))]);
  assert((await toast(/evil\.exe/)).includes("can't be attached"), 'disallowed type rejected with a toast');
  const attached = await page.getByRole('list', { name: 'Attachments' }).locator('li').allTextContents();
  assert(attached.length === 2 && attached[0].includes('chart.png') && attached[1].includes('Q3 report.pdf'), 'paperclip attaches the 2 allowed files');
  assert(await page.getByRole('button', { name: 'Attach files (2 attached)' }).isVisible(), 'badge counts 2 attachments');
  await shot('40-compose-filled');

  // ── Send Later popover (like the design), then clear it to send now ──
  await page.getByRole('button', { name: 'Send later' }).click();
  await page.waitForSelector('role=dialog[name="Send later"]');
  await page.getByRole('button', { name: 'Tomorrow, 10:00 AM' }).click();
  await shot('41-send-later');
  await page.getByRole('button', { name: 'Done' }).click();
  assert(/Will send \w{3} \d+, 10:00 AM/.test(await toast(/Will send/)), 'Send Later applied (confirmation toast)');
  assert(await page.getByRole('button', { name: 'Send Later', exact: true }).isVisible(), 'button reads "Send Later"');
  await page.getByRole('button', { name: /^Scheduled for / }).click();
  await page.getByRole('dialog', { name: 'Send later' }).locator('input').fill('');
  await page.getByRole('button', { name: 'Done' }).click();
  assert(await page.getByRole('button', { name: 'Send', exact: true }).isVisible(), 'clearing the date and Done → back to "Send" (now)');

  // ── Discard guard ──
  await page.getByRole('button', { name: 'Back' }).click();
  await page.waitForSelector('text=Discard this email?');
  await page.getByRole('button', { name: 'Keep it' }).click();
  assert(page.url().endsWith('/compose'), 'Back with a draft asks before discarding');

  // ── From: pick the second sender (multiple senders) ──
  const fromOptions = await from.locator('option').evaluateAll((os) => os.map((o) => ({ id: o.value, email: o.textContent })));
  assert(fromOptions.length >= 2 && new Set(fromOptions.map((o) => o.email)).size === fromOptions.length,
    `From offers ${fromOptions.length} different senders`);
  await from.selectOption(fromOptions[1].id);

  // ── Send now, for real ──
  const [resp] = await Promise.all([
    page.waitForResponse((res) => res.url().endsWith('/api/emails/schedule')),
    page.getByRole('button', { name: 'Send', exact: true }).click(),
  ]);
  assert(resp.status() === 201, 'schedule request accepted (201)');
  assert((await resp.json()).campaign.senderId === fromOptions[1].id, `the campaign is sent from the picked sender (${fromOptions[1].email})`);
  assert((await toast(/scheduled/)).startsWith('2 emails scheduled'), 'success toast');
  await page.waitForURL('**/dashboard?view=scheduled');

  // Worker sends them (with attachments) → they appear in Sent.
  await page.goto(BASE + '/dashboard?view=sent');
  const sentRow = page.locator('li', { hasText: `Compose test ${RUN}` });
  await page.waitForFunction((s) => [...document.querySelectorAll('main li')].filter((li) => li.textContent.includes(s) && li.textContent.includes('Sent')).length === 2,
    `Compose test ${RUN}`, { timeout: 90000, polling: 2000 }).catch(async () => { await page.reload(); });
  await page.reload();
  await page.waitForSelector(`text=Compose test ${RUN}`);
  assert((await sentRow.count()) === 2, 'both emails were sent by the worker');

  // ── Detail: formatted body + attachment cards ──
  await sentRow.first().getByRole('link').click();
  await page.waitForSelector('text=Thanks, Oliver');
  const cards = await page.getByRole('list', { name: 'Attachments' }).locator('li').allTextContents();
  assert(cards.length === 2 && cards[0].includes('chart.png') && cards[1].includes('Q3 report.pdf'), 'detail shows the attachment cards');
  const imgOk = await page.locator('ul[aria-label=Attachments] img').evaluate((img) => img.complete && img.naturalWidth > 0);
  assert(imgOk, 'image card shows the real thumbnail');
  const body = await page.locator('.email-body').innerHTML();
  assert(!body.includes('<blockquote>'), 'no stray quote in the sent email');
  assert(body.includes('font-size: 18px') && body.includes('text-align: center') && body.includes('<ol>') && body.includes('<ul>'),
    'formatting survived sending and sanitizing');
  await page.mouse.move(0, 0);
  await shot('42-detail-with-attachments');

  // ── Phone width: the form fits without horizontal scrolling ──
  await page.setViewportSize({ width: 400, height: 860 });
  await page.goto(BASE + '/compose');
  await page.waitForFunction(() => document.querySelector('#c-from')?.value?.length > 10);
  assert(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)), 'compose fits a 400px-wide phone');
  await shot('compose-mobile');
  await page.setViewportSize({ width: 1440, height: 900 });

  // ── Demo mode hint: follows the server's window length ──
  const hint = page.getByText(/^Demo mode: 1 window = /);
  const serverWindow = (await (await page.request.get(BASE + '/api/senders')).json()).limits.windowMs;
  await page.goto(BASE + '/compose');
  await page.waitForFunction(() => document.querySelector('#c-from')?.value?.length > 10);
  assert(await page.isVisible('text=Hourly Limit'), '"Hourly Limit" label kept (as in the design)');
  assert((await hint.isVisible()) === (serverWindow !== 3_600_000), `hint matches this server's window (${serverWindow} ms)`);
  // Both modes, whatever this server runs: rewrite the window in the server's answer.
  const withWindow = async (windowMs) => {
    await page.unroute('**/api/senders');
    await page.route('**/api/senders', async (route) => {
      const res = await route.fetch();
      const json = await res.json();
      await route.fulfill({ response: res, json: { ...json, limits: { ...json.limits, windowMs } } });
    });
    await page.goto(BASE + '/compose');
    await page.waitForFunction(() => document.querySelector('#c-from')?.value?.length > 10);
  };
  await withWindow(60_000);
  assert((await hint.textContent()) === 'Demo mode: 1 window = 1 minute', 'demo window (1 minute): hint "Demo mode: 1 window = 1 minute"');
  await page.mouse.move(0, 0);
  await shot('43-compose-demo-hint');
  await withWindow(3_600_000);
  assert(!(await hint.isVisible()) && !(await page.isVisible('text=/demo mode/i')), 'default 1-hour window: no hint');
  await page.unroute('**/api/senders');

  // ── Senders fail to load: From says so, Send is disabled, "Try again" recovers ──
  const isSenders = (url) => url.pathname === '/api/senders';
  await page.route(isSenders, (r) => r.fulfill({ status: 500, json: { error: { code: 'ERROR', message: 'Server error' } } }));
  await page.goto(BASE + '/compose');
  await page.getByText('Couldn’t load your senders').waitFor({ timeout: 10000 });
  assert((await page.locator('#c-from option').first().textContent()) === 'Couldn’t load senders'
    && await page.getByRole('button', { name: 'Send', exact: true }).isDisabled(), 'senders failed: a toast, From says so, Send is disabled');
  await page.unroute(isSenders);
  await page.getByRole('button', { name: 'Try again' }).click();
  await page.waitForFunction(() => document.querySelector('#c-from')?.value?.length > 10);
  assert(await page.getByRole('button', { name: 'Send', exact: true }).isEnabled()
    && (await page.locator('#c-from option').count()) >= 2, '"Try again" loads the senders and Send works again');

  await finish(browser);
  log('ALL PASSED', RUN, bodyHtml.length);
})().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
