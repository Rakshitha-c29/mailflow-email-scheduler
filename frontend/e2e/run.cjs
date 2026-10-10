/**
 * Runs the browser end-to-end suites one after another against the running app.
 *
 *   npm run e2e                      all suites, then re-seed the demo account
 *   npm run e2e -- compose detail    only these suites
 *   npm run e2e -- --no-reseed       keep whatever data the suites left behind
 */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { BASE, ROOT } = require('./lib.cjs');

const ORDER = ['auth', 'dashboard', 'detail', 'compose', 'account'];
const args = process.argv.slice(2);
const reseed = !args.includes('--no-reseed');
const wanted = args.filter((a) => !a.startsWith('--'));
const suites = (wanted.length ? wanted : ORDER).filter((s) => fs.existsSync(path.join(__dirname, `${s}.e2e.cjs`)));

(async () => {
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json()).catch(() => null);
  if (health?.status !== 'ok') {
    console.error(`The app isn't reachable at ${BASE} (health: ${JSON.stringify(health)}).`);
    console.error('Start it first: docker compose up -d; backend: npm run dev + npm run dev:worker; frontend: npm run dev.');
    process.exit(1);
  }

  const results = [];
  for (const s of suites) {
    console.log(`\n━━━ ${s} ━━━`);
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [path.join(__dirname, `${s}.e2e.cjs`)], { stdio: 'inherit' });
    results.push({ suite: s, ok: r.status === 0, seconds: Math.round((Date.now() - t0) / 1000) });
  }

  if (reseed) {
    console.log('\n━━━ restoring the demo account (npm run seed:demo) ━━━');
    spawnSync('npm', ['run', 'seed:demo', '--silent'], { cwd: path.join(ROOT, 'backend'), stdio: 'ignore', shell: true });
  }

  console.log('\n━━━ summary ━━━');
  for (const r of results) console.log(`${r.ok ? '✔' : '✖'} ${r.suite} (${r.seconds}s)`);
  process.exit(results.every((r) => r.ok) ? 0 : 1);
})();
