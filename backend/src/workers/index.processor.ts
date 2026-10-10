import type { Job } from 'bullmq';
import type { IndexJobData } from '../queues';
import { indexEmails } from '../modules/search/search.service';

/**
 * Loads the latest rows from Postgres and upserts them into Elasticsearch. Because it
 * always reads current state, duplicate or out-of-order jobs are harmless. Errors are
 * thrown so BullMQ retries with backoff (e.g. while Elasticsearch is still starting).
 */
export async function processIndexJob(job: Job<IndexJobData>): Promise<void> {
  await indexEmails(job.data.emailIds);
}
