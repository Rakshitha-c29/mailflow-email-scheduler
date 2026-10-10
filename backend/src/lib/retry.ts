import { logger } from './logger';

/**
 * Retries a boot step with capped exponential backoff until it succeeds or `stopped()`
 * returns true (e.g. Elasticsearch can take ~30s to come up after docker compose up).
 */
export async function untilOk(name: string, fn: () => Promise<unknown>, stopped = () => false): Promise<boolean> {
  for (let attempt = 1; !stopped(); attempt++) {
    try {
      await fn();
      return true;
    } catch (err) {
      const wait = Math.min(1000 * 2 ** (attempt - 1), 15_000);
      logger.warn({ err: (err as Error).message, attempt, retryInMs: wait }, `${name} not ready yet`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  return false;
}
