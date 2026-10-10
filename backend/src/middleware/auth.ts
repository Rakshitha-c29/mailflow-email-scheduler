import type { NextFunction, Request, Response } from 'express';
import { adminEmails } from '../config/env';
import { forbidden, unauthorized } from '../lib/errors';
import { readSession, SESSION_COOKIE, type SessionClaims, type SessionUser } from '../modules/auth/session';
import { getSessionVersion } from '../modules/auth/sessionVersion';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
      session?: SessionClaims;
    }
  }
}

/**
 * Valid signature + not expired + not revoked (the token's session version still
 * matches the user's current one; cached in Redis). Null if any check fails.
 */
export async function authenticate(req: Request): Promise<SessionClaims | null> {
  const claims = readSession(req.cookies?.[SESSION_COOKIE]);
  if (!claims) return null;
  const current = await getSessionVersion(claims.user.id);
  return current !== null && current === claims.sessionVersion ? claims : null;
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  authenticate(req).then((claims) => {
    if (!claims) return next(unauthorized());
    req.user = claims.user;
    req.session = claims;
    next();
  }, next);
}

/** Bull Board guard: browser-friendly (redirects to login instead of JSON 401). */
export function requireAdminPage(frontendUrl: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    authenticate(req).then((claims) => {
      if (!claims) return res.redirect(`${frontendUrl}/login`);
      if (adminEmails.length && !adminEmails.includes(claims.user.email.toLowerCase())) return next(forbidden());
      req.user = claims.user;
      req.session = claims;
      next();
    }, next);
  };
}
