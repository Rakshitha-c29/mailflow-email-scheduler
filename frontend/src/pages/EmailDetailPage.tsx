import { useCallback, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ChevronDown, ExternalLink, Star, Trash2, TriangleAlert } from 'lucide-react';
import { Avatar } from '../components/Avatar';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Button } from '../components/ui/Button';
import { IconButton } from '../components/ui/IconButton';
import { EmailBody } from '../components/email/EmailBody';
import { AttachmentCards } from '../components/email/AttachmentCards';
import { useToast } from '../components/Toast';
import { ApiError } from '../lib/api';
import { useMe } from '../lib/auth';
import { useCancelEmail, useEmail, useResendEmail, useToggleStar, type CampaignSettings, type EmailDetail } from '../lib/emails';
import { formatFull } from '../lib/format';
import { useDismiss } from '../lib/useDismiss';
import { perWindow } from '../lib/rateWindow';


/** Full-page email view (design "Email detail"). */
export function EmailDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { data: me } = useMe();
  const toast = useToast();
  const query = useEmail(id);
  const star = useToggleStar();
  const cancel = useCancelEmail();
  const [confirming, setConfirming] = useState(false);

  // Back to wherever we came from (keeps the list's tab, search and scroll), else the dashboard.
  const back = useCallback(() => {
    if (location.key !== 'default') navigate(-1);
    else navigate('/dashboard');
  }, [location.key, navigate]);

  const email = query.data;
  const cancellable = email?.status === 'SCHEDULED';

  const doCancel = () => cancel.mutate(id, {
    onSuccess: () => {
      setConfirming(false);
      toast.success('Scheduled email cancelled. It won’t be sent.');
    },
    onError: (err) => {
      setConfirming(false);
      toast.error(err instanceof ApiError ? err.message : 'Couldn’t cancel the email. Please try again.');
    },
  });

  return (
    <div className="flex h-full flex-col bg-white">
      <header className="flex h-[76px] shrink-0 items-center gap-2 px-4">
        <IconButton label="Back" tone="strong" onClick={back} className="-ml-1.5">
          <ArrowLeft className="size-5" />
        </IconButton>
        <h1 className="min-w-0 flex-1 truncate text-xl text-gray-900 sm:text-2xl">
          {email?.subject ?? (query.isPending ? '' : 'Email')}
        </h1>

        {email && (
          <div className="flex shrink-0 items-center gap-1.5">
            <IconButton
              label={email.starred ? 'Unstar' : 'Star'}
              tone={email.starred ? 'amber' : 'muted'}
              aria-pressed={email.starred}
              onClick={() => star.mutate({ id, starred: !email.starred }, { onError: () => toast.error('Couldn’t update the star.') })}
            >
              <Star className="size-[18px]" fill={email.starred ? 'currentColor' : 'none'} />
            </IconButton>
            <IconButton
              label="Cancel scheduled email"
              title={cancellable ? 'Cancel scheduled email' : 'Only scheduled emails can be cancelled'}
              onClick={() => setConfirming(true)}
              disabled={!cancellable}
            >
              <Trash2 className="size-[18px]" />
            </IconButton>
          </div>
        )}
        {me && (
          <>
            <span className="mr-3 h-5 w-px bg-gray-200" aria-hidden="true" />
            <Avatar name={me.name} url={me.avatarUrl} size={30} />
          </>
        )}
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto pb-16">
        <div className="px-4 pt-4 md:pl-24 md:pr-10 lg:pl-[202px] lg:pr-[200px]">
          {query.isPending ? (
            <DetailSkeleton />
          ) : query.isError ? (
            <NotFound error={query.error} onRetry={() => query.refetch()} />
          ) : email ? (
            <Message email={email} />
          ) : null}
        </div>
      </main>

      <ConfirmDialog
        open={confirming}
        title="Cancel this scheduled email?"
        confirmLabel="Cancel email"
        busy={cancel.isPending}
        onConfirm={doCancel}
        onCancel={() => setConfirming(false)}
      >
        It won’t be sent to <span className="font-medium text-gray-900">{email?.toEmail}</span>. This can’t be undone.
      </ConfirmDialog>
    </div>
  );
}

function Message({ email }: { email: EmailDetail }) {
  const senderName = email.sender?.name ?? 'Unknown sender';
  // A sent email shows when sending started, like the Sent list (the limit counts starts).
  const when = email.status === 'SENT' ? email.sendStartedAt ?? email.sentAt ?? email.scheduledAt : email.scheduledAt;
  return (
    <article className="flex gap-3 md:gap-[21px]">
      <Avatar name={senderName} size={34} tone="solid" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-3">
          <p className="min-w-0 flex-1 truncate">
            <span className="text-[15px] font-semibold text-gray-900">{senderName}</span>
            {email.sender && <span className="ml-1.5 text-xs text-gray-400">&lt;{email.sender.email}&gt;</span>}
          </p>
          <time dateTime={when} className="shrink-0 text-xs text-gray-400" title={new Date(when).toLocaleString()}>
            {formatFull(when)}
          </time>
        </div>
        <Details email={email} />

        {email.resendOf && <ResendOfNotice originalId={email.resendOf} />}
        <StatusNotice email={email} />

        <div className="mt-6">
          <EmailBody body={email.body} />
        </div>
        <AttachmentCards emailId={email.id} attachments={email.attachments} />
      </div>
    </article>
  );
}

/** "to …" line; expands to the full headers + delivery history (like "to me ▾" in the design). */
function Details({ email }: { email: EmailDetail }) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, useCallback(() => setOpen(false), []));
  const rows: [string, React.ReactNode][] = [
    ['from', email.sender ? `${email.sender.name} <${email.sender.email}>` : '—'],
    ['to', email.toEmail],
  ];
  // "sent" is when the mail server accepted the message (SMTP finished). The minimum gap is
  // enforced between send STARTS, so show the start too: a slow server can make finish times bunch up.
  const startedAt = email.sendStartedAt ?? email.events.findLast((ev) => ev.type === 'SENT')?.detail?.smtpStartedAt;
  if (email.status === 'SENT' && typeof startedAt === 'string') rows.push(['started', new Date(startedAt).toLocaleString()]);
  rows.push(
    email.status === 'SENT'
      ? ['sent', `${new Date(email.sentAt ?? email.scheduledAt).toLocaleString()} · accepted by server`]
      : ['scheduled', new Date(email.scheduledAt).toLocaleString()],
  );
  rows.push(
    ['subject', email.subject],
    ['status', email.status.charAt(0) + email.status.slice(1).toLowerCase()],
  );
  if (email.attempts) rows.push(['attempts', email.attempts]);
  if (email.previewUrl) {
    rows.push(['preview', (
      <a href={email.previewUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-brand hover:underline">
        Open in Ethereal <ExternalLink className="size-3" />
      </a>
    )]);
  }

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="mt-0.5 inline-flex items-center gap-1 rounded text-xs text-gray-500 hover:text-gray-700 focus-visible:outline-2 focus-visible:outline-brand">
        <span className="max-w-[60vw] truncate">to {email.toEmail}</span>
        <ChevronDown className={`size-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute top-full left-0 z-20 mt-1 w-[min(420px,calc(100vw-2rem))] rounded-lg border border-line bg-white p-4 text-xs shadow-lg">
          <DetailRows rows={rows} />
          {email.campaign && (
            <>
              <p className="mt-4 mb-1.5 font-medium text-gray-500">Campaign settings</p>
              <DetailRows rows={campaignRows(email.campaign)} />
            </>
          )}
          {email.events.length > 0 && (
            <>
              <p className="mt-4 mb-1.5 font-medium text-gray-500">History</p>
              <ol className="space-y-1">
                {email.events.map((ev) => (
                  <li key={ev.id} className="flex gap-3 text-gray-600">
                    <span className="w-32 shrink-0 text-gray-400">{new Date(ev.createdAt).toLocaleString()}</span>
                    <span>{describeEvent(ev.type, ev.detail)}</span>
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function DetailRows({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[72px_1fr] gap-x-3 gap-y-1.5">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-right text-gray-400">{k}:</dt>
          <dd className="min-w-0 break-words text-gray-800">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

const seconds = (ms: number) => `${+(ms / 1000).toFixed(2)} s`;

/** Entered values, plus what the server used when it clamped them to the system limits. */
function campaignRows(c: CampaignSettings): [string, React.ReactNode][] {
  const used = (entered: number, effective: number, fmt: (n: number) => string) =>
    entered === effective ? fmt(entered) : `${fmt(entered)} (server used ${fmt(effective)})`;
  return [
    ['start', new Date(c.startAt).toLocaleString()],
    ['delay', used(c.delayMs, c.effective.delayMs, seconds)],
    ['limit', `${used(c.hourlyLimit, c.effective.hourlyLimit, String)} ${perWindow(c.windowMs)}`],
    ['recipients', c.totalCount.toLocaleString('en-US')],
  ];
}

function describeEvent(type: string, detail: Record<string, unknown> | null): string {
  switch (type) {
    case 'DEFERRED': {
      const when = detail?.until ? new Date(String(detail.until)).toLocaleString() : 'a later time';
      if (detail?.reason === 'sender cooldown') return `Sender cooling down after provider throttling, moved to ${when}`;
      // by: 'reconcile': overdue after a restart, given its slot in planned order at startup.
      const afterRestart = detail?.by === 'reconcile' ? ' (after a restart, in planned order)' : '';
      if (detail?.reason === 'min gap') return `Spaced out to keep the minimum gap, moved to ${when}${afterRestart}`;
      if (detail?.reason === 'window ended') {
        return `Its limit window ended just before sending started, so it was counted in the next window instead, moved to ${when}`;
      }
      const limit = typeof detail?.limit === 'number' ? `Sending limit (${detail.limit}) reached` : 'Sending limit reached';
      // planned: the limit was already full when the campaign was scheduled.
      return detail?.planned ? `${limit}, scheduled for ${when}` : `${limit}, moved to ${when}${afterRestart}`;
    }
    case 'THROTTLED':
      return `Provider throttled the sender${detail?.code ? ` (${String(detail.code)})` : ''}, paused ${String(detail?.cooldownSeconds ?? '?')}s · deferral ${String(detail?.deferral ?? '?')} of ${String(detail?.maxDeferrals ?? '?')}`;
    case 'RETRY_SCHEDULED': return `Send failed, retrying${detail?.error ? `: ${String(detail.error)}` : ''}`;
    case 'SENT': return 'Sent';
    case 'FAILED': return `Failed${detail?.error ? `: ${String(detail.error)}` : ''}`;
    case 'UNCERTAIN': return 'Interrupted during delivery';
    case 'CANCELLED': return 'Cancelled';
    case 'RESENT': return 'Sent again as a new email (you chose to resend it)';
    case 'RESEND_OF': return 'Created as a new send of an uncertain email';
    case 'REQUEUED': case 'RECOVERED': return 'Recovered after a restart';
    default: return type.charAt(0) + type.slice(1).toLowerCase().replace(/_/g, ' ');
  }
}

/** Only non-sent emails get a notice; a sent email looks exactly like the design. */
function StatusNotice({ email }: { email: EmailDetail }) {
  const box = 'mt-5 rounded-lg px-4 py-3 text-sm';
  switch (email.status) {
    case 'SCHEDULED':
      return <p className={`${box} bg-orange-50 text-orange-800`}>Scheduled to send {formatFull(email.scheduledAt)}. You can cancel it until then.</p>;
    case 'PROCESSING':
    case 'SENDING':
      return <p className={`${box} bg-orange-50 text-orange-800`}>Sending now…</p>;
    case 'FAILED':
      return <p className={`${box} bg-red-50 text-red-800`}>Delivery failed{email.lastError ? `: ${email.lastError}` : '.'}</p>;
    case 'UNCERTAIN':
      return <UncertainNotice email={email} />;
    case 'CANCELLED':
      return <p className={`${box} bg-gray-100 text-gray-700`}>Cancelled. This email won’t be sent.</p>;
    default:
      return null;
  }
}

/**
 * An UNCERTAIN email was interrupted mid-SMTP: the provider may or may not have accepted
 * it, so it's never retried automatically. "Send again" is the user's explicit decision:
 * it creates a NEW email (new id) and leaves this one untouched; it can happen only once.
 */
function UncertainNotice({ email }: { email: EmailDetail }) {
  const navigate = useNavigate();
  const toast = useToast();
  const resend = useResendEmail();
  const [confirming, setConfirming] = useState(false);

  const doResend = () => resend.mutate(email.id, {
    onSuccess: ({ email: copy, created }) => {
      setConfirming(false);
      toast.success(created ? 'Sent again as a new email.' : 'This email was already sent again.');
      navigate(`/emails/${copy.id}`);
    },
    onError: (err) => {
      setConfirming(false);
      toast.error(err instanceof ApiError ? err.message : 'Couldn’t send it again. Please try again.');
    },
  });

  return (
    <div className="mt-5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900" role="status">
      <p className="flex gap-2 font-medium">
        <TriangleAlert className="mt-0.5 size-4 shrink-0" />
        This email may or may not have been sent.
      </p>
      <p className="mt-1 pl-6">
        Delivery was interrupted while it was being handed to the mail server, so we can’t tell whether{' '}
        <span className="font-medium">{email.toEmail}</span> received it. It isn’t retried automatically, because that
        could send it twice.
      </p>
      <div className="mt-3 pl-6">
        {email.resentAs ? (
          <Link to={`/emails/${email.resentAs.id}`} className="font-medium text-brand hover:underline">
            Already sent again as a new email → View it
          </Link>
        ) : (
          <Button size="sm" onClick={() => setConfirming(true)}>
            Send again
          </Button>
        )}
      </div>
      <ConfirmDialog
        open={confirming}
        tone="primary"
        title="Send this email again?"
        confirmLabel="Send again"
        cancelLabel="Cancel"
        busy={resend.isPending}
        onConfirm={doResend}
        onCancel={() => setConfirming(false)}
      >
        A new copy will be sent to <span className="font-medium text-gray-900">{email.toEmail}</span>, following your
        sending limits. If the first one did arrive, they’ll receive it twice. This email stays as it is.
      </ConfirmDialog>
    </div>
  );
}

/** On a "Send again" copy: where it came from. */
function ResendOfNotice({ originalId }: { originalId: string }) {
  return (
    <p className="mt-5 rounded-lg bg-gray-50 px-4 py-3 text-sm text-gray-700">
      This is a new send of an email whose delivery was uncertain.{' '}
      <Link to={`/emails/${originalId}`} className="font-medium text-brand hover:underline">View the original</Link>
    </p>
  );
}

function DetailSkeleton() {
  return (
    <div className="flex animate-pulse gap-[21px]" aria-label="Loading">
      <span className="size-[34px] shrink-0 rounded-full bg-gray-100" />
      <div className="flex-1 space-y-3">
        <div className="h-4 w-64 rounded bg-gray-100" />
        <div className="h-3 w-32 rounded bg-gray-100" />
        <div className="mt-8 h-3 w-full rounded bg-gray-100" />
        <div className="h-3 w-5/6 rounded bg-gray-100" />
        <div className="h-3 w-2/3 rounded bg-gray-100" />
      </div>
    </div>
  );
}

function NotFound({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const missing = error instanceof ApiError && (error.status === 404 || error.status === 400);
  return (
    <div className="py-16 text-center text-sm text-gray-500">
      <p>{missing ? 'This email doesn’t exist or isn’t yours.' : 'Couldn’t load this email.'}</p>
      {missing
        ? <Link to="/dashboard" className="mt-3 inline-block font-medium text-brand hover:underline">Back to emails</Link>
        : <button onClick={onRetry} className="mt-3 font-medium text-brand hover:underline">Try again</button>}
    </div>
  );
}
