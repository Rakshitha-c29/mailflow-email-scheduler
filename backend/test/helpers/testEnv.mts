/**
 * Preloaded into every test process (`--import`, see package.json) BEFORE the app reads .env:
 * tests use their own Postgres database and Redis database, so they never touch the real
 * app's emails, users or queues (and a running dev worker never sees test jobs).
 *
 * Defaults: the same servers, database `<name>_test`, Redis db 1 and search index
 * `<index>_test`. Override with TEST_DATABASE_URL / TEST_REDIS_URL / TEST_ELASTICSEARCH_INDEX.
 */
import { config } from 'dotenv';

// Once per run: child test processes inherit the already-switched variables.
if (!process.env.MAILFLOW_TEST_ENV) switchToTestDatabases();

function switchToTestDatabases(): void {
  config(); // the app's own settings; dotenv never overwrites what is already set

  const realDb = process.env.DATABASE_URL;
  const realRedis = process.env.REDIS_URL ?? 'redis://localhost:6379';
  if (!realDb) throw new Error('DATABASE_URL is not set (backend/.env)');

  const testDb = process.env.TEST_DATABASE_URL ?? (() => {
    const u = new URL(realDb);
    u.pathname = `/${u.pathname.replace(/^\//, '') || 'postgres'}_test`;
    return u.toString();
  })();
  const testRedis = process.env.TEST_REDIS_URL ?? (() => {
    const u = new URL(realRedis);
    u.pathname = u.pathname === '/1' ? '/2' : '/1';
    return u.toString();
  })();

  if (testDb === realDb || testRedis === realRedis) {
    throw new Error('Refusing to run tests against the real database or Redis');
  }

  process.env.DATABASE_URL = testDb;
  process.env.REDIS_URL = testRedis;
  // Search documents too: a separate index on the same Elasticsearch.
  process.env.ELASTICSEARCH_INDEX = process.env.TEST_ELASTICSEARCH_INDEX ?? `${process.env.ELASTICSEARCH_INDEX ?? 'emails'}_test`;
  process.env.MAILFLOW_TEST_ENV = '1';
}
