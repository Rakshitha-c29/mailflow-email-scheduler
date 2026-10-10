/**
 * Proves the minimum gap holds for *actual* send starts, not just reserved slots.
 * Runs against the real Redis from docker-compose (`npm test`).
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { redis } from '../src/lib/redis';
import { acquireSendStart } from '../src/scheduler/rateLimiter';

const senders: string[] = [];
const newSender = () => {
  const id = `test-${randomUUID()}`;
  senders.push(id);
  return id;
};

/** Behaves like a job: sleeps in-process for short waits, "goes back to the queue" for long ones. */
async function startLikeAJob(senderId: string, gapMs: number, maxSleepMs?: number): Promise<number> {
  for (;;) {
    const r = await acquireSendStart(senderId, gapMs, -1, maxSleepMs);
    if ('startedAt' in r) return r.startedAt;
    if (!('retryInMs' in r)) throw new Error('window check is off here (slotWindow -1)');
    await new Promise((res) => setTimeout(res, r.retryInMs));
  }
}

function minGap(starts: number[]): number {
  const sorted = [...starts].sort((a, b) => a - b);
  let min = Infinity;
  for (let i = 1; i < sorted.length; i++) min = Math.min(min, sorted[i] - sorted[i - 1]);
  return min;
}

describe('send-start gate', () => {
  after(async () => {
    await redis.del(...senders.map((s) => `rl:{${s}}:lastStart`));
    await redis.quit();
  });

  test('concurrent jobs never start closer than the gap', async () => {
    const sender = newSender();
    const gap = 150;
    // 30 jobs released at the same instant: the worst case (backlog after a restart).
    const starts = await Promise.all(Array.from({ length: 30 }, () => startLikeAJob(sender, gap)));

    assert.equal(new Set(starts).size, 30, 'every job got its own start');
    assert.ok(minGap(starts) >= gap, `min gap ${minGap(starts)} ms < ${gap} ms`);
  });

  test('jobs through the long-wait path (re-queued) still respect the gap', async () => {
    const sender = newSender();
    const gap = 300;
    // maxSleepMs 50: nearly every wait takes the "moveToDelayed" path instead of sleeping.
    const starts = await Promise.all(Array.from({ length: 12 }, () => startLikeAJob(sender, gap, 50)));

    assert.ok(minGap(starts) >= gap, `min gap ${minGap(starts)} ms < ${gap} ms`);
  });

  test('a long wait is handed back instead of blocking the worker', async () => {
    const sender = newSender();
    const first = await acquireSendStart(sender, 3000);
    const second = await acquireSendStart(sender, 3000);

    assert.ok('startedAt' in first);
    assert.ok('retryInMs' in second);
    assert.ok(second.retryInMs > 1000 && second.retryInMs <= 3000, `retryInMs=${second.retryInMs}`);
  });

  test('senders are independent', async () => {
    const a = await acquireSendStart(newSender(), 5000);
    const b = await acquireSendStart(newSender(), 5000);
    assert.ok('startedAt' in a && 'startedAt' in b);
  });

  test('gap 0 never waits', async () => {
    const sender = newSender();
    for (let i = 0; i < 5; i++) assert.ok('startedAt' in (await acquireSendStart(sender, 0)));
  });
});
