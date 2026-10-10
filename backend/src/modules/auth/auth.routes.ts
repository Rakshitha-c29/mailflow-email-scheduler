import crypto from 'node:crypto';
import { Router, type Request } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { randomToken } from '../../lib/crypto';
import { AppError } from '../../lib/errors';
import { db } from '../../lib/db';
import { users } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { asyncHandler } from '../../middleware/asyncHandler';
import { requireAuth } from '../../middleware/auth';
import { baseCookie, clearSession, setSession, toPublicUser } from './session';
import { ensureSenders } from '../senders/sender.service';
import {
  findOrCreateGoogleUser, login, loginSchema, setPassword, setPasswordSchema, signup, signupSchema,
} from './auth.service';

export const authRouter = Router();

const google = new OAuth2Client({
  clientId: env.GOOGLE_CLIENT_ID,
  clientSecret: env.GOOGLE_CLIENT_SECRET,
  redirectUri: env.GOOGLE_REDIRECT_URI,
});
const STATE_COOKIE = 'ri_oauth_state';
const fail = (reason: string) => `${env.FRONTEND_URL}/login?error=${encodeURIComponent(reason)}`;
// `trust proxy` (app.ts) decides whether X-Forwarded-For is believed.
const clientIp = (req: Request) => req.ip ?? req.socket.remoteAddress ?? 'unknown';

/** Step 1: redirect to Google with a CSRF `state` bound to this browser via cookie. */
authRouter.get('/google', (_req, res) => {
  const state = randomToken();
  res.cookie(STATE_COOKIE, state, { ...baseCookie, maxAge: 10 * 60 * 1000 });
  res.redirect(
    google.generateAuthUrl({
      scope: ['openid', 'email', 'profile'],
      state,
      prompt: 'select_account',
    }),
  );
});

/** Step 2: verify state, exchange code, verify the ID token signature, upsert user. */
authRouter.get('/google/callback', asyncHandler(async (req, res) => {
  const { code, state, error } = req.query as Record<string, string | undefined>;
  const expected = req.cookies?.[STATE_COOKIE] as string | undefined;
  res.clearCookie(STATE_COOKIE, baseCookie);

  if (error) return res.redirect(fail('Google sign-in was cancelled'));
  if (!code || !state || !expected || state.length !== expected.length
    || !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(expected))) {
    return res.redirect(fail('Invalid login state, please try again'));
  }

  try {
    const { tokens } = await google.getToken(code);
    const ticket = await google.verifyIdToken({ idToken: tokens.id_token!, audience: env.GOOGLE_CLIENT_ID });
    const p = ticket.getPayload();
    if (!p?.sub || !p.email || !p.email_verified) return res.redirect(fail('Google account email is not verified'));

    const user = await findOrCreateGoogleUser({
      sub: p.sub, email: p.email, name: p.name ?? p.email, avatarUrl: p.picture ?? null,
    });

    // Provision Ethereal senders on first login. Never block login on it: the senders
    // endpoint self-heals if Ethereal is briefly unavailable.
    await ensureSenders(user.id).catch((err) => logger.warn({ err }, 'sender provisioning deferred'));

    setSession(res, user);
    res.redirect(`${env.FRONTEND_URL}/dashboard`);
  } catch (err) {
    logger.error({ err }, 'google oauth callback failed');
    res.redirect(fail(err instanceof AppError && err.status < 500 ? err.message : 'Google sign-in failed'));
  }
}));

/** Email + password: same session cookie as Google. */
authRouter.post('/signup', asyncHandler(async (req, res) => {
  const user = await signup(signupSchema.parse(req.body), clientIp(req));
  setSession(res, user);
  res.status(201).json({ user: toPublicUser(user) });
}));

authRouter.post('/login', asyncHandler(async (req, res) => {
  const user = await login(loginSchema.parse(req.body), clientIp(req));
  setSession(res, user);
  res.json({ user: toPublicUser(user) });
}));

/**
 * Set or change the password of the signed-in user. Revokes every other session; this
 * device gets a fresh cookie so it stays signed in.
 */
authRouter.post('/password', requireAuth, asyncHandler(async (req, res) => {
  const user = await setPassword(req.user!.id, setPasswordSchema.parse(req.body), req.session!);
  setSession(res, user);
  res.json({ user: toPublicUser(user) });
}));

/** Sign-in methods of the current account (the Set password dialog adapts to them). */
authRouter.get('/account', requireAuth, asyncHandler(async (req, res) => {
  const u = await db.query.users.findFirst({
    where: eq(users.id, req.user!.id), columns: { email: true, passwordHash: true, googleId: true },
  });
  if (!u) throw new AppError(401, 'Not authenticated', 'UNAUTHORIZED');
  res.json({ email: u.email, hasPassword: Boolean(u.passwordHash), hasGoogle: Boolean(u.googleId) });
}));

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

authRouter.post('/logout', (_req, res) => {
  clearSession(res);
  res.status(204).end();
});
