import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '../components/Toast';

/**
 * After Slack's consent screen the backend redirects to /dashboard?slack=connected|error|
 * cancelled. Show the outcome once, refresh the connection status, drop the parameter.
 */
export function useSlackRedirectToast() {
  const [params, setParams] = useSearchParams();
  const toast = useToast();
  const qc = useQueryClient();
  const result = params.get('slack');

  useEffect(() => {
    if (!result) return;
    if (result === 'connected') toast.success('Slack connected. Rate-limit alerts will post to your chosen channel.');
    else if (result === 'cancelled') toast.info('Slack connection cancelled. Nothing was changed.');
    else toast.error('Couldn’t connect Slack. Please try again.');
    void qc.invalidateQueries({ queryKey: ['slack'] });
    setParams((p) => { p.delete('slack'); return p; }, { replace: true });
  }, [result, toast, qc, setParams]);
}
