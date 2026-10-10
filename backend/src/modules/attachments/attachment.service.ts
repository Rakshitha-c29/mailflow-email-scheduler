import crypto from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { env } from '../../config/env';
import { db } from '../../lib/db';
import { AppError, badRequest, notFound } from '../../lib/errors';
import { attachments, emails } from '../../db/schema';

/**
 * Attachment rules (all enforced here, on the server):
 *   - at most ATTACHMENT_MAX_FILES files, at most ATTACHMENT_MAX_TOTAL_BYTES in total
 *   - only safe types: images, PDF, common office documents, plain text / CSV
 *   - the type comes from the extension AND must match the file's magic bytes; the
 *     client-supplied MIME type is ignored, so "invoice.pdf.exe" or a renamed executable
 *     is rejected
 *   - file names are sanitized before they're stored or sent
 */

type Sniff = (b: Buffer) => boolean;
const startsWith = (sig: number[]): Sniff => (b) => sig.every((byte, i) => b[i] === byte);
const ascii = (s: string, offset = 0): Sniff => (b) => b.subarray(offset, offset + s.length).toString('latin1') === s;

const isZip = startsWith([0x50, 0x4b, 0x03, 0x04]); // docx/xlsx/pptx/odt/ods are zip containers
const isOle = startsWith([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]); // legacy doc/xls/ppt
const isText: Sniff = (b) => {
  const head = b.subarray(0, 64 * 1024);
  if (head.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(head.subarray(0, Math.max(0, head.length - 4))); // tolerate a cut multi-byte char
    return true;
  } catch {
    return false;
  }
};

interface FileType { mime: string; sniff: Sniff; label: string }
const TYPES: Record<string, FileType> = {
  png: { mime: 'image/png', sniff: startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), label: 'PNG image' },
  jpg: { mime: 'image/jpeg', sniff: startsWith([0xff, 0xd8, 0xff]), label: 'JPEG image' },
  jpeg: { mime: 'image/jpeg', sniff: startsWith([0xff, 0xd8, 0xff]), label: 'JPEG image' },
  gif: { mime: 'image/gif', sniff: (b) => ascii('GIF87a')(b) || ascii('GIF89a')(b), label: 'GIF image' },
  webp: { mime: 'image/webp', sniff: (b) => ascii('RIFF')(b) && ascii('WEBP', 8)(b), label: 'WebP image' },
  pdf: { mime: 'application/pdf', sniff: ascii('%PDF-'), label: 'PDF' },
  doc: { mime: 'application/msword', sniff: isOle, label: 'Word document' },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', sniff: isZip, label: 'Word document' },
  xls: { mime: 'application/vnd.ms-excel', sniff: isOle, label: 'Excel spreadsheet' },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', sniff: isZip, label: 'Excel spreadsheet' },
  ppt: { mime: 'application/vnd.ms-powerpoint', sniff: isOle, label: 'PowerPoint presentation' },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', sniff: isZip, label: 'PowerPoint presentation' },
  odt: { mime: 'application/vnd.oasis.opendocument.text', sniff: isZip, label: 'OpenDocument text' },
  ods: { mime: 'application/vnd.oasis.opendocument.spreadsheet', sniff: isZip, label: 'OpenDocument spreadsheet' },
  txt: { mime: 'text/plain; charset=utf-8', sniff: isText, label: 'text file' },
  csv: { mime: 'text/csv; charset=utf-8', sniff: isText, label: 'CSV file' },
};
export const ALLOWED_EXTENSIONS = Object.keys(TYPES);
/** Shown inline (thumbnails) by the download route; everything else is a download. */
export const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const MAX_NAME = 100;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/**
 * Safe, human-readable file name: no path parts, no control or bidi-override characters
 * (which can disguise "gpj.exe" as "exe.jpg"), no characters that are illegal on common
 * file systems, bounded length, lower-case extension.
 */
export function sanitizeFilename(original: string): { name: string; ext: string } {
  let base = (original.split(/[\\/]/).pop() ?? '').normalize('NFC');
  base = base
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  let stem = (dot > 0 ? base.slice(0, dot) : base).trim().slice(0, MAX_NAME).trim();
  if (!stem) stem = 'attachment';
  if (WINDOWS_RESERVED.test(stem)) stem = `_${stem}`;
  return { name: ext ? `${stem}.${ext}` : stem, ext };
}

export interface IncomingFile {
  originalname: string;
  buffer: Buffer;
}

export interface ValidatedAttachment {
  filename: string;
  contentType: string;
  size: number;
  sha256: string;
  content: Buffer;
}

const mb = (bytes: number) => `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;

export function validateAttachments(files: IncomingFile[]): ValidatedAttachment[] {
  if (files.length > env.ATTACHMENT_MAX_FILES) {
    throw badRequest(`At most ${env.ATTACHMENT_MAX_FILES} attachments are allowed`);
  }
  const total = files.reduce((n, f) => n + f.buffer.length, 0);
  if (total > env.ATTACHMENT_MAX_TOTAL_BYTES) {
    throw new AppError(413, `Attachments are limited to ${mb(env.ATTACHMENT_MAX_TOTAL_BYTES)} in total`, 'ATTACHMENTS_TOO_LARGE');
  }
  return files.map((f) => {
    const { name, ext } = sanitizeFilename(f.originalname);
    const type = TYPES[ext];
    if (!type) {
      throw badRequest(`"${name}" can't be attached. Allowed: images (PNG, JPG, GIF, WebP), PDF, Word, Excel, PowerPoint, OpenDocument, TXT and CSV.`);
    }
    if (!f.buffer.length) throw badRequest(`"${name}" is empty`);
    if (!type.sniff(f.buffer)) throw badRequest(`"${name}" isn't a valid ${type.label}`);
    return {
      filename: name,
      contentType: type.mime,
      size: f.buffer.length,
      sha256: crypto.createHash('sha256').update(f.buffer).digest('hex'),
      content: f.buffer,
    };
  });
}

// ── Reads ─────────────────────────────────────────────────────────────────────

const META = {
  id: attachments.id, filename: attachments.filename, contentType: attachments.contentType, size: attachments.size,
};
export type AttachmentMeta = { id: string; filename: string; contentType: string; size: number };

export function listAttachmentMeta(campaignId: string): Promise<AttachmentMeta[]> {
  return db.select(META).from(attachments).where(eq(attachments.campaignId, campaignId)).orderBy(asc(attachments.position));
}

/** One attachment of one of the user's emails (checks ownership through the email). */
export async function getAttachmentForEmail(userId: string, emailId: string, attachmentId: string) {
  const [row] = await db
    .select({ ...META, content: attachments.content })
    .from(attachments)
    .innerJoin(emails, eq(emails.campaignId, attachments.campaignId))
    .where(and(eq(emails.id, emailId), eq(emails.userId, userId), eq(attachments.id, attachmentId)));
  if (!row) throw notFound('Attachment');
  return row;
}

// ── Worker side ───────────────────────────────────────────────────────────────

export interface MailAttachment { filename: string; content: Buffer; contentType: string }

/**
 * Campaign attachments for sending. A 1000-email campaign would otherwise read the same
 * files 1000 times, so each worker keeps recently used campaigns in memory, bounded by
 * total bytes (evicting the least recently used). Postgres stays the source of truth.
 */
const CACHE_MAX_BYTES = 64 * 1024 * 1024;
const cache = new Map<string, { files: MailAttachment[]; bytes: number }>();
let cachedBytes = 0;

export async function loadCampaignAttachments(campaignId: string): Promise<MailAttachment[]> {
  const hit = cache.get(campaignId);
  if (hit) {
    cache.delete(campaignId); // re-insert = most recently used
    cache.set(campaignId, hit);
    return hit.files;
  }
  const rows = await db
    .select({ filename: attachments.filename, content: attachments.content, contentType: attachments.contentType })
    .from(attachments)
    .where(eq(attachments.campaignId, campaignId))
    .orderBy(asc(attachments.position));
  const bytes = rows.reduce((n, r) => n + r.content.length, 0);
  if (bytes <= CACHE_MAX_BYTES) {
    cache.set(campaignId, { files: rows, bytes });
    cachedBytes += bytes;
    for (const [key, entry] of cache) {
      if (cachedBytes <= CACHE_MAX_BYTES) break;
      cache.delete(key);
      cachedBytes -= entry.bytes;
    }
  }
  return rows;
}
