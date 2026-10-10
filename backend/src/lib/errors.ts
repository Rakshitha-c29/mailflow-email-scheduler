export class AppError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code = 'ERROR',
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

/** 429 with a Retry-After header (set by the error handler). */
export class TooManyRequestsError extends AppError {
  constructor(message: string, public readonly retryAfterS: number) {
    super(429, message, 'TOO_MANY_ATTEMPTS', { retryAfterSeconds: retryAfterS });
  }
}

/**
 * Postgres unique-constraint violation (23505). Drizzle wraps driver errors in
 * DrizzleQueryError, so the pg error with `.code` may be on `.cause`.
 */
export function isUniqueViolation(err: unknown): boolean {
  let e = err as { code?: string; cause?: unknown } | undefined;
  for (let depth = 0; e && depth < 3; depth++, e = e.cause as typeof e) {
    if (e.code === '23505') return true;
  }
  return false;
}

export const notFound = (what = 'Resource') => new AppError(404, `${what} not found`, 'NOT_FOUND');
export const badRequest = (msg: string, details?: unknown) => new AppError(400, msg, 'BAD_REQUEST', details);
export const unauthorized = () => new AppError(401, 'Not authenticated', 'UNAUTHORIZED');
export const forbidden = () => new AppError(403, 'Forbidden', 'FORBIDDEN');
export const unavailable = (msg: string) => new AppError(503, msg, 'SERVICE_UNAVAILABLE');
