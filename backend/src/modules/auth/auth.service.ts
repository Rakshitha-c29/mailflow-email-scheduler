import argon2 from 'argon2';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { env } from '../../config/env';
import { db } from '../../lib/db';
import { logger } from '../../lib/logger';
import { randomToken } from '../../lib/crypto';
import { AppError, badRequest, isUniqueViolation } from '../../lib/errors';
import { users, type User } from '../../db/schema';
import { ensureSenders } from '../senders/sender.service';
import { attemptKey, clear, hit, peek, tooMany } from './attemptLimiter';
import type { SessionSubject } from './session';
import { nextSessionVersion, publishSessionVersion } from './sessionVersion';

// ── Validation ────────────────────────────────────────────────────────────────

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

const emailField = z
  .string({ required_error: 'Email is required' })
  .trim()
  .toLowerCase()
  .min(1, 'Email is required')
  .max(254, 'Email is too long')
  .email('Enter a valid email address');

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128; // also bounds hashing cost per request

export const signupSchema = z.object({
  name: z.string({ required_error: 'Name is required' }).trim().min(1, 'Name is required').max(100, 'Name is too long'),
  email: emailField,
  password: z
    .string({ required_error: 'Password is required' })
    .min(PASSWORD_MIN, `Password must be at least ${PASSWORD_MIN} characters`)
    .max(PASSWORD_MAX, `Password must be at most ${PASSWORD_MAX} characters`),
});
export type SignupInput = z.infer<typeof signupSchema>;

// Login doesn't re-check the signup rules (they may change); only the hashing-cost cap.
export const loginSchema = z.object({
  email: emailField,
  password: z
    .string({ required_error: 'Password is required' })
    .min(1, 'Password is required')
    .max(PASSWORD_MAX, `Password must be at most ${PASSWORD_MAX} characters`),
});
export type LoginInput = z.infer<typeof loginSchema>;

// ── Hashing ───────────────────────────────────────────────────────────────────

const HASH_OPTIONS = { type: argon2.argon2id } as const; // library defaults: m=64MiB, t=3, p=4

/** Verified against when the email doesn't exist, so response time doesn't reveal that. */
let dummyHash: Promise<string> | undefined;
const getDummyHash = () => (dummyHash ??= argon2.hash(randomToken(), HASH_OPTIONS));

// ── Errors ────────────────────────────────────────────────────────────────────

/** Deliberately identical for "no such user" and "wrong password". */
const invalidCredentials = () => new AppError(401, 'Invalid email or password', 'INVALID_CREDENTIALS');

const toSession = (u: User): SessionSubject => ({
  id: u.id, email: u.email, name: u.name, avatarUrl: u.avatarUrl, sessionVersion: u.sessionVersion,
});

// ── Password auth ─────────────────────────────────────────────────────────────

export async function signup(input: SignupInput, ip: string): Promise<SessionSubject> {
  const [byIp, byEmail] = await Promise.all([
    hit(attemptKey('signup', 'ip', ip), env.AUTH_ATTEMPT_WINDOW_S),
    hit(attemptKey('signup', 'email', input.email), env.AUTH_ATTEMPT_WINDOW_S),
  ]);
  if (byIp.count > env.SIGNUP_MAX_PER_IP) throw tooMany('signup', byIp.ttl);
  if (byEmail.count > env.SIGNUP_MAX_PER_EMAIL) throw tooMany('signup', byEmail.ttl);

  const passwordHash = await argon2.hash(input.password, HASH_OPTIONS);
  let user: User;
  try {
    [user] = await db.insert(users).values({ name: input.name, email: input.email, passwordHash }).returning();
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AppError(409, 'An account with this email already exists. Please log in instead.', 'EMAIL_TAKEN');
    }
    throw err;
  }

  // Same as Google login: never block sign-up on Ethereal; the senders endpoint self-heals.
  await ensureSenders(user.id).catch((err) => logger.warn({ err }, 'sender provisioning deferred'));
  logger.info({ userId: user.id }, 'password account created');
  return toSession(user);
}

/**
 * Limits: every attempt counts against the IP; only *failed* attempts count against the
 * email (so a successful login resets it, and an attacker can't lock a user out for
 * longer than one window).
 */
export async function login(input: LoginInput, ip: string): Promise<SessionSubject> {
  const ipKey = attemptKey('login', 'ip', ip);
  const emailKey = attemptKey('login', 'email', input.email);

  const byIp = await hit(ipKey, env.AUTH_ATTEMPT_WINDOW_S);
  if (byIp.count > env.LOGIN_MAX_PER_IP) throw tooMany('login', byIp.ttl);
  const byEmail = await peek(emailKey);
  if (byEmail.count >= env.LOGIN_MAX_FAILURES_PER_EMAIL) throw tooMany('login', byEmail.ttl);

  const fail = async (err: AppError) => {
    await hit(emailKey, env.AUTH_ATTEMPT_WINDOW_S);
    return err;
  };

  const user = await db.query.users.findFirst({ where: eq(users.email, input.email) });
  if (!user) {
    await argon2.verify(await getDummyHash(), input.password).catch(() => false);
    throw await fail(invalidCredentials());
  }
  if (!user.passwordHash) {
    throw await fail(new AppError(400, 'This account uses Google sign-in', 'USE_GOOGLE_SIGN_IN'));
  }
  if (!(await argon2.verify(user.passwordHash, input.password))) {
    throw await fail(invalidCredentials());
  }

  await clear(emailKey);
  // Transparently upgrade hashes made with older/weaker parameters.
  if (argon2.needsRehash(user.passwordHash)) {
    const passwordHash = await argon2.hash(input.password, HASH_OPTIONS);
    await db.update(users).set({ passwordHash }).where(eq(users.id, user.id));
  }
  return toSession(user);
}

// ── Google ────────────────────────────────────────────────────────────────────

export interface GoogleProfile {
  sub: string;
  /** Must already be verified by Google (the callback checks `email_verified`). */
  email: string;
  name: string;
  avatarUrl: string | null;
}

/**
 * Resolves the account for a verified Google identity:
 *   1. known Google id        → refresh profile (as before)
 *   2. same email, no Google  → link: attach the Google id to the password account
 *   3. otherwise              → create a Google-only account
 *
 * Linking closes account pre-hijacking: password sign-up never proves email ownership,
 * Google does. So the unverified password is deleted and every existing session is
 * revoked (session_version bump); whoever set that password is locked out. The owner can
 * set a new password afterwards (`setPassword`), which is then verified by construction.
 */
export async function findOrCreateGoogleUser(p: GoogleProfile, isRetry = false): Promise<SessionSubject> {
  const email = normalizeEmail(p.email);

  const existing = await db.query.users.findFirst({ where: eq(users.googleId, p.sub) });
  if (existing) {
    const profile = { name: p.name, avatarUrl: p.avatarUrl };
    try {
      const [u] = await db.update(users).set({ ...profile, email }).where(eq(users.id, existing.id)).returning();
      return toSession(u);
    } catch (err) {
      // Their Google email changed to one another account already uses: keep the old email.
      if (!isUniqueViolation(err)) throw err;
      const [u] = await db.update(users).set(profile).where(eq(users.id, existing.id)).returning();
      return toSession(u);
    }
  }

  const byEmail = await db.query.users.findFirst({ where: eq(users.email, email) });
  if (byEmail) {
    const [linked] = await db
      .update(users)
      .set({
        googleId: p.sub,
        avatarUrl: byEmail.avatarUrl ?? p.avatarUrl,
        passwordHash: null,
        sessionVersion: nextSessionVersion,
      })
      .where(and(eq(users.id, byEmail.id), isNull(users.googleId)))
      .returning();
    if (!linked) throw new AppError(409, 'This email is already linked to a different Google account', 'GOOGLE_CONFLICT');
    await publishSessionVersion(linked.id, linked.sessionVersion);
    logger.info({ userId: linked.id }, 'google sign-in linked: unverified password removed, old sessions revoked');
    return toSession(linked);
  }

  try {
    const [created] = await db
      .insert(users)
      .values({ googleId: p.sub, email, name: p.name, avatarUrl: p.avatarUrl })
      .returning();
    return toSession(created);
  } catch (err) {
    // Two first logins raced (same Google id or email): the other one won, resolve again.
    if (isUniqueViolation(err) && !isRetry) return findOrCreateGoogleUser(p, true);
    throw err;
  }
}

// ── Set password (signed-in users) ────────────────────────────────────────────

export const setPasswordSchema = z.object({
  password: signupSchema.shape.password,
  currentPassword: z.string().max(PASSWORD_MAX).optional(),
});
export type SetPasswordInput = z.infer<typeof setPasswordSchema>;

/** A Google-only user must have signed in this recently to add a password. */
export const RECENT_SIGN_IN_MS = 15 * 60_000;

/**
 * Sets (or changes) the password of the signed-in user and revokes all other sessions.
 *
 * - Has a password already → the current one is required (a stolen session alone can't
 *   change it). Wrong attempts count toward the per-email login limit.
 * - Google-only → requires a recent sign-in instead, so an old, possibly stolen session
 *   can't plant a password. Either way the email is verified: via Google, or via the
 *   password that was itself set by a verified owner.
 *
 * Returns the user with the new session version; the caller re-issues this device's cookie.
 */
export async function setPassword(
  userId: string, input: SetPasswordInput, session: { issuedAt: number },
): Promise<SessionSubject> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw new AppError(401, 'Not authenticated', 'UNAUTHORIZED');

  if (user.passwordHash) {
    const emailKey = attemptKey('login', 'email', user.email);
    const byEmail = await peek(emailKey);
    if (byEmail.count >= env.LOGIN_MAX_FAILURES_PER_EMAIL) throw tooMany('login', byEmail.ttl);
    if (!input.currentPassword) throw badRequest('Current password is required');
    if (!(await argon2.verify(user.passwordHash, input.currentPassword))) {
      await hit(emailKey, env.AUTH_ATTEMPT_WINDOW_S);
      throw new AppError(401, 'Current password is incorrect', 'INVALID_CREDENTIALS');
    }
  } else if (Date.now() - session.issuedAt > RECENT_SIGN_IN_MS) {
    throw new AppError(403, 'For your security, please sign in with Google again before setting a password.', 'REAUTH_REQUIRED');
  }

  const passwordHash = await argon2.hash(input.password, HASH_OPTIONS);
  const [updated] = await db
    .update(users)
    .set({ passwordHash, sessionVersion: nextSessionVersion })
    .where(eq(users.id, userId))
    .returning();
  await publishSessionVersion(updated.id, updated.sessionVersion);
  logger.info({ userId }, 'password set, other sessions revoked');
  return toSession(updated);
}
