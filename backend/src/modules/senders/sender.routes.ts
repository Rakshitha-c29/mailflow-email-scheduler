import { Router } from 'express';
import { requireAuth } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/asyncHandler';
import { createEtherealSender, ensureSenders, listSenders } from './sender.service';
import { getWindowUsage, effectiveLimit } from '../../scheduler/rateLimiter';
import { env } from '../../config/env';
import { ALLOWED_EXTENSIONS } from '../attachments/attachment.service';

export const senderRouter = Router();
senderRouter.use(requireAuth);

senderRouter.get('/', asyncHandler(async (req, res) => {
  await ensureSenders(req.user!.id); // self-heal if provisioning failed at login
  const list = await listSenders(req.user!.id);
  const withUsage = await Promise.all(
    list.map(async (s) => ({ ...s, sentThisHour: await getWindowUsage(s.id) })),
  );
  res.json({ senders: withUsage, limits: {
    maxPerHourPerSender: effectiveLimit(Number.MAX_SAFE_INTEGER),
    minDelayMs: env.MIN_DELAY_BETWEEN_EMAILS_MS,
    // The "hourly" limit applies per window; anything but 1 hour is a shortened demo setting.
    windowMs: env.RATE_WINDOW_MS,
    maxRecipients: env.MAX_RECIPIENTS_PER_CAMPAIGN,
    // The compose UI mirrors these; the server enforces them regardless.
    attachments: {
      maxFiles: env.ATTACHMENT_MAX_FILES,
      maxTotalBytes: env.ATTACHMENT_MAX_TOTAL_BYTES,
      extensions: ALLOWED_EXTENSIONS,
    },
  } });
}));

senderRouter.post('/', asyncHandler(async (req, res) => {
  const existing = await listSenders(req.user!.id);
  if (existing.length >= 10) {
    res.status(400).json({ error: { code: 'LIMIT', message: 'Maximum of 10 senders' } });
    return;
  }
  const s = await createEtherealSender(req.user!.id, `Sender ${existing.length + 1}`);
  res.status(201).json({ sender: { id: s.id, name: s.name, email: s.email, createdAt: s.createdAt } });
}));
