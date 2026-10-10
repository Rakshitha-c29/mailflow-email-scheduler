import { Navigate, Outlet } from 'react-router-dom';
import { useMe } from '../lib/auth';
import { Button } from './ui/Button';

function FullPageSpinner() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="size-6 animate-spin rounded-full border-2 border-line border-t-brand" aria-label="Loading" />
    </div>
  );
}

/**
 * Pages that need a session. Only a real "not signed in" (401 → user null) goes to the
 * login page; a network error, rate limit or server hiccup offers a retry instead of
 * pretending the user was logged out.
 */
export function RequireAuth() {
  const { data: user, isPending, isError, isFetching, refetch } = useMe();
  if (isPending) return <FullPageSpinner />;
  if (user) return <Outlet />;
  if (isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center text-sm text-muted" role="alert">
        <p>Couldn’t reach the server. This is usually temporary.</p>
        <Button onClick={() => void refetch()} loading={isFetching}>
          {isFetching ? 'Retrying…' : 'Try again'}
        </Button>
      </div>
    );
  }
  return <Navigate to="/login" replace />;
}

/** Login page: already signed in → straight to the dashboard. */
export function RedirectIfAuthed() {
  const { data: user, isPending } = useMe();
  if (isPending) return <FullPageSpinner />;
  return user ? <Navigate to="/dashboard" replace /> : <Outlet />;
}
