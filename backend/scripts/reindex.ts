/**
 * Rebuilds the Elasticsearch read model from Postgres (the source of truth).
 *
 *   npm run reindex              upsert every email (safe while the app is running)
 *   npm run reindex -- --recreate  drop + recreate the index first (after mapping changes;
 *                                  search is empty until the rebuild finishes)
 */
import { asc, gt } from 'drizzle-orm';
import { db, pool } from '../src/lib/db';
import { es, ES_INDEX } from '../src/lib/elastic';
import { logger } from '../src/lib/logger';
import { redis } from '../src/lib/redis';
import { closeQueues } from '../src/queues';
import { emails } from '../src/db/schema';
import { ensureIndex, indexEmails } from '../src/modules/search/search.service';

const BATCH = 1000;

async function main(): Promise<void> {
  if (process.argv.includes('--recreate')) {
    await es.indices.delete({ index: ES_INDEX, ignore_unavailable: true });
    logger.info({ index: ES_INDEX }, 'index deleted');
  }
  await ensureIndex();

  const started = Date.now();
  let total = 0;
  let lastId: string | undefined;
  for (;;) {
    const rows = await db
      .select({ id: emails.id })
      .from(emails)
      .where(lastId ? gt(emails.id, lastId) : undefined)
      .orderBy(asc(emails.id))
      .limit(BATCH);
    if (!rows.length) break;
    await indexEmails(rows.map((r) => r.id));
    total += rows.length;
    lastId = rows[rows.length - 1].id;
    logger.info({ indexed: total }, 'reindex progress');
  }

  await es.indices.refresh({ index: ES_INDEX });
  logger.info({ total, ms: Date.now() - started }, '✅ reindex complete');
}

main()
  .catch((err) => { logger.error({ err }, 'reindex failed'); process.exitCode = 1; })
  .finally(() => Promise.allSettled([pool.end(), redis.quit(), es.close(), closeQueues()]));
