import { Queue, type JobsOptions } from 'bullmq';
import { env } from '../config/env';
import { createRedisConnection } from '../lib/redis';

export const QUEUE = {
  EMAIL: 'email-send',
  INDEX: 'search-index',
  NOTIFY: 'slack-notify',
} as const;

/** A slot reserved by the rate limiter, carried on the job so a re-woken job doesn't count twice. */
export interface Reservation {
  slotAt: number;
  window: number;
}
export interface EmailJobData {
  emailId: string;
  reservation?: Reservation;
}
export type IndexJobData = { emailIds: string[] };
export interface NotifyJobData {
  kind: 'RATE_LIMIT_HIT';
  userId: string;
  senderId: string;
  window: number;
  limit: number;
}

const connection = createRedisConnection('queues');

export const emailQueue = new Queue<EmailJobData>(QUEUE.EMAIL, {
  connection,
  defaultJobOptions: {
    attempts: env.EMAIL_JOB_ATTEMPTS,
    backoff: { type: 'exponential', delay: env.EMAIL_JOB_BACKOFF_MS },
    // Keep history bounded; Postgres (not Redis) is the permanent record.
    removeOnComplete: { age: 24 * 3600, count: 5000 },
    removeOnFail: { age: 7 * 24 * 3600 },
  },
});

export const indexQueue = new Queue<IndexJobData>(QUEUE.INDEX, {
  connection,
  defaultJobOptions: {
    attempts: 8,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { age: 3600, count: 1000 },
    removeOnFail: { age: 7 * 24 * 3600 },
  },
});

export const notifyQueue = new Queue<NotifyJobData>(QUEUE.NOTIFY, {
  connection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 3000 },
    removeOnComplete: { age: 24 * 3600 },
    removeOnFail: { age: 7 * 24 * 3600 },
  },
});

/**
 * jobId === emailId. BullMQ ignores an add() whose jobId already exists, which makes
 * enqueueing idempotent: recovery or a retried request can never create a duplicate job.
 */
export function emailJob(emailId: string, runAt: Date, now = Date.now()) {
  const opts: JobsOptions = { jobId: emailId, delay: Math.max(0, runAt.getTime() - now) };
  return { name: 'send', data: { emailId } satisfies EmailJobData, opts };
}

/** Index updates are "load latest row & upsert", so order and duplicates don't matter. */
export async function enqueueIndex(emailIds: string[]): Promise<void> {
  const CHUNK = 500;
  const jobs = [];
  for (let i = 0; i < emailIds.length; i += CHUNK) {
    jobs.push({ name: 'index', data: { emailIds: emailIds.slice(i, i + CHUNK) } });
  }
  if (jobs.length) await indexQueue.addBulk(jobs);
}

export const allQueues = [emailQueue, indexQueue, notifyQueue];

/**
 * Closes the queues AND their shared Redis connection (Queue.close() leaves a connection
 * it was given open, which would keep scripts from exiting).
 */
export async function closeQueues(): Promise<void> {
  await Promise.allSettled(allQueues.map((q) => q.close()));
  await connection.quit().catch(() => undefined);
}
