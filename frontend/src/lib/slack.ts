import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';

export interface SlackStatus {
  /** Slack app credentials are configured on the server. */
  enabled: boolean;
  connected: boolean;
  status: 'CONNECTED' | 'REVOKED' | null;
  teamName: string | null;
  channelName: string | null;
}

/** Full-page navigation: the backend redirects to Slack's consent screen and back. */
export const SLACK_INSTALL_URL = '/api/integrations/slack/install';

export function useSlackStatus(enabled = true) {
  return useQuery({
    queryKey: ['slack'],
    queryFn: () => api<SlackStatus>('/integrations/slack'),
    enabled,
    staleTime: 30_000,
  });
}

export function useSlackTest() {
  return useMutation({ mutationFn: () => api<{ ok: true }>('/integrations/slack/test', { method: 'POST' }) });
}

export function useSlackDisconnect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>('/integrations/slack', { method: 'DELETE' }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['slack'] }),
  });
}
