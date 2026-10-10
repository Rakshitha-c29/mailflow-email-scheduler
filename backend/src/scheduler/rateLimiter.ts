import type { Result } from 'ioredis';
import { env } from '../config/env';
import { redis } from '../lib/redis';

/**
 * Atomic slot reservation (hourly cap + minimum gap) for one sender.
 *
 * Why a Lua script: every check-and-increment must be atomic across N concurrent jobs
 * and M worker processes. Redis executes a script as a single isolated operation, so
 * two jobs can never both take the last slot of a window, or the same send time.
 *
 * Algorithm:
 *   t = max(now, earliest, nextFree[sender])          -- respect min gap between sends
 *   walk windows starting at window(t):
 *     if count[sender][w] < limit: INCR it, nextFree = t + gap, return (t, w)
 *     else: t = start of window w+1                  -- window full: move to the next one
 *
 * Reserving a slot in a *future* window (instead of just "retry next hour") means that
 * when 1000 jobs hit a 200/h limit, they are spread deterministically over 5 windows and
 * each job is rescheduled at most once: no thundering herd at every hour boundary.
 *
 * All keys share the `{senderId}` hash tag so the script is also Redis-Cluster safe.
 */
const LUA_RESERVE = `
local nextKey   = KEYS[1]
local prefix    = ARGV[1]
local now       = tonumber(ARGV[2])
local earliest  = tonumber(ARGV[3])
local limit     = tonumber(ARGV[4])
local gap       = tonumber(ARGV[5])
local windowMs  = tonumber(ARGV[6])
local maxWin    = tonumber(ARGV[7])

local nextFree = tonumber(redis.call('GET', nextKey) or '0')
local t = math.max(now, earliest, nextFree)
local skipped = -1

for _ = 1, maxWin do
  local w = math.floor(t / windowMs)
  local key = prefix .. w
  local c = tonumber(redis.call('GET', key) or '0')
  if c < limit then
    c = redis.call('INCR', key)
    redis.call('PEXPIREAT', key, (w + 2) * windowMs)
    redis.call('SET', nextKey, t + gap, 'PXAT', t + gap + windowMs)
    return { t, w, c, skipped }
  end
  if skipped == -1 then skipped = w end
  t = (w + 1) * windowMs
end
return { -1, -1, -1, skipped }
`;

/**
 * Send-start gate: the last line of defence for the minimum gap.
 *
 * Reserved slots are spaced exactly, but a delayed job wakes up a little after its slot
 * (BullMQ timer + event loop), so two *actual* starts could land closer than the gap.
 * This script is called immediately before SMTP and atomically either records the start
 * or says how long to wait. Being one script, two concurrent jobs can never both pass.
 *
 * It also refuses a start once the window the email's slot was counted in has ended
 * (a job woken just before the boundary could otherwise start just after it, and be one
 * send too many for the new window). The caller then counts it in the current window.
 *
 * Uses Redis' own clock (TIME), so workers on different machines share one timeline.
 * Returns { waitMs, nowMs }: waitMs = 0 means "start now, recorded at nowMs";
 * waitMs = -1 means "the slot's window has ended, don't start".
 */
const LUA_START_GATE = `
local t    = redis.call('TIME')
local now  = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local gap  = tonumber(ARGV[1])
local windowMs, slotWindow = tonumber(ARGV[2]), tonumber(ARGV[3])
if slotWindow >= 0 and math.floor(now / windowMs) > slotWindow then return { -1, now } end
local last = redis.call('GET', KEYS[1])
if last then
  local elapsed = now - tonumber(last)
  if elapsed < gap then return { gap - elapsed, now } end
end
redis.call('SET', KEYS[1], now, 'PX', gap + 1000)
return { 0, now }
`;

redis.defineCommand('reserveSendSlot', { numberOfKeys: 1, lua: LUA_RESERVE });
redis.defineCommand('sendStartGate', { numberOfKeys: 1, lua: LUA_START_GATE });

declare module 'ioredis' {
  interface RedisCommander<Context> {
    reserveSendSlot(
      nextKey: string, prefix: string, now: number, earliest: number,
      limit: number, gap: number, windowMs: number, maxWin: number,
    ): Result<[number, number, number, number], Context>;
    sendStartGate(lastStartKey: string, gap: number, windowMs: number, slotWindow: number): Result<[number, number], Context>;
  }
}

export interface SlotReservation {
  /** Epoch ms at which the email may be sent. */
  slotAt: number;
  /** Hour-window index (floor(slotAt / RATE_WINDOW_MS)) the slot was counted in. */
  window: number;
  /** Count in that window after this reservation. */
  countInWindow: number;
  /** The first window that was already full and had to be skipped, or -1. */
  skippedFullWindow: number;
}

/** Effective limits: a campaign can be stricter than the env ceilings, never looser. */
export const effectiveLimit = (campaignHourly: number) =>
  Math.min(campaignHourly, env.MAX_EMAILS_PER_HOUR_PER_SENDER);
export const effectiveGap = (campaignDelayMs: number) =>
  Math.max(campaignDelayMs, env.MIN_DELAY_BETWEEN_EMAILS_MS);
export const windowOf = (ts: number) => Math.floor(ts / env.RATE_WINDOW_MS);

const MAX_WINDOWS_LOOKAHEAD = 24 * 60; // 60 days of hourly windows

export async function reserveSendSlot(args: {
  senderId: string;
  limit: number;
  gapMs: number;
  earliest: number;
  now?: number;
}): Promise<SlotReservation> {
  const now = args.now ?? Date.now();
  const tag = `{${args.senderId}}`;
  const [slotAt, window, countInWindow, skippedFullWindow] = await redis.reserveSendSlot(
    `rl:${tag}:next`, `rl:${tag}:w:`, now, args.earliest,
    args.limit, args.gapMs, env.RATE_WINDOW_MS, MAX_WINDOWS_LOOKAHEAD,
  );
  if (slotAt < 0) throw new Error(`No capacity for sender ${args.senderId} within lookahead`);
  return { slotAt, window, countInWindow, skippedFullWindow };
}

/** Waits up to this long in-process; longer waits go back to the queue as a delayed job. */
export const MAX_GATE_SLEEP_MS = 1000;
const MAX_GATE_TRIES = 20;

export type SendStart = { startedAt: number } | { retryInMs: number } | { windowEndedAt: number };

/**
 * Passes the send-start gate for a sender: returns the recorded start time (Redis clock),
 * or how long to wait if that's too long to hold a worker slot, or `windowEndedAt` if
 * the window `slotWindow` (where the email's slot was counted) is already over. Callers
 * must start SMTP immediately after `startedAt` is returned. `slotWindow = -1` skips the
 * window check.
 */
export async function acquireSendStart(
  senderId: string, gapMs: number, slotWindow = -1, maxSleepMs = MAX_GATE_SLEEP_MS,
): Promise<SendStart> {
  for (let i = 0; i < MAX_GATE_TRIES; i++) {
    const [waitMs, nowMs] = await redis.sendStartGate(`rl:{${senderId}}:lastStart`, gapMs, env.RATE_WINDOW_MS, slotWindow);
    if (waitMs < 0) return { windowEndedAt: nowMs };
    if (waitMs === 0) return { startedAt: nowMs };
    if (waitMs > maxSleepMs) return { retryInMs: waitMs };
    await new Promise((r) => setTimeout(r, waitMs));
  }
  // Kept losing the race to other jobs of this sender: give the worker slot back.
  return { retryInMs: gapMs };
}

/** Current usage for a sender (for the dashboard / debugging). */
export async function getWindowUsage(senderId: string, window = windowOf(Date.now())): Promise<number> {
  return Number((await redis.get(`rl:{${senderId}}:w:${window}`)) ?? 0);
}

/**
 * Returns true exactly once per (sender, window) across all workers. Used so that the
 * first job to hit a limit sends ONE Slack message instead of one per deferred email.
 */
export async function claimLimitNotification(senderId: string, window: number): Promise<boolean> {
  const res = await redis.set(`rl:{${senderId}}:notified:${window}`, '1', 'PX', env.RATE_WINDOW_MS * 2, 'NX');
  return res === 'OK';
}

/**
 * Provider throttling cooldown, per sender.
 *
 * A temporary SMTP rejection (4xx) means the provider wants us to slow down, so the whole
 * sender pauses: base seconds the first time, doubling on each repeat, capped at max. The
 * level is remembered for an hour (so repeated throttling keeps backing off) and cleared
 * by the next successful send.
 *
 * One atomic script: when several emails of the sender are rejected at the same moment,
 * the first one starts the cooldown and the rest get that same cooldown back, instead of
 * doubling it once per email.
 */
const LUA_COOLDOWN = `
local t   = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local base, max, memory = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
local untilMs = tonumber(redis.call('GET', KEYS[1]) or '0')
local level   = tonumber(redis.call('GET', KEYS[2]) or '0')
if untilMs > now then return { untilMs, level } end
local secs = (level == 0) and base or math.min(level * 2, max)
untilMs = now + secs * 1000
redis.call('SET', KEYS[1], untilMs, 'PXAT', untilMs)
redis.call('SET', KEYS[2], secs, 'PX', secs * 1000 + memory)
return { untilMs, secs }
`;
redis.defineCommand('startSenderCooldown', { numberOfKeys: 2, lua: LUA_COOLDOWN });

declare module 'ioredis' {
  interface RedisCommander<Context> {
    startSenderCooldown(untilKey: string, levelKey: string, baseS: number, maxS: number, memoryMs: number): Result<[number, number], Context>;
  }
}

const COOLDOWN_MEMORY_MS = 3_600_000;
const cooldownKeys = (senderId: string) => [`rl:{${senderId}}:cooldown`, `rl:{${senderId}}:cooldownLevel`] as const;

/** Starts (or joins) the sender's cooldown. Returns when it ends and its length. */
export async function startSenderCooldown(senderId: string): Promise<{ until: number; seconds: number }> {
  const [untilKey, levelKey] = cooldownKeys(senderId);
  const [until, seconds] = await redis.startSenderCooldown(
    untilKey, levelKey, env.THROTTLE_COOLDOWN_BASE_S, env.THROTTLE_COOLDOWN_MAX_S, COOLDOWN_MEMORY_MS,
  );
  return { until, seconds };
}

/** End of the sender's active cooldown (epoch ms), or null if it may send. */
export async function senderCooldownUntil(senderId: string): Promise<number | null> {
  const v = await redis.get(cooldownKeys(senderId)[0]);
  return v && Number(v) > Date.now() ? Number(v) : null;
}

/** A successful send ends the backoff streak. */
export async function resetSenderCooldownLevel(senderId: string): Promise<void> {
  await redis.del(cooldownKeys(senderId)[1]);
}
