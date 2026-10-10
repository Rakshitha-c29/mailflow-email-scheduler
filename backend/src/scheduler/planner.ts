/**
 * Computes the *intended* send time of each email in a campaign at submit time, so the
 * dashboard shows realistic scheduled times immediately:
 *   - emails are spaced by `gapMs` starting at `startAt`
 *   - at most `limit` emails fall into any rate window; overflow moves to the next window
 *
 * This is a plan, not the enforcement. The worker's Redis limiter is the source of truth
 * (a sender may be shared by several campaigns) and updates `scheduled_at` if it has to
 * defer an email further.
 */
export function planSendTimes(opts: {
  count: number;
  startAt: number;
  gapMs: number;
  limit: number;
  windowMs: number;
}): number[] {
  const { count, startAt, gapMs, limit, windowMs } = opts;
  const times: number[] = [];
  let t = startAt;
  let currentWindow = Math.floor(t / windowMs);
  let inWindow = 0;

  for (let i = 0; i < count; i++) {
    if (i > 0) t += gapMs;
    let w = Math.floor(t / windowMs);
    if (w !== currentWindow) {
      currentWindow = w;
      inWindow = 0;
    }
    if (inWindow >= limit) {
      w += 1;
      t = w * windowMs;
      currentWindow = w;
      inWindow = 0;
    }
    times.push(t);
    inWindow++;
  }
  return times;
}
