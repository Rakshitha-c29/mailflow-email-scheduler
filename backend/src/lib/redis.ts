import IORedis from 'ioredis';
import { env } from '../config/env';
import { logger } from './logger';

/**
 * BullMQ requires `maxRetriesPerRequest: null` for worker connections: its blocking
 * commands must never be aborted by ioredis' per-command retry limit.
 */
export function createRedisConnection(name: string): IORedis {
  const conn = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null, connectionName: name });
  conn.on('error', (err) => logger.error({ err, conn: name }, 'redis connection error'));
  return conn;
}

/** Shared connection for plain commands: rate limiter scripts, locks, OAuth nonces. */
export const redis = createRedisConnection('app');
