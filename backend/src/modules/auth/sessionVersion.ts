import { eq, sql } from 'drizzle-orm';
import { db } from '../../lib/db';
import { redis } from '../../lib/redis';
import { logger } from '../../lib/logger';
import { users } from '../../db/schema';

/**
 * Session revocation for stateless JWTs: every token carries the user's
 * `session_version`; bumping the version invalidates all tokens issued before.
 *
 * The current version is cached in Redis so authenticating a request isn't a DB query.
 * Consistency rules:
 *   - readers fill the cache with SET NX, writers overwrite with SET after the DB commit.
 *     A reader that loaded a stale value can therefore never overwrite a fresher one.
 *   - Redis slow or down → read Postgres (fail safe: never trust a missing/old cache).
 */
const TTL_S = 600;
const REDIS_TIMEOUT_MS = 300;
const cacheKey = (userId: string) => `auth:sv:${userId}`;

function withTimeout<T>(p: Promise<T>): Promise<T> {
  // ioredis queues commands while reconnecting (maxRetriesPerRequest: null), so bound it.
  let timer: NodeJS.Timeout;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('redis timeout')), REDIS_TIMEOUT_MS); }),
  ]).finally(() => clearTimeout(timer));
}

/** Current version, or null if the user no longer exists. */
export async function getSessionVersion(userId: string): Promise<number | null> {
  try {
    const cached = await withTimeout(redis.get(cacheKey(userId)));
    if (cached !== null) return Number(cached);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'session version cache unavailable, using database');
  }

  const row = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { sessionVersion: true } });
  if (!row) return null;
  redis.set(cacheKey(userId), row.sessionVersion, 'EX', TTL_S, 'NX').catch(() => undefined);
  return row.sessionVersion;
}

/** Use in an UPDATE's `set` (with `returning`), then `publishSessionVersion` once committed. */
export const nextSessionVersion = sql`${users.sessionVersion} + 1`;

/** Makes a bumped version visible to every API instance immediately. */
export async function publishSessionVersion(userId: string, version: number): Promise<void> {
  try {
    await withTimeout(redis.set(cacheKey(userId), version, 'EX', TTL_S));
  } catch (err) {
    // Don't leave a stale value behind: without it, readers fall back to Postgres.
    await withTimeout(redis.del(cacheKey(userId))).catch(() => undefined);
    logger.error({ err, userId }, 'could not publish session version; old sessions may work until cache expiry');
  }
}
