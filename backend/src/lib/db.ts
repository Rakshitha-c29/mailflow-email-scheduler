import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { env } from '../config/env';
import * as schema from '../db/schema';
import { logger } from './logger';

export const pool = new Pool({ connectionString: env.DATABASE_URL, max: 20 });
pool.on('error', (err) => logger.error({ err }, 'postgres pool error'));

export const db = drizzle(pool, { schema });
export type DB = typeof db;
