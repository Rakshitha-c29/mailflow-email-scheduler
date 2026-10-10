import { Link } from 'react-router-dom';
import { Clock, Star, type LucideIcon } from 'lucide-react';
import type { EmailListItem } from '../../lib/emails';
import { formatWhen } from '../../lib/format';

interface Pill {
  icon?: LucideIcon;
  label: string;
  className: string;
  title: string;
}

const fullDate = (iso: string) => new Date(iso).toLocaleString();
const SENT_TAB = new Set(['SENT', 'FAILED', 'UNCERTAIN']);
/** Same look as the Sent tab's "Sent" pill. */
const STATUS_CHIP = 'inline-flex h-6 shrink-0 items-center rounded-full border border-gray-200 bg-gray-100 px-2 text-xs text-gray-600';

/**
 * Scheduled tab: orange pill with the due time (design "Scheduled"), plus a grey status chip
 * ("Scheduled" / "Sending") in the Sent pill's style, on the right.
 * Sent tab: text-only grey "Sent" pill (design "Sent"); both send times are in the tooltip.
 * Failed/Uncertain aren't in the designs: same pill shape, their own colours.
 */
const sentTabTime = (e: EmailListItem) => e.sendStartedAt ?? e.sentAt ?? e.scheduledAt;

/** "Sending started 12:15:00 · accepted by the server 12:15:03". */
function sentTitle(e: EmailListItem): string {
  if (!e.sendStartedAt) return `Sent ${fullDate(e.sentAt ?? e.scheduledAt)}`;
  return `Sending started ${fullDate(e.sendStartedAt)}${e.sentAt ? ` · accepted by the server ${fullDate(e.sentAt)}` : ''}`;
}

function pillFor(e: EmailListItem): Pill {
  switch (e.status) {
    case 'SENT':
      return { label: 'Sent', className: 'border-gray-200 bg-gray-100 text-gray-600', title: sentTitle(e) };
    case 'FAILED':
      return { label: 'Failed', className: 'border-red-200 bg-red-50 text-red-700', title: 'Delivery failed' };
    case 'UNCERTAIN':
      return {
        label: 'Uncertain', className: 'border-amber-200 bg-amber-50 text-amber-800',
        title: 'Interrupted mid-send: it may or may not have been delivered, so it is not retried automatically.',
      };
    case 'PROCESSING':
    case 'SENDING':
      return {
        icon: Clock, label: formatWhen(e.scheduledAt), className: 'border-orange-200 bg-orange-100 text-orange-700',
        title: `Being sent now (was scheduled for ${fullDate(e.scheduledAt)})`,
      };
    default: // SCHEDULED
      return {
        icon: Clock, label: formatWhen(e.scheduledAt), className: 'border-orange-200 bg-orange-100 text-orange-700',
        title: `Scheduled for ${fullDate(e.scheduledAt)}`,
      };
  }
}

export function EmailRow({ email, onToggleStar }: { email: EmailListItem; onToggleStar: () => void }) {
  const pill = pillFor(email);
  const Icon = pill.icon;
  return (
    <li className="flex items-center border-b border-gray-100 pr-3.5 hover:bg-gray-50">
      {/* The whole row opens the email; the star stays a separate control. */}
      <Link
        to={`/emails/${email.id}`}
        className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 py-2.5 pr-3 pl-4 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand md:h-14 md:flex-nowrap md:py-0 md:pl-7"
      >
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-gray-900 md:w-[200px] md:flex-none" title={email.toEmail}>
          To: {email.toEmail}
        </span>
        <span
          className={`inline-flex h-6 shrink-0 items-center gap-1 rounded-full border px-2 text-xs tabular-nums ${pill.className}`}
          title={pill.title}
        >
          {Icon && <Icon className="size-3" strokeWidth={2.25} />}
          {pill.label}
        </span>
        {/* The designs sit the subject close to the pill (≈6px) */}
        <p className="order-last min-w-0 basis-full truncate text-sm md:order-none md:-ml-1.5 md:flex-1 md:basis-auto">
          <span className="font-medium text-gray-900">{email.subject}</span>
          {email.preview && <span className="text-gray-400"> - {email.preview}</span>}
        </p>
      </Link>
      {/* Sent tab: when sending STARTED, the time the limit and the delay apply to (scheduled
          rows show their time in the pill). The finish time is in the tooltip. */}
      {SENT_TAB.has(email.status) && (
        <time dateTime={sentTabTime(email)} title={sentTitle(email)} className="mr-2 hidden shrink-0 text-xs text-gray-400 tabular-nums sm:block">
          {formatWhen(sentTabTime(email))}
        </time>
      )}
      {/* Scheduled tab: the status next to the time pill's due time. */}
      {!SENT_TAB.has(email.status) && (
        <span className={`mr-2 ${STATUS_CHIP}`} title={pill.title}>
          {email.status === 'SCHEDULED' ? 'Scheduled' : 'Sending'}
        </span>
      )}
      <button
        onClick={onToggleStar}
        aria-pressed={email.starred}
        aria-label={email.starred ? 'Unstar' : 'Star'}
        className={`shrink-0 rounded p-1 focus-visible:outline-2 focus-visible:outline-brand ${email.starred ? 'text-amber-400' : 'text-gray-300 hover:text-gray-500'}`}
      >
        <Star className="size-4" fill={email.starred ? 'currentColor' : 'none'} />
      </button>
    </li>
  );
}

export function EmailRowSkeleton() {
  return (
    <li className="flex h-14 animate-pulse items-center gap-3 border-b border-gray-100 px-4 md:pl-7" aria-hidden="true">
      <span className="h-3 w-[160px] rounded bg-gray-100" />
      <span className="h-6 w-28 rounded-full bg-gray-100" />
      <span className="h-3 flex-1 rounded bg-gray-100" />
    </li>
  );
}
