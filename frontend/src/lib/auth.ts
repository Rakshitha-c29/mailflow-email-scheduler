import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './api';

export interface User {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}

/** Full-page navigation: the backend redirects to Google and back to /dashboard. */
export const GOOGLE_LOGIN_URL = '/api/auth/google';

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return (await api<{ user: User }>('/auth/me')).user;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>('/auth/logout', { method: 'POST' }),
    onSuccess: () => {
      qc.setQueryData(['me'], null);
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
    },
  });
}

function useSessionMutation<V>(path: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: V) => api<{ user: User }>(path, { method: 'POST', json: vars }),
    // Setting the user makes RedirectIfAuthed send us to /dashboard.
    onSuccess: ({ user }) => qc.setQueryData(['me'], user),
  });
}

export const useLogin = () => useSessionMutation<{ email: string; password: string }>('/auth/login');
export const useSignup = () => useSessionMutation<{ name: string; email: string; password: string }>('/auth/signup');
