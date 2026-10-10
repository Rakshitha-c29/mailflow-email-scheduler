import express, { type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
import { rateLimit } from 'express-rate-limit';
import { ZodError } from 'zod';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { env } from './config/env';
import { logger } from './lib/logger';
import { pool } from './lib/db';
import { redis } from './lib/redis';
import { es } from './lib/elastic';
import { AppError, notFound, TooManyRequestsError } from './lib/errors';
import { allQueues } from './queues';
import { asyncHandler } from './middleware/asyncHandler';
import { requireAdminPage } from './middleware/auth';
import { authRouter } from './modules/auth/auth.routes';
import { emailRouter } from './modules/emails/email.routes';
import { senderRouter } from './modules/senders/sender.routes';
import { slackRouter } from './modules/slack/slack.routes';

const limiter = (limit: number, windowMs = 60_000) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: { code: 'RATE_LIMITED', message: 'Too many requests, please slow down.' } },
  });

export function createApp(): express.Express {
  const app = express();

  // Trust only a proxy on this machine (the Vite dev proxy, a local nginx) for client IPs,
  // so rate limiting keys on the real client without letting anyone spoof X-Forwarded-For.
  app.set('trust proxy', 'loopback');
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(cors({ origin: env.FRONTEND_URL, credentials: true }));
  app.use(cookieParser());
  app.use(express.json({ limit: '2mb' })); // 10k recipients + a large body fit comfortably
  app.use(pinoHttp({
    logger,
    autoLogging: { ignore: (req) => req.url === '/api/health' },
    customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
  }));

  app.get('/api/health', asyncHandler(async (_req, res) => {
    const [postgres, redisStatus, elasticsearch] = await Promise.all([
      probe(() => pool.query('select 1')),
      probe(() => redis.ping()),
      probe(() => es.ping(undefined, { requestTimeout: 2000, maxRetries: 0 })),
    ]);
    // Search is a read model: without it the app still schedules and sends, so it's "degraded".
    const up = postgres === 'ok' && redisStatus === 'ok';
    res.status(up ? 200 : 503).json({
      status: !up ? 'down' : elasticsearch === 'ok' ? 'ok' : 'degraded',
      checks: { postgres, redis: redisStatus, elasticsearch },
    });
  }));

  app.use('/api', limiter(300));
  // Stricter per-IP cap only where guessing is possible; reading the session (/me, /account)
  // happens on every page load and is covered by the general /api limit above. The
  // per-account brute-force limits live in Redis (modules/auth/attemptLimiter.ts).
  app.use(['/api/auth/login', '/api/auth/signup', '/api/auth/password', '/api/auth/google'], limiter(30));
  app.use('/api/auth', authRouter);
  app.post('/api/emails/schedule', limiter(10)); // each call can create thousands of jobs
  app.use('/api/emails', emailRouter);
  app.use('/api/senders', senderRouter);
  app.use('/api/integrations/slack', slackRouter);
  app.use('/api', (_req, _res, next) => next(notFound('Route')));

  const board = new ExpressAdapter();
  board.setBasePath('/admin/queues');
  // Read-only: the dashboard can view jobs but not retry, promote, delete or pause them
  // (Bull Board refuses those requests server-side with 405, not just in the UI).
  createBullBoard({ queues: allQueues.map((q) => new BullMQAdapter(q, { readOnlyMode: true })), serverAdapter: board });
  app.use('/admin/queues', requireAdminPage(env.FRONTEND_URL), board.getRouter());

  app.use(errorHandler);
  return app;
}

/** Health probes must answer fast even when a dependency hangs (ioredis queues commands while reconnecting). */
async function probe(fn: () => Promise<unknown>, timeoutMs = 2000): Promise<'ok' | 'down'> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([fn(), new Promise((_, reject) => { timer = setTimeout(reject, timeoutMs); })]);
    return 'ok';
  } catch {
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}

/** Every error leaves as `{ error: { code, message, details? } }`. */
const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: err.issues[0]?.message ?? 'Invalid request',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
    return;
  }
  if (err instanceof AppError) {
    if (err instanceof TooManyRequestsError) res.setHeader('Retry-After', String(err.retryAfterS));
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  // body-parser errors
  if (err?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'BAD_JSON', message: 'Request body is not valid JSON' } });
    return;
  }
  if (err?.type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'TOO_LARGE', message: 'Request body is too large' } });
    return;
  }
  (req.log ?? logger).error({ err }, 'unhandled error');
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
};
