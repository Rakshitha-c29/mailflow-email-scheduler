import { emailQueue, indexQueue } from '../../src/queues';

/**
 * For scripts and tests that delete emails directly: removes those emails' send jobs
 * (jobId = emailId) and the finished search-index jobs that only mention them, so the
 * queues keep no jobs for emails that no longer exist. A job running right now is left
 * alone (it finds no row and does nothing). Returns how many jobs were removed.
 */
export async function removeEmailJobs(emailIds: string[]): Promise<number> {
  if (!emailIds.length) return 0;
  const gone = new Set(emailIds);
  const sends = await Promise.all(emailIds.map((id) => emailQueue.remove(id).catch(() => 0)));
  let removed = sends.filter((r) => r === 1).length;
  for (const job of await indexQueue.getJobs(['completed', 'failed'], 0, -1)) {
    const ids = job?.data?.emailIds ?? [];
    if (ids.length && ids.every((id) => gone.has(id))) {
      await job.remove().then(() => { removed++; }, () => undefined);
    }
  }
  return removed;
}
