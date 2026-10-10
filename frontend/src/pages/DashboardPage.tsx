import { useCallback, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Toolbar, type Filters } from '../components/dashboard/Toolbar';
import { EmailRow, EmailRowSkeleton } from '../components/dashboard/EmailRow';
import { useToast } from '../components/Toast';
import { useEmailList, useToggleStar, VIEW_STATUSES, type EmailStatus, type View } from '../lib/emails';
import { useErrorToast } from '../lib/useErrorToast';

/** Tab, search and filters live in the URL: reload/back/share keep them. */
function useDashboardParams() {
  const [params, setParams] = useSearchParams();
  const view: View = params.get('view') === 'sent' ? 'sent' : 'scheduled';
  const rawStatus = params.get('status') as EmailStatus | null;
  const state = {
    view,
    q: params.get('q') ?? '',
    senderId: params.get('sender') ?? undefined,
    status: rawStatus && VIEW_STATUSES[view].includes(rawStatus) ? rawStatus : undefined,
  };
  const update = useCallback((patch: Record<string, string | undefined>) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) {
        if (v) next.set(k, v);
        else next.delete(k);
      }
      return next;
    }, { replace: true });
  }, [setParams]);
  return [state, update] as const;
}

export function DashboardPage() {
  const [{ view, q, senderId, status }, update] = useDashboardParams();
  const qc = useQueryClient();
  const toast = useToast();
  const list = useEmailList({ view, q, senderId, status });
  const star = useToggleStar();

  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const total = list.data?.pages[0]?.total ?? 0;
  // A first load that fails shows "Try again" in the list; a refresh (the button or the 15 s
  // poll) that fails while rows are on screen would otherwise go unnoticed.
  useErrorToast(list.isRefetchError, 'Couldn’t refresh the list. Showing the emails loaded earlier.');

  const onSearch = useCallback((text: string) => update({ q: text || undefined }), [update]);
  const onFilter = useCallback((f: Filters) => update({ sender: f.senderId, status: f.status }), [update]);
  const onRefresh = () => {
    void qc.invalidateQueries({ queryKey: ['emails'] });
    void qc.invalidateQueries({ queryKey: ['stats'] });
  };

  // Infinite scroll: load the next page when the sentinel below the last row appears.
  const sentinel = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = list;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasNextPage) return;
    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && !isFetchingNextPage) void fetchNextPage();
    }, { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const toggleStar = (id: string, starred: boolean) =>
    star.mutate({ id, starred }, { onError: () => toast.error('Couldn’t update the star. Please try again.') });

  const filtered = Boolean(q || senderId || status);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar
        view={view}
        q={q}
        senderId={senderId}
        status={status}
        onSearch={onSearch}
        onFilter={onFilter}
        onRefresh={onRefresh}
        refreshing={list.isFetching && !list.isFetchingNextPage}
      />

      <div className="min-h-0 flex-1 overflow-y-auto" aria-busy={list.isPending}>
        {list.isPending ? (
          <ul>{Array.from({ length: 8 }, (_, i) => <EmailRowSkeleton key={i} />)}</ul>
        ) : list.isError && !items.length ? (
          <div className="px-4 py-16 text-center text-sm text-gray-500">
            <p>{list.error.message || 'Couldn’t load emails.'}</p>
            <button onClick={() => list.refetch()} className="mt-3 font-medium text-brand hover:underline">Try again</button>
          </div>
        ) : !items.length ? (
          <EmptyState view={view} filtered={filtered} q={q} onClear={() => update({ q: undefined, sender: undefined, status: undefined })} />
        ) : (
          <>
            <ul aria-label={`${view === 'scheduled' ? 'Scheduled' : 'Sent'} emails`}>
              {items.map((e) => <EmailRow key={e.id} email={e} onToggleStar={() => toggleStar(e.id, !e.starred)} />)}
            </ul>
            <div ref={sentinel} />
            {isFetchingNextPage && <ul><EmailRowSkeleton /><EmailRowSkeleton /></ul>}
            {!hasNextPage && total > 50 && (
              <p className="py-4 text-center text-xs text-gray-400">All {total.toLocaleString('en-US')} emails loaded</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function EmptyState({ view, filtered, q, onClear }: { view: View; filtered: boolean; q: string; onClear: () => void }) {
  if (filtered) {
    return (
      <div className="px-4 py-16 text-center text-sm text-gray-500">
        <p>{q ? <>No emails match “{q}”.</> : 'No emails match these filters.'}</p>
        <button onClick={onClear} className="mt-3 font-medium text-brand hover:underline">Clear search and filters</button>
      </div>
    );
  }
  return (
    <div className="px-4 py-16 text-center text-sm text-gray-500">
      {view === 'scheduled' ? 'No scheduled emails. Use Compose to schedule a campaign.' : 'No sent emails yet.'}
    </div>
  );
}
