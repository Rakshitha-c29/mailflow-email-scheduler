import { useCallback, useEffect, useState } from 'react';
import { Funnel, RotateCw, Search, X } from 'lucide-react';
import { useSenders, VIEW_STATUSES, type EmailStatus, type View } from '../../lib/emails';
import { useDismiss } from '../../lib/useDismiss';
import { IconButton } from '../ui/IconButton';

const STATUS_LABEL: Record<EmailStatus, string> = {
  SCHEDULED: 'Scheduled', PROCESSING: 'Processing', SENDING: 'Sending',
  SENT: 'Sent', FAILED: 'Failed', UNCERTAIN: 'Uncertain', CANCELLED: 'Cancelled',
};

export interface Filters {
  senderId?: string;
  status?: EmailStatus;
}

export interface ToolbarProps extends Filters {
  view: View;
  q: string;
  onSearch: (q: string) => void;
  onFilter: (f: Filters) => void;
  onRefresh: () => void;
  refreshing: boolean;
}

export function Toolbar({ view, q, senderId, status, onSearch, onFilter, onRefresh, refreshing }: ToolbarProps) {
  // Local text so typing is instant; the URL (and the query) follow 300 ms later.
  const [text, setText] = useState(q);
  useEffect(() => setText(q), [q]);
  useEffect(() => {
    if (text.trim() === q) return;
    const t = setTimeout(() => onSearch(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text, q, onSearch]);

  return (
    <div className="flex items-center gap-2 px-4 pt-5 pb-4 md:pl-0">
      <label className="relative flex h-10 w-full max-w-[688px] items-center">
        <Search className="pointer-events-none absolute left-3.5 size-4 text-gray-400" aria-hidden="true" />
        <span className="sr-only">Search emails</span>
        <input
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') setText(''); }}
          placeholder="Search"
          className="h-full w-full rounded-full bg-field pr-9 pl-10 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-2 focus:outline-brand [&::-webkit-search-cancel-button]:hidden"
        />
        {text && (
          <button onClick={() => setText('')} className="absolute right-3 rounded text-gray-400 hover:text-gray-600 focus-visible:outline-2 focus-visible:outline-brand" aria-label="Clear search">
            <X className="size-4" />
          </button>
        )}
      </label>

      <FilterMenu view={view} senderId={senderId} status={status} onChange={onFilter} />

      <IconButton label="Refresh" size="md" onClick={onRefresh}>
        <RotateCw className={`size-4 ${refreshing ? 'animate-spin' : ''}`} />
      </IconButton>
    </div>
  );
}

function FilterMenu({ view, senderId, status, onChange }: Filters & { view: View; onChange: (f: Filters) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, useCallback(() => setOpen(false), []));
  const senders = useSenders().data?.senders;
  const active = Boolean(senderId || status);

  const select = 'mt-1 h-9 w-full rounded-md bg-field px-2.5 text-sm text-gray-900 focus:outline-2 focus:outline-brand';
  return (
    <div ref={ref} className="relative shrink-0">
      <IconButton
        label={active ? 'Filter (active)' : 'Filter'}
        title="Filter"
        size="md"
        tone={active ? 'brand' : 'muted'}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Funnel className="size-4" />
        {active && <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-brand" />}
      </IconButton>

      {open && (
        <div role="dialog" aria-label="Filters" className="absolute top-full right-0 z-20 mt-1 w-64 rounded-lg border border-line bg-white p-3 shadow-lg">
          <label className="block text-xs font-medium text-gray-500">
            Sender
            <select className={select} value={senderId ?? ''} onChange={(e) => onChange({ senderId: e.target.value || undefined, status })}>
              <option value="">All senders</option>
              {senders?.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.email})</option>)}
            </select>
          </label>
          <label className="mt-3 block text-xs font-medium text-gray-500">
            Status
            <select
              className={select}
              value={status ?? ''}
              onChange={(e) => onChange({ senderId, status: (e.target.value || undefined) as EmailStatus | undefined })}
            >
              <option value="">All</option>
              {VIEW_STATUSES[view].map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
            </select>
          </label>
          {active && (
            <button onClick={() => onChange({})} className="mt-3 text-xs font-medium text-brand hover:underline">
              Clear filters
            </button>
          )}
        </div>
      )}
    </div>
  );
}
