/**
 * Runs once before the tests (`--test-global-setup`, see package.json): creates the test
 * database if it doesn't exist yet. Each test file then applies the migrations to it.
 */
import pg from 'pg';
import './testEnv.mts'; // DATABASE_URL → the test database (no-op if already switched)

export async function globalSetup(): Promise<void> {
  const url = new URL(process.env.DATABASE_URL!);
  const name = decodeURIComponent(url.pathname.slice(1));
  url.pathname = '/postgres';
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    const { rowCount } = await client.query('select 1 from pg_database where datname = $1', [name]);
    if (!rowCount) await client.query(`create database "${name.replace(/"/g, '""')}"`);
  } catch (err) {
    if ((err as { code?: string }).code !== '42P04') throw err; // created concurrently: fine
  } finally {
    await client.end();
  }
}
