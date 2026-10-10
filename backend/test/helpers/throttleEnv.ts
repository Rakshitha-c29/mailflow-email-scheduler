/**
 * Imported FIRST by throttling.test.ts: short cooldowns for the test. Must run before
 * src/config/env is evaluated, which is why it's a separate side-effect module.
 */
process.env.THROTTLE_COOLDOWN_BASE_S = '1';
process.env.THROTTLE_COOLDOWN_MAX_S = '4';
process.env.THROTTLE_MAX_DEFERRALS = '2';
process.env.MIN_DELAY_BETWEEN_EMAILS_MS = '0';
