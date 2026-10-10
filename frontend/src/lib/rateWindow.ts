/**
 * The rate-limit window comes from the server (RATE_WINDOW_MS). It's 1 hour normally; any
 * other length is a shortened demo setting, and the UI says so wherever the limit appears.
 */
export const HOUR_MS = 3_600_000;

export const isDemoWindow = (windowMs: number) => windowMs !== HOUR_MS;

/** "hour", "minute", "15 minutes": the window length in words. */
export function windowWords(windowMs: number): string {
  const [n, unit] = windowMs % HOUR_MS === 0 ? [windowMs / HOUR_MS, 'hour']
    : windowMs % 60_000 === 0 ? [windowMs / 60_000, 'minute']
    : [windowMs / 1000, 'second'];
  return n === 1 ? unit : `${n} ${unit}s`;
}

/** "1 minute", "15 minutes", "2 hours": the length with its count. */
const windowLength = (windowMs: number) => {
  const w = windowWords(windowMs);
  return /^\d/.test(w) ? w : `1 ${w}`;
};

/** "per hour" normally; "per window (1 minute, demo mode)" when the window is shortened. */
export const perWindow = (windowMs: number) =>
  isDemoWindow(windowMs) ? `per window (${windowLength(windowMs)}, demo mode)` : 'per hour';

/** Compose hint, only in demo mode: "Demo mode: 1 window = 1 minute". */
export const demoHint = (windowMs: number) =>
  isDemoWindow(windowMs) ? `Demo mode: 1 window = ${windowLength(windowMs)}` : null;
