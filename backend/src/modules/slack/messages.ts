/**
 * Slack message payloads (Block Kit). Pure functions: no I/O, so they're easy to test and preview
 * (`npm run slack:preview`).
 *
 * `text` is always set too: Slack uses it for notifications, screen readers and old clients.
 */

export const TEST_MESSAGE = {
  text: '✅ MailFlow is connected. Limit alerts will appear here.',
};

export interface RateLimitAlertInput {
  senderName: string | null;
  senderEmail: string | null;
  limit: number;
  /** Start and end of the window that just filled up, in ms. */
  windowStartMs: number;
  windowEndMs: number;
  windowMs: number;
  /** Emails the limit pushed past this window (see countWaitingForLaterWindow). */
  waiting: number;
  dashboardUrl: string;
}

/** Slack treats & < > as control characters in mrkdwn; names and addresses must be escaped. */
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sec = (ms: number) => Math.floor(ms / 1000);
/** Slack shows <!date^…> in each reader's own timezone; the text after | is the fallback. */
const slackDate = (ms: number, format: string) => `<!date^${sec(ms)}^${format}|${new Date(ms).toISOString()}>`;

/** "hour", "2 hours", "minute", "15 minutes": the window length in words. */
export function windowLabel(windowMs: number): string {
  const [n, unit] = windowMs % 3_600_000 === 0 ? [windowMs / 3_600_000, 'hour']
    : windowMs % 60_000 === 0 ? [windowMs / 60_000, 'minute']
    : [Math.round(windowMs / 1000), 'second'];
  return n === 1 ? unit : `${n} ${unit}s`;
}

/** "Hourly", "Per-minute", "2-hour", "15-minute": the limit's name, for the header. */
export function limitName(windowMs: number): string {
  const label = windowLabel(windowMs);
  if (label === 'hour') return 'Hourly';
  if (!label.includes(' ')) return `Per-${label}`;
  const [n, unit] = label.split(' ');
  return `${n}-${unit.replace(/s$/, '')}`;
}

export function rateLimitAlert(a: RateLimitAlertInput) {
  const sender = esc(a.senderEmail ?? 'Unknown sender');
  const who = a.senderName && a.senderName !== a.senderEmail ? `${esc(a.senderName)} (${sender})` : sender;
  const per = windowLabel(a.windowMs);
  // Any window but 1 hour is a shortened demo setting: say so, or "per-minute" looks like a bug.
  const demo = a.windowMs === 3_600_000 ? '' : ' (demo mode)';
  const title = `⚠️ ${limitName(a.windowMs)} limit reached${demo}`;
  const waiting = `${a.waiting.toLocaleString('en-US')} email${a.waiting === 1 ? '' : 's'}`;
  const resumes = slackDate(a.windowEndMs, '{date_short_pretty} at {time}');
  const window = `${slackDate(a.windowStartMs, '{time}')} – ${slackDate(a.windowEndMs, '{time}')}`;

  return {
    text: `${title}: ${sender} hit its limit of *${a.limit}* emails per ${per}. `
      + `${waiting} waiting for a later ${per}; sending resumes ${resumes}.`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: title, emoji: true } },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `A sender reached its sending limit for this ${per}. The remaining emails are queued, `
            + 'not dropped, and will go out automatically when the limit resets.',
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Sender*\n${who}` },
          { type: 'mrkdwn', text: `*Limit*\n${a.limit.toLocaleString('en-US')} emails per ${per}${demo}` },
          { type: 'mrkdwn', text: `*Current window*\n${window}` },
          { type: 'mrkdwn', text: `*Waiting for a later ${per}*\n${waiting}` },
          { type: 'mrkdwn', text: `*Sending resumes*\n${resumes}` },
        ],
      },
      {
        type: 'actions',
        elements: [{
          type: 'button',
          action_id: 'open_dashboard',
          style: 'primary',
          text: { type: 'plain_text', text: 'Open dashboard', emoji: true },
          url: a.dashboardUrl,
        }],
      },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'MailFlow · one alert per sender per window' }] },
    ],
  };
}
