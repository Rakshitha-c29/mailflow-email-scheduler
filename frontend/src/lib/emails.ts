import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { api, ApiError } from './api';

export type View = 'scheduled' | 'sent';
export type EmailStatus = 'SCHEDULED' | 'PROCESSING' | 'SENDING' | 'SENT' | 'FAILED' | 'UNCERTAIN' | 'CANCELLED';

/** Statuses each tab can be filtered by (mirrors the backend's views). */
export const VIEW_STATUSES: Record<View, EmailStatus[]> = {
  scheduled: ['SCHEDULED', 'PROCESSING', 'SENDING'],
  sent: ['SENT', 'FAILED', 'UNCERTAIN'],
};

export interface EmailListItem {
  id: string;
  toEmail: string;
  subject: string;
  status: EmailStatus;
  scheduledAt: string;
  sentAt: string | null;
  /** When sending started. The limit and the gap apply to starts; `sentAt` is when the server accepted it. */
  sendStartedAt: string | null;
  preview: string;
  starred: boolean;
}

interface Page {
  items: EmailListItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface EmailFilters {
  view: View;
  q: string;
  senderId?: string;
  status?: EmailStatus;
}

export interface Stats {
  scheduled: number;
  sent: number;
  failed: number;
}

export interface EmailEvent {
  id: number;
  type: string;
  detail: Record<string, unknown> | null;
  createdAt: string;
}

export interface AttachmentMeta {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}

export interface EmailDetail extends EmailListItem {
  body: string;
  attachments: AttachmentMeta[];
  sender: Sender | null;
  previewUrl: string | null;
  lastError: string | null;
  attempts: number;
  events: EmailEvent[];
  /** Set on a "Send again" copy: the uncertain original. */
  resendOf: string | null;
  /** Set on an uncertain original that was sent again. */
  resentAs: { id: string; status: EmailStatus } | null;
  campaign: CampaignSettings | null;
}

/** The campaign's settings as entered, plus what the server used (it clamps to system limits). */
export interface CampaignSettings {
  startAt: string;
  delayMs: number;
  hourlyLimit: number;
  totalCount: number;
  /** Length of the rate-limit window (1 hour unless shortened, e.g. for a demo). */
  windowMs: number;
  effective: { delayMs: number; hourlyLimit: number };
}

export interface Sender {
  id: string;
  name: string;
  email: string;
}

const PAGE_SIZE = 50;
/** The list changes on its own as the worker sends; keep it fresh without a websocket. */
const POLL_MS = 15_000;

export function useStats() {
  return useQuery({
    queryKey: ['stats'],
    queryFn: () => api<Stats>('/emails/stats'),
    refetchInterval: POLL_MS,
  });
}

export interface Limits {
  maxPerHourPerSender: number;
  minDelayMs: number;
  /** Rate-limit window length; 1 hour unless shortened for a demo. */
  windowMs: number;
  maxRecipients: number;
  attachments: { maxFiles: number; maxTotalBytes: number; extensions: string[] };
}

/** The user's senders plus the server's limits (the compose form mirrors them). */
export function useSenders() {
  return useQuery({
    queryKey: ['senders'],
    queryFn: () => api<{ senders: Sender[]; limits: Limits }>('/senders'),
    staleTime: 5 * 60_000,
  });
}

export interface ScheduleRequest {
  subject: string;
  body: string;
  recipients: string[];
  startAt: string;
  delayMs: number;
  hourlyLimit: number;
  senderId?: string;
}

export interface ScheduleResult {
  campaign: { id: string; scheduledCount: number; firstSendAt: string; lastSendAt: string };
  replayed: boolean;
  warnings: string[];
}

/**
 * multipart/form-data: the JSON request as `payload` plus the files. The idempotency key
 * is per compose session, so a retried or double-clicked Send can't create two campaigns.
 */
export function useScheduleCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ request, files, idempotencyKey }: { request: ScheduleRequest; files: File[]; idempotencyKey: string }) => {
      const form = new FormData();
      form.set('payload', JSON.stringify(request));
      for (const f of files) form.append('attachments', f, f.name);
      return api<ScheduleResult>('/emails/schedule', { method: 'POST', body: form, headers: { 'Idempotency-Key': idempotencyKey } });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['emails'] });
      void qc.invalidateQueries({ queryKey: ['stats'] });
    },
  });
}

/**
 * Plain browsing reads Postgres (`/emails`); typing a query switches to Elasticsearch
 * (`/emails/search`). Both return the same page shape.
 */
export function useEmailList(f: EmailFilters) {
  return useInfiniteQuery({
    queryKey: ['emails', f],
    initialPageParam: 1,
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ view: f.view, page: String(pageParam), pageSize: String(PAGE_SIZE) });
      if (f.senderId) params.set('senderId', f.senderId);
      if (f.status) params.set('status', f.status);
      if (f.q) params.set('q', f.q);
      return api<Page>(`/emails${f.q ? '/search' : ''}?${params}`, { signal });
    },
    getNextPageParam: (last) => (last.page < last.totalPages ? last.page + 1 : undefined),
    refetchInterval: POLL_MS,
    placeholderData: (prev) => prev, // keep rows on screen while a new search loads
  });
}

export function useEmail(id: string) {
  return useQuery({
    queryKey: ['email', id],
    queryFn: async () => (await api<{ email: EmailDetail }>(`/emails/${id}`)).email,
    // A scheduled email changes state on its own; keep an open one current.
    refetchInterval: (q) => (q.state.data && ['SCHEDULED', 'PROCESSING', 'SENDING'].includes(q.state.data.status) ? POLL_MS : false),
    retry: (n, err) => !(err instanceof ApiError && err.status === 404) && n < 1,
  });
}

/** Only SCHEDULED emails can be cancelled; the server answers 409 otherwise. */
export function useCancelEmail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/emails/${id}`, { method: 'DELETE' }),
    onSettled: (_d, _e, id) => {
      void qc.invalidateQueries({ queryKey: ['email', id] });
      void qc.invalidateQueries({ queryKey: ['emails'] });
      void qc.invalidateQueries({ queryKey: ['stats'] });
    },
  });
}

/** Optimistic: the star flips instantly and flips back if the request fails. */
export function useToggleStar() {
  const qc = useQueryClient();
  type Snapshot = [readonly unknown[], InfiniteData<Page> | undefined][];
  const setDetailStar = (id: string, starred: boolean) =>
    qc.setQueryData<EmailDetail>(['email', id], (e) => e && { ...e, starred });

  const setStar = (id: string, starred: boolean) =>
    qc.setQueriesData<InfiniteData<Page>>({ queryKey: ['emails'] }, (data) => data && {
      ...data,
      pages: data.pages.map((p) => ({
        ...p,
        items: p.items.map((e) => (e.id === id ? { ...e, starred } : e)),
      })),
    });

  return useMutation({
    mutationFn: ({ id, starred }: { id: string; starred: boolean }) =>
      api<{ id: string; starred: boolean }>(`/emails/${id}/star`, { method: 'PUT', json: { starred } }),
    onMutate: async ({ id, starred }) => {
      await qc.cancelQueries({ queryKey: ['emails'] });
      const snapshot: Snapshot = qc.getQueriesData<InfiniteData<Page>>({ queryKey: ['emails'] });
      setStar(id, starred);
      setDetailStar(id, starred);
      return { snapshot };
    },
    onError: (_err, { id, starred }, ctx) => {
      ctx?.snapshot.forEach(([key, data]) => qc.setQueryData(key, data));
      setDetailStar(id, !starred);
    },
  });
}

/** "Send again" for an UNCERTAIN email: returns the NEW email (or the existing copy). */
export function useResendEmail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ email: { id: string }; created: boolean }>(`/emails/${id}/resend`, { method: 'POST' }),
    onSettled: (_d, _e, id) => {
      void qc.invalidateQueries({ queryKey: ['email', id] });
      void qc.invalidateQueries({ queryKey: ['emails'] });
      void qc.invalidateQueries({ queryKey: ['stats'] });
    },
  });
}
