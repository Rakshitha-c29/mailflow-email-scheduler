import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { env } from '../../config/env';
import { AppError, badRequest } from '../../lib/errors';
import { requireAuth } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/asyncHandler';
import { listQuerySchema, scheduleSchema, searchQuerySchema, starSchema } from './email.schemas';
import { cancelEmail, getEmail, getStats, listEmails, resendUncertain, scheduleCampaign, setStarred } from './email.service';
import { searchEmails } from '../search/search.service';
import { getAttachmentForEmail, INLINE_TYPES, validateAttachments } from '../attachments/attachment.service';

export const emailRouter = Router();
emailRouter.use(requireAuth);

const idemKey = z.string().trim().min(8).max(128).optional();

/**
 * multipart/form-data: `payload` (the JSON schedule request) + up to N `attachments`.
 * Files stay in memory (bounded by the limits below) and go straight to Postgres.
 * Multer stops reading as soon as a limit is exceeded, so oversized uploads are cut off early.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: env.ATTACHMENT_MAX_FILES,
    fileSize: env.ATTACHMENT_MAX_TOTAL_BYTES,
    fields: 4,
    fieldSize: 4 * 1024 * 1024, // the JSON payload (10k recipients fit comfortably)
    parts: env.ATTACHMENT_MAX_FILES + 4,
  },
});

function acceptUploads(req: Request, res: Response, next: NextFunction) {
  if (!req.is('multipart/form-data')) return next(); // plain JSON requests keep working
  upload.array('attachments', env.ATTACHMENT_MAX_FILES)(req, res, (err: unknown) => {
    if (!(err instanceof multer.MulterError)) return next(err);
    const mb = Math.round(env.ATTACHMENT_MAX_TOTAL_BYTES / 1024 / 1024);
    switch (err.code) {
      case 'LIMIT_FILE_SIZE': return next(new AppError(413, `Attachments are limited to ${mb} MB in total`, 'ATTACHMENTS_TOO_LARGE'));
      case 'LIMIT_FILE_COUNT':
      case 'LIMIT_UNEXPECTED_FILE': return next(badRequest(`At most ${env.ATTACHMENT_MAX_FILES} attachments are allowed`));
      case 'LIMIT_FIELD_VALUE': return next(new AppError(413, 'Request is too large', 'TOO_LARGE'));
      default: return next(badRequest(`Upload rejected: ${err.message}`));
    }
  });
}

emailRouter.post('/schedule', acceptUploads, asyncHandler(async (req, res) => {
  let body: unknown = req.body;
  if (req.is('multipart/form-data')) {
    try {
      body = JSON.parse(String(req.body?.payload ?? ''));
    } catch {
      throw badRequest('Missing or invalid "payload" field');
    }
  }
  const input = scheduleSchema.parse(body);
  const files = validateAttachments((req.files as Express.Multer.File[] | undefined) ?? []);
  const key = idemKey.parse(req.header('Idempotency-Key') || undefined);
  const result = await scheduleCampaign(req.user!.id, input, key, files);
  res.status(result.replayed ? 200 : 201).json(result);
}));

emailRouter.get('/', asyncHandler(async (req, res) => {
  res.json(await listEmails(req.user!.id, listQuerySchema.parse(req.query)));
}));

emailRouter.get('/stats', asyncHandler(async (req, res) => {
  res.json(await getStats(req.user!.id));
}));

emailRouter.get('/search', asyncHandler(async (req, res) => {
  res.json(await searchEmails(req.user!.id, searchQuerySchema.parse(req.query)));
}));

emailRouter.get('/:id', asyncHandler(async (req, res) => {
  res.json({ email: await getEmail(req.user!.id, z.string().uuid().parse(req.params.id)) });
}));

/**
 * Download/preview. Images are served inline (for thumbnails), everything else as a
 * download. The stored content type comes from the verified file type, and the response
 * is sandboxed so even a crafted file can't run script on our origin.
 */
emailRouter.get('/:id/attachments/:attachmentId', asyncHandler(async (req, res) => {
  const a = await getAttachmentForEmail(
    req.user!.id, z.string().uuid().parse(req.params.id), z.string().uuid().parse(req.params.attachmentId),
  );
  const inline = INLINE_TYPES.has(a.contentType) && req.query.download === undefined;
  const ascii = a.filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  res.set({
    'Content-Type': a.contentType,
    'Content-Length': String(a.content.length),
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(a.filename)}`,
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; sandbox",
    'Cache-Control': 'private, max-age=3600',
  });
  res.end(a.content);
}));

emailRouter.delete('/:id', asyncHandler(async (req, res) => {
  await cancelEmail(req.user!.id, z.string().uuid().parse(req.params.id));
  res.status(204).end();
}));

emailRouter.put('/:id/star', asyncHandler(async (req, res) => {
  const { starred } = starSchema.parse(req.body);
  res.json(await setStarred(req.user!.id, z.string().uuid().parse(req.params.id), starred));
}));

/** "Send again" for an UNCERTAIN email: 201 with the new email, or 200 with the existing copy. */
emailRouter.post('/:id/resend', asyncHandler(async (req, res) => {
  const result = await resendUncertain(req.user!.id, z.string().uuid().parse(req.params.id));
  res.status(result.created ? 201 : 200).json(result);
}));
