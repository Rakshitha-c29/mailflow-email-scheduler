import { runMigrations } from '../src/db/migrate';
import { pool } from '../src/lib/db';
import { logger } from '../src/lib/logger';

runMigrations()
  .catch((err) => { logger.error({ err }, 'migration failed'); process.exitCode = 1; })
  .finally(() => pool.end());
