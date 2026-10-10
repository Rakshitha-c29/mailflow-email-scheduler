/**
 * seed:demo creates an account with a publicly known password: it must refuse to run in
 * production, before connecting to anything. Runs the real script in a child process.
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { eq } from 'drizzle-orm';
import { db, pool } from '../src/lib/db';
import { redis } from '../src/lib/redis';
import { users } from '../src/db/schema';
import { closeQueues } from '../src/queues';

const BACKEND = path.resolve(__dirname, '..');
const SEED = path.join(BACKEND, 'scripts', 'seed-demo.ts');
const TSX = pathToFileURL(path.join(BACKEND, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
const DEMO_EMAIL = 'oliver.brown@domain.io';
const REFUSED = /Refusing to run: NODE_ENV=production[\s\S]*local development only/;

function run(args: string[], env: NodeJS.ProcessEnv, cwd = BACKEND) {
  const r = spawnSync(process.execPath, ['--import', TSX, ...args], { cwd, env, encoding: 'utf8', timeout: 60_000 });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}
const demoAccounts = async () => (await db.select().from(users).where(eq(users.email, DEMO_EMAIL))).length;
const withoutNodeEnv = () => { const e = { ...process.env }; delete e.NODE_ENV; return e; };

after(async () => {
  await closeQueues();
  await Promise.allSettled([redis.quit(), pool.end()]);
});

describe('seed:demo in production', () => {
  test('NODE_ENV=production (shell) → refuses with a clear message, creates nothing', async () => {
    const before = await demoAccounts();
    const t0 = Date.now();
    const r = run([SEED], { ...process.env, NODE_ENV: 'production' });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, REFUSED);
    assert.doesNotMatch(r.out, /database migrations applied|demo account ready/, 'stopped before doing anything');
    assert.equal(await demoAccounts(), before, 'no demo account created');
    assert.ok(Date.now() - t0 < 30_000);
  });

  test('NODE_ENV=production set only in a .env file is refused too', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'seed-guard-'));
    try {
      writeFileSync(path.join(dir, '.env'), 'NODE_ENV=production\n');
      const r = run([SEED], withoutNodeEnv(), dir); // dotenv reads .env from the working directory
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, REFUSED);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('outside production the guard lets the script continue', () => {
    const guard = pathToFileURL(path.join(BACKEND, 'scripts', 'lib', 'refuseInProduction.ts')).href;
    const r = run(['--input-type=module', '-e', `await import(${JSON.stringify(guard)}); console.log('allowed');`],
      { ...process.env, NODE_ENV: 'development' });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /allowed/);
    assert.doesNotMatch(r.out, /Refusing/);
  });
});
