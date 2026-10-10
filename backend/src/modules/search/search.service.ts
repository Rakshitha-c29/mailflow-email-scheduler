import { inArray, eq } from 'drizzle-orm';
import type { estypes } from '@elastic/elasticsearch';
import { db } from '../../lib/db';
import { es, ES_INDEX } from '../../lib/elastic';
import { logger } from '../../lib/logger';
import { unavailable } from '../../lib/errors';
import { campaigns, emails, senders, type EmailStatus } from '../../db/schema';
import type { SearchQuery } from '../emails/email.schemas';
import { viewStatuses } from '../emails/email.service';
import { toPreview } from '../../lib/text';

/**
 * Elasticsearch is a *read model*. Postgres is the source of truth; every state change
 * enqueues an index job that loads the latest row and upserts it. Re-running is harmless,
 * and `npm run reindex` rebuilds the whole index from Postgres.
 */
export interface EmailDoc {
  id: string;
  userId: string;
  campaignId: string;
  senderId: string;
  senderEmail: string;
  toEmail: string;
  subject: string;
  body: string;
  status: EmailStatus;
  starred: boolean;
  scheduledAt: string;
  sentAt: string | null;
  sendStartedAt: string | null;
  updatedAt: string;
}

/**
 * Fields added after the index was first created. Adding fields to a live mapping is
 * allowed, so existing deployments are upgraded in place (old docs pick the field up on
 * their next reindex; `npm run reindex` backfills all).
 */
const ADDED_FIELDS: Record<string, estypes.MappingProperty> = {
  starred: { type: 'boolean' },
  sendStartedAt: { type: 'date' },
};

export async function ensureIndex(): Promise<void> {
  const exists = await es.indices.exists({ index: ES_INDEX });
  if (exists) {
    await es.indices.putMapping({ index: ES_INDEX, properties: ADDED_FIELDS });
    // Analyzers can't change on a live index: an index created before email addresses were
    // split into parts needs a rebuild.
    const settings = await es.indices.getSettings({ index: ES_INDEX });
    if (!Object.values(settings)[0]?.settings?.index?.analysis?.analyzer?.email_prefix) {
      logger.warn({ index: ES_INDEX }, 'search index is outdated (email parts): run `npm run reindex -- --recreate`');
    }
    return;
  }
  await es.indices.create({
    index: ES_INDEX,
    settings: {
      analysis: {
        analyzer: {
          // Email addresses are split into parts on . @ - _ + so "park", "example" and
          // "example.com" all find eve.park@example.com; each part also matches by its start.
          email_prefix: { type: 'custom', tokenizer: 'email_split', filter: ['lowercase', 'edge_2_20'] }, // indexing
          email_parts: { type: 'custom', tokenizer: 'email_split', filter: ['lowercase'] }, // searching
          // Partial words in subjects ("redi" finds "redis").
          prefix_text: { type: 'custom', tokenizer: 'standard', filter: ['lowercase', 'edge_2_20'] },
        },
        tokenizer: { email_split: { type: 'pattern', pattern: '[\\s.@_+-]+' } }, // - last: a literal dash
        filter: { edge_2_20: { type: 'edge_ngram', min_gram: 2, max_gram: 20 } },
      },
    },
    mappings: {
      dynamic: 'strict',
      properties: {
        id: { type: 'keyword' },
        userId: { type: 'keyword' },
        campaignId: { type: 'keyword' },
        senderId: { type: 'keyword' },
        senderEmail: { type: 'keyword', fields: { text: { type: 'text', analyzer: 'email_prefix', search_analyzer: 'email_parts' } } },
        toEmail: { type: 'keyword', fields: { text: { type: 'text', analyzer: 'email_prefix', search_analyzer: 'email_parts' } } },
        subject: { type: 'text', fields: { prefix: { type: 'text', analyzer: 'prefix_text', search_analyzer: 'standard' } } },
        body: { type: 'text' },
        status: { type: 'keyword' },
        ...ADDED_FIELDS,
        scheduledAt: { type: 'date' },
        sentAt: { type: 'date' },
        updatedAt: { type: 'date' },
      },
    },
  }).catch((err: { meta?: { body?: { error?: { type?: string } } } }) => {
    // Another process created it concurrently: fine.
    if (err.meta?.body?.error?.type !== 'resource_already_exists_exception') throw err;
  });
  logger.info({ index: ES_INDEX }, 'elasticsearch index created');
}

/** Loads the latest rows from Postgres and bulk-upserts them. Deleted rows are removed. */
export async function indexEmails(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const rows = await db
    .select({
      id: emails.id, userId: emails.userId, campaignId: emails.campaignId, senderId: emails.senderId,
      senderEmail: senders.email, toEmail: emails.toEmail, subject: emails.subject, body: campaigns.body,
      status: emails.status, starred: emails.starred, scheduledAt: emails.scheduledAt, sentAt: emails.sentAt,
      sendStartedAt: emails.sendStartedAt, updatedAt: emails.updatedAt,
    })
    .from(emails)
    .innerJoin(senders, eq(senders.id, emails.senderId))
    .innerJoin(campaigns, eq(campaigns.id, emails.campaignId))
    .where(inArray(emails.id, ids));

  const found = new Set(rows.map((r) => r.id));
  const operations: estypes.BulkRequest['operations'] = [];
  for (const r of rows) {
    const doc: EmailDoc = {
      ...r,
      scheduledAt: r.scheduledAt.toISOString(),
      sentAt: r.sentAt?.toISOString() ?? null,
      sendStartedAt: r.sendStartedAt?.toISOString() ?? null,
      updatedAt: r.updatedAt.toISOString(),
    };
    operations.push({ index: { _index: ES_INDEX, _id: r.id } }, doc);
  }
  for (const id of ids) if (!found.has(id)) operations.push({ delete: { _index: ES_INDEX, _id: id } });

  const res = await es.bulk({ operations, refresh: false });
  if (res.errors) {
    const failed = res.items.filter((i) => {
      const op = i.index ?? i.delete;
      return op?.error && op.status !== 404; // deleting an already-missing doc is fine
    });
    if (failed.length) throw new Error(`ES bulk had ${failed.length} failures: ${JSON.stringify(failed[0])}`);
  }
}

export async function searchEmails(userId: string, q: SearchQuery) {
  const filter: estypes.QueryDslQueryContainer[] = [{ term: { userId } }];
  if (q.view) filter.push({ terms: { status: viewStatuses(q.view, q.status) } });
  else if (q.status) filter.push({ term: { status: q.status } });
  if (q.senderId) filter.push({ term: { senderId: q.senderId } });
  if (q.from || q.to) filter.push({ range: { scheduledAt: { gte: q.from, lte: q.to } } });

  const must: estypes.QueryDslQueryContainer[] = q.q
    ? [{
        multi_match: {
          query: q.q,
          fields: ['toEmail.text^4', 'subject^3', 'subject.prefix^2', 'senderEmail.text', 'body'],
          type: 'most_fields',
          operator: 'and',
        },
      }]
    : [{ match_all: {} }];

  try {
    const res = await es.search<EmailDoc>({
      index: ES_INDEX,
      from: (q.page - 1) * q.pageSize,
      size: q.pageSize,
      query: { bool: { filter, must } },
      // Ties (and filter-only searches) follow the tab's own order: soonest first for Scheduled.
      sort: [...(q.q ? ['_score' as const] : []), { scheduledAt: q.view === 'scheduled' ? 'asc' : 'desc' }],
      highlight: { fields: { subject: {}, body: { fragment_size: 120, number_of_fragments: 1 } } },
      track_total_hits: true,
    });
    const total = typeof res.hits.total === 'number' ? res.hits.total : res.hits.total?.value ?? 0;
    return {
      items: res.hits.hits.map((h) => {
        const { body, userId: _u, ...rest } = h._source!;
        return { ...rest, starred: rest.starred ?? false, preview: toPreview(body), highlight: h.highlight ?? {} };
      }),
      total,
      page: q.page,
      pageSize: q.pageSize,
      totalPages: Math.max(1, Math.ceil(total / q.pageSize)),
    };
  } catch (err) {
    logger.error({ err }, 'elasticsearch search failed');
    throw unavailable('Search is temporarily unavailable');
  }
}
