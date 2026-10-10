import { Router } from 'express';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { AppError } from '../../lib/errors';
import { requireAuth } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/asyncHandler';
import { buildInstallUrl, completeInstall, disconnect, getStatus, sendSlackMessage } from './slack.service';
import { TEST_MESSAGE } from './messages';

export const slackRouter = Router();

slackRouter.get('/', requireAuth, asyncHandler(async (req, res) => {
  res.json(await getStatus(req.user!.id));
}));

/** Browser navigates here from "Connect Slack"; we redirect to Slack's consent screen. */
slackRouter.get('/install', requireAuth, asyncHandler(async (req, res) => {
  res.redirect(await buildInstallUrl(req.user!.id));
}));

/** Slack redirects back here (no session needed: the one-time state identifies the user). */
slackRouter.get('/callback', asyncHandler(async (req, res) => {
  const { code, state, error } = req.query as Record<string, string | undefined>;
  const back = (result: string) => res.redirect(`${env.FRONTEND_URL}/dashboard?slack=${result}`);
  if (error || !code || !state) return back('cancelled');
  try {
    await completeInstall(code, state);
    back('connected');
  } catch (err) {
    logger.warn({ err }, 'slack callback failed');
    back('error');
  }
}));

slackRouter.post('/test', requireAuth, asyncHandler(async (req, res) => {
  const result = await sendSlackMessage(req.user!.id, TEST_MESSAGE);
  if (result !== 'sent') throw new AppError(409, 'Slack is not connected', 'SLACK_NOT_CONNECTED');
  res.json({ ok: true });
}));

/**
 * Slack's Interactivity "Request URL". Our only interactive element is the alert's
 * "Open dashboard" link button, which needs no server action; Slack still posts the click
 * here, and a 200 stops it showing a warning icon. Nothing is read or trusted from the body.
 */
slackRouter.post('/interactions', (_req, res) => {
  res.status(200).end();
});

slackRouter.delete('/', requireAuth, asyncHandler(async (req, res) => {
  await disconnect(req.user!.id);
  res.status(204).end();
}));
