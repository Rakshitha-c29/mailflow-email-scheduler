import jwt from 'jsonwebtoken';
import type { CookieOptions, Response } from 'express';
import { env } from '../../config/env';

/** What the API exposes about the signed-in user (`/api/auth/me`). */
export interface SessionUser {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}

/** A user a session is issued for, with their current `users.session_version`. */
export interface SessionSubject extends SessionUser {
  sessionVersion: number;
}

export interface SessionClaims {
  user: SessionUser;
  /** Must equal the user's current session_version, or the session was revoked. */
  sessionVersion: number;
  /** Epoch ms the token was issued (for "recent sign-in" checks). */
  issuedAt: number;
}

export const SESSION_COOKIE = 'ri_session';
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

export const baseCookie: CookieOptions = {
  httpOnly: true,
  secure: env.COOKIE_SECURE,
  sameSite: 'lax', // sent on top-level OAuth redirects, blocked on cross-site POSTs (CSRF)
  path: '/',
};

export const toPublicUser = ({ id, email, name, avatarUrl }: SessionUser): SessionUser => ({ id, email, name, avatarUrl });

export function signSession(s: SessionSubject): string {
  return jwt.sign({ ...toPublicUser(s), sv: s.sessionVersion }, env.SESSION_SECRET, {
    expiresIn: MAX_AGE_MS / 1000,
    subject: s.id,
  });
}

export function setSession(res: Response, s: SessionSubject): void {
  res.cookie(SESSION_COOKIE, signSession(s), { ...baseCookie, maxAge: MAX_AGE_MS });
}

export function clearSession(res: Response): void {
  res.clearCookie(SESSION_COOKIE, baseCookie);
}

/**
 * Verifies the signature and expiry only. Whether the session was revoked (version
 * bumped) is checked by `authenticate()` in middleware/auth.ts.
 */
export function readSession(token: string | undefined): SessionClaims | null {
  if (!token) return null;
  try {
    const p = jwt.verify(token, env.SESSION_SECRET) as jwt.JwtPayload & SessionUser & { sv?: unknown };
    if (typeof p.sv !== 'number' || typeof p.iat !== 'number') return null; // pre-versioning tokens
    return {
      user: { id: p.id, email: p.email, name: p.name, avatarUrl: p.avatarUrl ?? null },
      sessionVersion: p.sv,
      issuedAt: p.iat * 1000,
    };
  } catch {
    return null;
  }
}
