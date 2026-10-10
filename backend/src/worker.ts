import { Worker } from 'bullmq';
import { env } from './config/env';
import { logger } from './lib/logger';
import { untilOk } from './lib/retry';
import { pool } from './lib/db';
import { createRedisConnection, redis } from './lib/redis';
import { closeQueues, QUEUE, type EmailJobData, type IndexJobData, type NotifyJobData } from './queues';
import { processEmailJob } from './workers/email.processor';
import { processIndexJob } from './workers/index.processor';
import { processNotifyJob } from './workers/notification.processor';
import { reconcile } from './recovery/reconcile';
import { ensureIndex } from './modules/search/search.service';
import { closeTransports } from './modules/senders/sender.service';

/**
 * Worker process entry point. Can run as many replicas as needed: per-sender limits live
 * in Redis (Lua), the global per-second limit is BullMQ's queue-wide limiter, and each
 * job is locked to one worker at a time.
 *
 * Boot order: reconcile (while no jobs are being taken) → start workers.
 */
const SHUTDOWN_TIMEOUT_MS = 25_000; // in a container, set its stop grace period above this

// autorun: false so nothing is processed before reconciliation has finished.
const emailWorker = new Worker<EmailJobData>(QUEUE.EMAIL, processEmailJob, {
  connection: createRedisConnection('worker-email'),
  autorun: false,
  concurrency: env.WORKER_CONCURRENCY,
  // Queue-wide (all worker processes combined), protects the SMTP provider.
  limiter: { max: env.GLOBAL_MAX_EMAILS_PER_SECOND, duration: 1000 },
});

const indexWorker = new Worker<IndexJobData>(QUEUE.INDEX, processIndexJob, {
  connection: createRedisConnection('worker-index'),
  autorun: false,
  concurrency: 2,
});

const notifyWorker = new Worker<NotifyJobData>(QUEUE.NOTIFY, processNotifyJob, {
  connection: createRedisConnection('worker-notify'),
  autorun: false,
  concurrency: 2,
});

const workers = [emailWorker, indexWorker, notifyWorker];

for (const w of workers) {
  w.on('failed', (job, err) => {
    logger.warn({ queue: w.name, jobId: job?.id, attemptsMade: job?.attemptsMade, err: err.message }, 'job failed');
  });
  w.on('error', (err) => logger.error({ err, queue: w.name }, 'worker error'));
}

function start(w: Worker<any>): void {
  w.run().catch((err) => logger.error({ err, queue: w.name }, 'worker stopped unexpectedly'));
}

async function main(): Promise<void> {
  await reconcile();

  start(emailWorker);
  start(notifyWorker);
  logger.info(
    { concurrency: env.WORKER_CONCURRENCY, globalPerSecond: env.GLOBAL_MAX_EMAILS_PER_SECOND },
    'email worker started',
  );

  // Indexing without the index mapping would make Elasticsearch guess one, so the index
  // worker waits for it. Email sending never waits for search.
  if (await untilOk('elasticsearch', ensureIndex, () => shuttingDown)) {
    start(indexWorker);
    logger.info('index worker started');
  }
}

/**
 * Graceful shutdown: stop taking jobs and let in-flight ones finish, so an email is
 * never cut off mid-SMTP by a normal deploy. If that takes too long we exit anyway;
 * the next boot's reconciliation cleans up (interrupted sends become UNCERTAIN).
 */
let shuttingDown = false;
async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down, waiting for active jobs to finish');
  setTimeout(() => {
    logger.error('graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();

  try {
    await Promise.all(workers.map((w) => w.close()));
    closeTransports();
    await closeQueues();
    await Promise.all([redis.quit(), pool.end()]);
    logger.info('worker stopped cleanly');
  } catch (err) {
    logger.error({ err }, 'error during shutdown');
    exitCode = 1;
  }
  process.exit(exitCode);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled promise rejection'));

main().catch((err) => {
  // Without reconciliation, crash leftovers would go unnoticed until the next restart:
  // exit so the process manager restarts us and we try again.
  logger.fatal({ err }, 'worker failed to start');
  void shutdown('startup-failure', 1);
});
