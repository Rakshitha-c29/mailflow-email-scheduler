/**
 * Shared helpers for the browser end-to-end suites (see e2e/README.md).
 * They drive the real app (Vite + API + worker + docker services) through Chrome.
 */
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '../..');
const COMPOSE_FILE = path.join(ROOT, 'docker-compose.yml');
const BASE = process.env.E2E_BASE_URL || 'http://localhost:5173';
const ES_URL = process.env.E2E_ES_URL || 'http://localhost:9200';
const SHOTS = path.join(__dirname, 'screenshots');
const FIXTURES = path.join(__dirname, 'fixtures');
fs.mkdirSync(SHOTS, { recursive: true });

const DEMO = { email: 'oliver.brown@domain.io', password: 'oliver-demo-password' };

/** Installed Chrome (any OS) unless CHROME_PATH points at a specific browser binary. */
function launch() {
  return chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' });
}

/** Runs SQL in the docker Postgres (stdin, so quotes need no shell escaping). */
function psql(sql) {
  const script = sql.trim().endsWith(';') ? sql : `${sql};`;
  return execSync(`docker compose -f "${COMPOSE_FILE}" exec -T postgres psql -U mailflow -At -q`, { input: script })
    .toString().trim();
}

/**
 * Deletes campaigns (and, by cascade, their emails) directly in SQL. The emails' queue jobs
 * are removed first, so no orphan jobs are left behind. `where` filters campaigns aliased `c`.
 */
function deleteCampaigns(where) {
  const ids = psql(`select e.id from emails e join campaigns c on c.id = e.campaign_id where ${where}`);
  if (ids) execSync('npm run -s remove-email-jobs', { cwd: path.join(ROOT, 'backend'), input: ids, stdio: ['pipe', 'ignore', 'inherit'] });
  psql(`delete from campaigns c where ${where}`);
}

/** All local runs come from 127.0.0.1: clear its login/sign-up attempt counters. */
function resetAuthCounters() {
  execSync(`docker compose -f "${COMPOSE_FILE}" exec -T redis sh -c "redis-cli --scan --pattern 'auth:*:ip:*' | xargs -r redis-cli del"`);
}

const log = (...a) => console.log('E2E', ...a);
function assert(cond, message) {
  if (!cond) throw new Error('ASSERT FAILED: ' + message);
  log('ok -', message);
}

/**
 * Closes pages, contexts and the browser, each with a timeout: closing Chrome directly can
 * hang on Windows when a page still has work in flight.
 */
async function finish(browser) {
  const step = (p) => Promise.race([p, new Promise((r) => setTimeout(r, 15000))]).catch(() => undefined);
  for (const ctx of browser.contexts()) {
    for (const page of ctx.pages()) await step(page.close({ runBeforeUnload: false }));
    await step(ctx.close());
  }
  await step(browser.close());
}

/** Runs a suite body with a browser; exits 0 on success, 1 on the first failure. */
function suite(name, body) {
  (async () => {
    const browser = await launch();
    try {
      await body(browser);
      log(`${name}: ALL PASSED`);
    } finally {
      await finish(browser);
    }
  })().then(() => process.exit(0)).catch((e) => { console.error(`${name}:`, e.message); process.exit(1); });
}

module.exports = { ROOT, BASE, ES_URL, SHOTS, FIXTURES, DEMO, launch, psql, deleteCampaigns, resetAuthCounters, log, assert, finish, suite };
