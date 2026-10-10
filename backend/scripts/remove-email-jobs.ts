/**
 * Removes the queue jobs of the given emails (ids on stdin, one per line). Used by the
 * browser tests before they delete emails directly in SQL, so no orphan jobs are left.
 */
import { redis } from '../src/lib/redis';
import { pool } from '../src/lib/db';
import { closeQueues } from '../src/queues';
import { removeEmailJobs } from './lib/removeEmailJobs';

(async () => {
  const input = await new Promise<string>((resolve) => {
    let s = '';
    process.stdin.on('data', (d) => { s += d; }).on('end', () => resolve(s));
  });
  const ids = input.split(/\s+/).filter((x) => /^[0-9a-f-]{36}$/i.test(x));
  console.log(`removed ${await removeEmailJobs(ids)} job(s) for ${ids.length} email(s)`);
  await closeQueues();
  await Promise.allSettled([redis.quit(), pool.end()]);
})();
