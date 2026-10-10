import crypto from 'node:crypto';
import type { Result } from 'ioredis';
import { redis } from '../../lib/redis';
import { TooManyRequestsError } from '../../lib/errors';

/**
 * Brute-force protection for password auth: fixed-window counters in Redis, shared by
 * every API instance. INCR + EXPIRE run in one script so a key can never be left without
 * a TTL (which would lock someone out forever).
 */
const LUA_HIT = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return { c, redis.call('TTL', KEYS[1]) }
`;
const LUA_PEEK = `
return { tonumber(redis.call('GET', KEYS[1]) or '0'), redis.call('TTL', KEYS[1]) }
`;

redis.defineCommand('authAttemptHit', { numberOfKeys: 1, lua: LUA_HIT });
redis.defineCommand('authAttemptPeek', { numberOfKeys: 1, lua: LUA_PEEK });

declare module 'ioredis' {
  interface RedisCommander<Context> {
    authAttemptHit(key: string, windowS: number): Result<[number, number], Context>;
    authAttemptPeek(key: string): Result<[number, number], Context>;
  }
}

export interface Counter {
  count: number;
  /** Seconds until the window resets. */
  ttl: number;
}

type Action = 'login' | 'signup';

/** Emails are hashed so Redis keys never contain personal data. */
export const attemptKey = (action: Action, by: 'ip' | 'email', value: string) =>
  `auth:${action}:${by}:${by === 'email' ? crypto.createHash('sha256').update(value).digest('hex').slice(0, 32) : value}`;

export async function hit(key: string, windowS: number): Promise<Counter> {
  const [count, ttl] = await redis.authAttemptHit(key, windowS);
  return { count, ttl: Math.max(ttl, 1) };
}

export async function peek(key: string): Promise<Counter> {
  const [count, ttl] = await redis.authAttemptPeek(key);
  return { count, ttl: Math.max(ttl, 1) };
}

export async function clear(key: string): Promise<void> {
  await redis.del(key);
}

export function tooMany(action: Action, ttlS: number): TooManyRequestsError {
  const minutes = Math.ceil(ttlS / 60);
  const what = action === 'login' ? 'login' : 'sign-up';
  return new TooManyRequestsError(
    `Too many ${what} attempts. Please try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    ttlS,
  );
}
