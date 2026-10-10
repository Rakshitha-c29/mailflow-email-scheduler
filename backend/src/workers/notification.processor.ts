import type { Job } from 'bullmq';
import { and, count, eq, gte, inArray, lt } from 'drizzle-orm';
import { env } from '../config/env';
import { db } from '../lib/db';
import { logger } from '../lib/logger';
import { campaigns, emails } from '../db/schema';
import type { NotifyJobData } from '../queues';
import { getSender } from '../modules/senders/sender.service';
import { sendSlackMessage } from '../modules/slack/slack.service';
import { rateLimitAlert } from '../modules/slack/messages';

/**
 * Sends the "sender hit its hourly limit" Slack message.
 *
 * Users without a connected (or with a revoked) Slack integration are skipped, not
 * failed: Slack is optional. Only transient Slack errors throw, so BullMQ retries them.
 */
export async function processNotifyJob(job: Job<NotifyJobData>): Promise<void> {
  const { userId, senderId, window, limit } = job.data;
  const log = logger.child({ jobId: job.id, userId, senderId, window });

  const sender = await getSender(senderId);
  const waiting = await countWaitingForLaterWindow(senderId, (window + 1) * env.RATE_WINDOW_MS);

  const message = rateLimitAlert({
    senderName: sender?.name ?? null,
    senderEmail: sender?.email ?? null,
    limit,
    windowStartMs: window * env.RATE_WINDOW_MS,
    windowEndMs: (window + 1) * env.RATE_WINDOW_MS,
    windowMs: env.RATE_WINDOW_MS,
    waiting,
    dashboardUrl: `${env.FRONTEND_URL}/dashboard`,
  });

  const result = await sendSlackMessage(userId, message);
  if (result === 'sent') log.info('rate-limit notification sent to slack');
  else log.info({ result }, 'slack not connected, rate-limit notification skipped');
}

/**
 * The emails of this sender that the limit pushed past the current window: not sent yet,
 * due at or after the window's end, from a campaign that wanted to start before it.
 * Not counted: emails still going out in this window (the one that hit the limit and
 * those spaced by the delay), and campaigns simply scheduled for later.
 */
export async function countWaitingForLaterWindow(senderId: string, windowEndMs: number): Promise<number> {
  const end = new Date(windowEndMs);
  const [{ n }] = await db
    .select({ n: count() })
    .from(emails)
    .innerJoin(campaigns, eq(campaigns.id, emails.campaignId))
    .where(and(
      eq(emails.senderId, senderId),
      inArray(emails.status, ['SCHEDULED', 'PROCESSING']),
      gte(emails.scheduledAt, end),
      lt(campaigns.startAt, end),
    ));
  return n;
}
