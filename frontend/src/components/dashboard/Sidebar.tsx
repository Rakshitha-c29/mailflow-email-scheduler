import { Link, NavLink, useSearchParams } from 'react-router-dom';
import { Clock, Send, type LucideIcon } from 'lucide-react';
import { Logo } from './Logo';
import { UserMenu } from './UserMenu';
import { useStats, type View } from '../../lib/emails';
import { formatCount } from '../../lib/format';
import { useErrorToast } from '../../lib/useErrorToast';

function NavItem({ view, label, icon: Icon, count, countState, onNavigate }: {
  view: View;
  label: string;
  icon: LucideIcon;
  count?: number;
  countState: 'loading' | 'error' | 'ready';
  onNavigate?: () => void;
}) {
  const [params] = useSearchParams();
  const active = (params.get('view') ?? 'scheduled') === view;
  return (
    <NavLink
      to={`/dashboard?view=${view}`}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={`flex h-9 items-center gap-3 rounded-md pr-6 pl-4 text-sm transition-colors ${
        active ? 'bg-brand-soft font-semibold text-gray-900' : 'text-gray-700 hover:bg-field'
      }`}
    >
      <Icon className="size-4 shrink-0" strokeWidth={active ? 2.25 : 1.75} />
      <span className="flex-1">{label}</span>
      {countState === 'loading' ? (
        <span className="h-3 w-4 animate-pulse rounded bg-gray-200" aria-label="Loading count" />
      ) : countState === 'error' ? (
        <span className="text-xs font-normal text-gray-400" title="Couldn’t load the count" aria-label="Count unavailable">–</span>
      ) : (
        <span className="text-xs font-normal text-gray-500 tabular-nums">{formatCount(count)}</span>
      )}
    </NavLink>
  );
}

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const statsQuery = useStats();
  const stats = statsQuery.data;
  // Counts only: keep showing the last ones on a failed poll; a dash only if there are none yet.
  const countState = statsQuery.isPending ? 'loading' : statsQuery.isError && !stats ? 'error' : 'ready';
  useErrorToast(statsQuery.isError, 'Couldn’t load the email counts. They’ll update when the server responds.');
  return (
    <div className="flex h-full flex-col px-4 pt-5 pb-4">
      <Link to="/dashboard" onClick={onNavigate} className="mb-3 ml-3.5 self-start">
        <Logo />
      </Link>
      <UserMenu />
      <Link
        to="/compose"
        onClick={onNavigate}
        className="mt-2.5 flex h-9 items-center justify-center rounded-lg border border-brand text-sm font-medium text-brand transition-colors hover:bg-brand-soft"
      >
        Compose
      </Link>

      <p className="mt-6 mb-1.5 px-4 text-[11px] font-medium tracking-wide text-gray-400 uppercase">Core</p>
      <nav className="space-y-0.5" aria-label="Mailboxes">
        <NavItem view="scheduled" label="Scheduled" icon={Clock} count={stats?.scheduled} countState={countState} onNavigate={onNavigate} />
        {/* The Sent tab lists sent, failed and uncertain emails, so its count does too. */}
        <NavItem view="sent" label="Sent" icon={Send} count={stats && stats.sent + stats.failed} countState={countState} onNavigate={onNavigate} />
      </nav>
    </div>
  );
}
