const WEEK_MS = 6 * 24 * 3600 * 1000;

/**
 * "Tue 9:15:12 AM" within a week of now (as in the design), otherwise "Oct 3 9:15:12 AM"
 * so dates further out stay unambiguous.
 */
export function formatWhen(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  const day = Math.abs(d.getTime() - now) <= WEEK_MS
    ? d.toLocaleDateString('en-US', { weekday: 'short' })
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${day} ${time}`;
}

export const formatCount = (n: number | undefined) => (n === undefined ? '' : n.toLocaleString('en-US'));

/** "Nov 3, 10:23 AM" (email detail header). The year is added when it isn't this year. */
export function formatFull(iso: string): string {
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
  return `${date}, ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
}

/** "1.2 MB", "312 KB", "80 B" */
export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}
