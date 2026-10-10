import { ApiError } from './api';

// Mirrors backend/src/modules/auth/auth.service.ts: the server re-validates everything.
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type FieldErrors<K extends string> = Partial<Record<K, string>>;

export function validateEmail(v: string): string | undefined {
  const e = v.trim();
  if (!e) return 'Email is required';
  if (e.length > 254 || !EMAIL_RE.test(e)) return 'Enter a valid email address';
}

export function validateNewPassword(v: string): string | undefined {
  if (!v) return 'Password is required';
  if (v.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters`;
  if (v.length > PASSWORD_MAX) return `Password must be at most ${PASSWORD_MAX} characters`;
}

export function validateName(v: string): string | undefined {
  if (!v.trim()) return 'Name is required';
  if (v.trim().length > 100) return 'Name is too long';
}

/** Splits an API failure into per-field messages (400 validation) or one toast message. */
export function describeError<K extends string>(err: unknown, fields: readonly K[]): {
  fieldErrors: FieldErrors<K>;
  message?: string;
} {
  if (err instanceof ApiError) {
    if (err.code === 'VALIDATION_ERROR' && Array.isArray(err.details)) {
      const fieldErrors: FieldErrors<K> = {};
      for (const d of err.details as { path: string; message: string }[]) {
        if ((fields as readonly string[]).includes(d.path)) fieldErrors[d.path as K] ??= d.message;
      }
      if (Object.keys(fieldErrors).length) return { fieldErrors };
    }
    return { fieldErrors: {}, message: err.message };
  }
  return { fieldErrors: {}, message: 'Can’t reach the server. Check your connection and try again.' };
}

/** Server message wins when present; otherwise the live client-side one. */
export function mergeErrors<K extends string>(local: FieldErrors<K>, server: FieldErrors<K>): FieldErrors<K> {
  const out: FieldErrors<K> = { ...local };
  for (const k of Object.keys(server) as K[]) if (server[k]) out[k] = server[k];
  return out;
}
