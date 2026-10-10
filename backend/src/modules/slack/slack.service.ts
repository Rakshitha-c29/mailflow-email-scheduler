import { eq } from 'drizzle-orm';
import { env, slackEnabled } from '../../config/env';
import { db } from '../../lib/db';
import { redis } from '../../lib/redis';
import { decrypt, encrypt, randomToken } from '../../lib/crypto';
import { logger } from '../../lib/logger';
import { AppError, badRequest } from '../../lib/errors';
import { slackIntegrations } from '../../db/schema';

/**
 * Slack "Connect" uses the real OAuth v2 flow with the `incoming-webhook` scope: the user
 * picks a channel on Slack's consent screen and we get back a webhook URL + bot token.
 *
 * The OAuth `state` is a random one-time nonce stored in Redis → userId (10 min TTL,
 * consumed with GETDEL). We deliberately don't rely on the session cookie in the callback:
 * Slack requires an HTTPS redirect URL, which in local dev is a tunnel on a different
 * domain than the app, so the cookie wouldn't be sent there.
 */
const NONCE_TTL_S = 600;
const nonceKey = (n: string) => `slack:oauth:${n}`;

function assertEnabled(): void {
  if (!slackEnabled) throw new AppError(501, 'Slack is not configured on this server', 'SLACK_DISABLED');
}

export async function buildInstallUrl(userId: string): Promise<string> {
  assertEnabled();
  const nonce = randomToken();
  await redis.set(nonceKey(nonce), userId, 'EX', NONCE_TTL_S);
  const url = new URL('https://slack.com/oauth/v2/authorize');
  url.searchParams.set('client_id', env.SLACK_CLIENT_ID!);
  url.searchParams.set('scope', 'incoming-webhook');
  url.searchParams.set('redirect_uri', env.SLACK_REDIRECT_URI!);
  url.searchParams.set('state', nonce);
  return url.toString();
}

interface OAuthV2Response {
  ok: boolean;
  error?: string;
  access_token?: string;
  team?: { id: string; name: string };
  incoming_webhook?: { url: string; channel: string; channel_id: string };
}

export async function completeInstall(code: string, state: string): Promise<void> {
  assertEnabled();
  const userId = await redis.getdel(nonceKey(state));
  if (!userId) throw badRequest('Slack authorization expired or was already used. Please try again.');

  const res = await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.SLACK_CLIENT_ID!,
      client_secret: env.SLACK_CLIENT_SECRET!,
      code,
      redirect_uri: env.SLACK_REDIRECT_URI!,
    }),
  });
  const data = (await res.json()) as OAuthV2Response;
  if (!data.ok || !data.access_token || !data.incoming_webhook || !data.team) {
    logger.warn({ error: data.error }, 'slack oauth exchange failed');
    throw badRequest(`Slack authorization failed: ${data.error ?? 'unknown error'}`);
  }

  const values = {
    teamId: data.team.id,
    teamName: data.team.name,
    channelName: data.incoming_webhook.channel,
    webhookUrlEnc: encrypt(data.incoming_webhook.url),
    accessTokenEnc: encrypt(data.access_token),
    status: 'CONNECTED' as const,
  };
  await db.insert(slackIntegrations).values({ userId, ...values })
    .onConflictDoUpdate({ target: slackIntegrations.userId, set: values });
  logger.info({ userId, team: data.team.name, channel: values.channelName }, 'slack connected');
}

export async function getStatus(userId: string) {
  const row = await db.query.slackIntegrations.findFirst({ where: eq(slackIntegrations.userId, userId) });
  return {
    enabled: slackEnabled,
    connected: row?.status === 'CONNECTED',
    status: row?.status ?? null,
    teamName: row?.teamName ?? null,
    channelName: row?.channelName ?? null,
  };
}

export async function disconnect(userId: string): Promise<void> {
  const row = await db.query.slackIntegrations.findFirst({ where: eq(slackIntegrations.userId, userId) });
  if (!row) return;
  // Best effort: revoke on Slack's side too. The local delete is what matters.
  await fetch('https://slack.com/api/auth.revoke', {
    method: 'POST',
    headers: { Authorization: `Bearer ${decrypt(row.accessTokenEnc)}` },
  }).catch((err) => logger.warn({ err }, 'slack token revoke failed'));
  await db.delete(slackIntegrations).where(eq(slackIntegrations.userId, userId));
}

export type SlackSendResult = 'sent' | 'not_connected' | 'revoked';

/** Webhook errors that mean "this integration is dead", not "try again later". */
const PERMANENT = new Set(['no_service', 'no_team', 'invalid_token', 'channel_not_found', 'channel_is_archived', 'team_disabled', 'action_prohibited']);

/**
 * Reads the integration fresh from the DB on every call, so connecting, disconnecting or
 * reconnecting takes effect immediately without a restart/redeploy.
 * Throws only on transient failures (429/5xx/network) so BullMQ retries.
 */
export async function sendSlackMessage(userId: string, payload: Record<string, unknown>): Promise<SlackSendResult> {
  const row = await db.query.slackIntegrations.findFirst({ where: eq(slackIntegrations.userId, userId) });
  if (!row || row.status !== 'CONNECTED') return 'not_connected';

  const res = await fetch(decrypt(row.webhookUrlEnc), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  if (res.ok) return 'sent';

  const text = (await res.text()).trim();
  if (res.status === 429 || res.status >= 500) throw new Error(`Slack transient error ${res.status}: ${text}`);
  if (PERMANENT.has(text) || res.status === 404 || res.status === 410 || res.status === 403) {
    await db.update(slackIntegrations).set({ status: 'REVOKED' }).where(eq(slackIntegrations.userId, userId));
    logger.warn({ userId, status: res.status, text }, 'slack integration revoked');
    return 'revoked';
  }
  throw new Error(`Slack webhook error ${res.status}: ${text}`);
}
