import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useToast } from '../components/Toast';

/** The backend's Google callback redirects to /login?error=… on failure: show it once. */
export function useOAuthErrorToast() {
  const [params, setParams] = useSearchParams();
  const toast = useToast();
  const error = params.get('error');
  useEffect(() => {
    if (!error) return;
    toast.error(error);
    setParams((p) => { p.delete('error'); return p; }, { replace: true });
  }, [error, setParams, toast]);
}
