import { env } from './config/env';
import { logger } from './lib/logger';
import { untilOk } from './lib/retry';
import { pool } from './lib/db';
import { redis } from './lib/redis';
import { closeQueues } from './queues';
import { runMigrations } from './db/migrate';
import { ensureIndex } from './modules/search/search.service';
import { createApp } from './app';

/**
 * API process entry point. Boot: migrate → listen → ensure the search index in the
 * background (search answers 503 until Elasticsearch is up; everything else works).
 */
const SHUTDOWN_TIMEOUT_MS = 10_000;
let shuttingDown = false;

async function main(): Promise<void> {
  await runMigrations();

  const server = createApp().listen(env.PORT, () => {
    logger.info({ port: env.PORT, frontend: env.FRONTEND_URL }, 'api listening');
  });

  void untilOk('elasticsearch', ensureIndex, () => shuttingDown);

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down api');
    setTimeout(() => {
      logger.error('graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();

    // Stop accepting connections and let in-flight requests finish.
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
    });
    await closeQueues();
    await Promise.allSettled([redis.quit(), pool.end()]);
    logger.info('api stopped cleanly');
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled promise rejection'));

main().catch((err) => {
  logger.fatal({ err }, 'api failed to start');
  process.exit(1);
});
