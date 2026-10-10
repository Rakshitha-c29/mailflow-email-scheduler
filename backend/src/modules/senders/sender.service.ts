import { nodemailer, type Transporter } from '../../lib/nodemailer';
import { asc, eq, count } from 'drizzle-orm';
import { env } from '../../config/env';
import { db } from '../../lib/db';
import { decrypt, encrypt } from '../../lib/crypto';
import { logger } from '../../lib/logger';
import { senders, type Sender } from '../../db/schema';

export type PublicSender = Pick<Sender, 'id' | 'name' | 'email' | 'createdAt'>;
const toPublic = (s: Sender): PublicSender => ({ id: s.id, name: s.name, email: s.email, createdAt: s.createdAt });

/** Creates a brand-new Ethereal mailbox and stores it as a sender for the user. */
export async function createEtherealSender(userId: string, name: string): Promise<Sender> {
  const account = await nodemailer.createTestAccount();
  const [row] = await db
    .insert(senders)
    .values({
      userId,
      name,
      email: account.user,
      smtpHost: account.smtp.host,
      smtpPort: account.smtp.port,
      smtpSecure: account.smtp.secure,
      smtpUser: account.user,
      smtpPassEnc: encrypt(account.pass),
    })
    .returning();
  logger.info({ userId, sender: row.email }, 'provisioned Ethereal sender');
  return row;
}

/**
 * Every user gets SENDERS_PER_USER Ethereal mailboxes on first login, so "multiple senders"
 * works out of the box. Credentials are persisted, so restarts never create new accounts
 * and old preview URLs keep working.
 */
export async function ensureSenders(userId: string): Promise<void> {
  const [{ n }] = await db.select({ n: count() }).from(senders).where(eq(senders.userId, userId));
  for (let i = n; i < env.SENDERS_PER_USER; i++) {
    await createEtherealSender(userId, `Sender ${i + 1}`);
  }
}

export async function listSenders(userId: string): Promise<PublicSender[]> {
  const rows = await db.select().from(senders).where(eq(senders.userId, userId)).orderBy(asc(senders.createdAt));
  return rows.map(toPublic);
}

export async function getSender(id: string): Promise<Sender | undefined> {
  return db.query.senders.findFirst({ where: eq(senders.id, id) });
}

/** Pooled SMTP transport per sender, cached for the life of the worker process. */
const transports = new Map<string, Transporter>();

export async function getTransport(sender: Sender): Promise<Transporter> {
  let t = transports.get(sender.id);
  if (!t) {
    t = nodemailer.createTransport({
      host: sender.smtpHost,
      port: sender.smtpPort,
      secure: sender.smtpSecure,
      auth: { user: sender.smtpUser, pass: decrypt(sender.smtpPassEnc) },
      pool: true,
      maxConnections: 2,
      connectionTimeout: 15_000,
      socketTimeout: 30_000,
      // We only ever send in-memory content: never let a message read local files or URLs.
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    transports.set(sender.id, t);
  }
  return t;
}

export function closeTransports(): void {
  for (const t of transports.values()) t.close();
  transports.clear();
}
