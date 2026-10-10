import path from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db, pool } from '../lib/db';
import { logger } from '../lib/logger';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../drizzle');
const LOCK_ID = 727_001; // arbitrary app-wide constant for pg_advisory_lock

/**
 * Applies pending Drizzle migrations. A Postgres advisory lock makes this safe when
 * several API instances boot at once: one migrates, the others wait, then see nothing to do.
 */
export async function runMigrations(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [LOCK_ID]);
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
    logger.info('database migrations applied');
  } finally {
    await client.query('select pg_advisory_unlock($1)', [LOCK_ID]).catch(() => undefined);
    client.release();
  }
}
