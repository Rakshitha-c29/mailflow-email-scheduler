/**
 * Prints the Slack messages as they will read, plus a Block Kit Builder link to see the real
 * rendering. Nothing is sent. Usage: npm run slack:preview
 */
import { TEST_MESSAGE, rateLimitAlert } from '../src/modules/slack/messages';

const HOUR = 3_600_000;
const windowStart = Math.floor(Date.now() / HOUR) * HOUR;
const alert = rateLimitAlert({
  senderName: 'Oliver Brown',
  senderEmail: 'oliver.brown@ethereal.email',
  limit: 200,
  windowStartMs: windowStart,
  windowEndMs: windowStart + HOUR,
  windowMs: HOUR,
  waiting: 800,
  dashboardUrl: 'http://localhost:5173/dashboard',
});

// Resolve <!date^sec^format|fallback> the way Slack would, in this machine's timezone.
const dates = (s: string) => s.replace(/<!date\^(\d+)\^([^|]+)\|[^>]*>/g, (_, sec: string, fmt: string) => {
  const d = new Date(Number(sec) * 1000);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const today = d.toDateString() === new Date().toDateString();
  const date = today ? 'today' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return fmt.replace('{time}', time).replace('{date_short_pretty}', date);
});

type Block = { type: string; text?: { text: string }; fields?: { text: string }[]; elements?: { text: string | { text: string } }[] };
const render = (blocks: Block[]) => blocks.map((b) => {
  if (b.type === 'header') return `█ ${b.text!.text}`;
  if (b.type === 'section' && b.fields) return b.fields.map((f) => `  ${f.text.replace('\n', '  ')}`).join('\n');
  if (b.type === 'section') return b.text!.text;
  if (b.type === 'actions') return b.elements!.map((e) => `[ ${(e.text as { text: string }).text} ]`).join(' ');
  if (b.type === 'context') return b.elements!.map((e) => e.text as string).join(' ');
  return '';
}).join('\n\n');

console.log('── Rate-limit alert ─────────────────────────────\n');
console.log(dates(render(alert.blocks as Block[])));
console.log('\nNotification text:', dates(alert.text));
console.log('\n── Test message ─────────────────────────────────\n');
console.log(TEST_MESSAGE.text);
console.log('\nSee it rendered by Slack (paste into a browser, sign-in required):');
console.log('https://app.slack.com/block-kit-builder#' + encodeURIComponent(JSON.stringify({ blocks: alert.blocks })));
