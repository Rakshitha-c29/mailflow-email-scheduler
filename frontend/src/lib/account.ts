import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import type { User } from './auth';

export interface Account {
  email: string;
  hasPassword: boolean;
  hasGoogle: boolean;
}

export function useAccount(enabled = true) {
  return useQuery({ queryKey: ['account'], queryFn: () => api<Account>('/auth/account'), enabled });
}

/** Sets or changes the password; the server signs out other devices and refreshes this cookie. */
export function useSetPassword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { password: string; currentPassword?: string }) =>
      api<{ user: User }>('/auth/password', { method: 'POST', json: body }),
    onSuccess: ({ user }) => {
      qc.setQueryData(['me'], user);
      void qc.invalidateQueries({ queryKey: ['account'] });
    },
  });
}
