/**
 * Imported FIRST by windowBoundary.test.ts: 2-second rate windows, so a window boundary
 * comes around quickly. Must run before src/config/env is evaluated.
 */
process.env.RATE_WINDOW_MS = '2000';
process.env.MIN_DELAY_BETWEEN_EMAILS_MS = '300';
