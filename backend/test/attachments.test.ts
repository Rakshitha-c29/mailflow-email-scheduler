/**
 * Campaign attachments: validation, storage (once per campaign), queue hygiene (no file
 * contents in Redis) and the download route. Offline: campaigns are scheduled a month out
 * and their jobs removed afterwards, so nothing here is ever sent.
 */
import { after, before, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import nodemailer from 'nodemailer';
import { eq, like } from 'drizzle-orm';
import { env } from '../src/config/env';
import { db, pool } from '../src/lib/db';
import { redis } from '../src/lib/redis';
import { encrypt } from '../src/lib/crypto';
import { attachments, emails, senders, users } from '../src/db/schema';
import { allQueues, emailQueue } from '../src/queues';
import { createApp } from '../src/app';
import { runMigrations } from '../src/db/migrate';
import { sanitizeFilename, validateAttachments } from '../src/modules/attachments/attachment.service';
import { SESSION_COOKIE, signSession } from '../src/modules/auth/session';

const DOMAIN = `att-test-${randomUUID().slice(0, 8)}.local`;
let server: Server;
let base: string;
const scheduledEmailIds: string[] = [];

// Minimal but genuine files (magic bytes are what the server checks).
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64',
);
export const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function makeUser(tag: string) {
  const [u] = await db.insert(users).values({ googleId: `g-${randomUUID()}`, email: `${tag}@${DOMAIN}`, name: tag }).returning();
  for (let i = 0; i < Math.max(env.SENDERS_PER_USER, 1); i++) {
    await db.insert(senders).values({
      userId: u.id, name: `Sender ${i + 1}`, email: `s-${randomUUID()}@${DOMAIN}`, smtpHost: 'localhost', smtpPort: 25,
      smtpUser: 'x', smtpPassEnc: encrypt('x'),
    });
  }
  return { user: u, cookie: `${SESSION_COOKIE}=${signSession(u)}` };
}

function scheduleForm(files: { name: string; data: Buffer }[], recipients = ['a@example.com', 'b@example.com', 'c@example.com']) {
  const form = new FormData();
  form.set('payload', JSON.stringify({
    subject: 'With attachments', body: '<p>See attached.</p>', recipients,
    startAt: new Date(Date.now() + 30 * 86400e3).toISOString(), delayMs: 2000, hourlyLimit: 100,
  }));
  for (const f of files) form.append('attachments', new Blob([new Uint8Array(f.data)]), f.name);
  return form;
}

async function schedule(cookie: string, form: FormData) {
  const r = await fetch(`${base}/api/emails/schedule`, { method: 'POST', headers: { Cookie: cookie }, body: form });
  return { status: r.status, body: (await r.json()) as any };
}

before(async () => {
  mock.method(nodemailer, 'createTestAccount', async () => { throw new Error('no Ethereal in offline tests'); });
  await runMigrations();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await Promise.allSettled(scheduledEmailIds.map((id) => emailQueue.remove(id)));
  await db.delete(users).where(like(users.email, `%@${DOMAIN}`));
  server.close();
  await Promise.allSettled(allQueues.map((q) => q.close()));
  await Promise.allSettled([redis.quit(), pool.end()]);
});

describe('sanitizeFilename', () => {
  test('strips paths, control and bidi-override characters; keeps a sane name', () => {
    assert.deepEqual(sanitizeFilename('../../etc/passwd.txt'), { name: 'passwd.txt', ext: 'txt' });
    assert.deepEqual(sanitizeFilename('C:\\Users\\x\\Report Q3.PDF'), { name: 'Report Q3.pdf', ext: 'pdf' });
    assert.deepEqual(sanitizeFilename('invoice\u202Egnp.exe'), { name: 'invoicegnp.exe', ext: 'exe' }, 'RTL override removed');
    assert.deepEqual(sanitizeFilename('a<b>:c"d|e?f*.png'), { name: 'a_b__c_d_e_f_.png', ext: 'png' });
    assert.deepEqual(sanitizeFilename('   ...hidden.png  '), { name: 'hidden.png', ext: 'png' });
    assert.deepEqual(sanitizeFilename('CON.txt'), { name: '_CON.txt', ext: 'txt' });
    assert.deepEqual(sanitizeFilename('.pdf'), { name: 'pdf', ext: '' }, 'dotfile has no extension (then rejected as a type)');
    assert.equal(sanitizeFilename(`${'x'.repeat(300)}.pdf`).name.length, 104);
  });
});

describe('validateAttachments', () => {
  const v = (name: string, data: Buffer) => () => validateAttachments([{ originalname: name, buffer: data }]);

  test('accepts genuine images, PDFs and text', () => {
    const [png, pdf, csv] = validateAttachments([
      { originalname: 'photo.PNG', buffer: PNG },
      { originalname: 'deck.pdf', buffer: PDF },
      { originalname: 'leads.csv', buffer: Buffer.from('email\nann@example.com\n') },
    ]);
    assert.equal(png.contentType, 'image/png');
    assert.equal(png.filename, 'photo.png');
    assert.equal(pdf.contentType, 'application/pdf');
    assert.equal(csv.contentType, 'text/csv; charset=utf-8');
    assert.equal(png.sha256, sha(PNG));
  });

  test('rejects unsafe or unknown types', () => {
    for (const name of ['run.exe', 'page.html', 'logo.svg', 'script.js', 'macro.docm', 'archive.zip', 'noext']) {
      assert.throws(v(name, Buffer.from('hello')), /can't be attached/, name);
    }
  });

  test('rejects files whose content does not match the extension', () => {
    assert.throws(v('photo.png', Buffer.from('MZ\x90\x00 definitely an exe')), /isn't a valid PNG image/);
    assert.throws(v('doc.pdf', PNG), /isn't a valid PDF/);
    assert.throws(v('notes.txt', Buffer.from([0x68, 0x00, 0x69])), /isn't a valid text file/);
  });

  test('enforces count and total size', () => {
    const many = Array.from({ length: env.ATTACHMENT_MAX_FILES + 1 }, (_, i) => ({ originalname: `${i}.png`, buffer: PNG }));
    assert.throws(() => validateAttachments(many), /At most/);
    const big = Buffer.concat([PDF, Buffer.alloc(env.ATTACHMENT_MAX_TOTAL_BYTES)]);
    assert.throws(() => validateAttachments([{ originalname: 'big.pdf', buffer: big }]), /limited to/);
  });
});

describe('POST /api/emails/schedule with attachments', () => {
  test('stores each file once per campaign; jobs carry no file content', async () => {
    const { cookie } = await makeUser('store');
    const res = await schedule(cookie, scheduleForm([{ name: 'photo.png', data: PNG }, { name: 'deck.pdf', data: PDF }]));
    assert.equal(res.status, 201);
    assert.deepEqual(res.body.campaign.attachments.map((a: any) => a.filename), ['photo.png', 'deck.pdf']);

    const rows = await db.select().from(attachments).where(eq(attachments.campaignId, res.body.campaign.id));
    assert.equal(rows.length, 2, '3 recipients × 2 files → still 2 stored files');
    assert.deepEqual(rows.map((r) => r.sha256).sort(), [sha(PNG), sha(PDF)].sort());

    const sent = await db.select({ id: emails.id }).from(emails).where(eq(emails.campaignId, res.body.campaign.id));
    assert.equal(sent.length, 3);
    for (const { id } of sent) {
      scheduledEmailIds.push(id);
      const job = await emailQueue.getJob(id);
      assert.deepEqual(job?.data, { emailId: id }, 'job data is only the email id');
      const raw = await redis.hget(`bull:${emailQueue.name}:${id}`, 'data');
      assert.ok(raw && raw.length < 200, `raw job payload in Redis is tiny (${raw?.length} bytes)`);
    }
  });

  test('detail lists the attachments; download returns the exact bytes with safe headers', async () => {
    const { cookie } = await makeUser('download');
    const res = await schedule(cookie, scheduleForm([{ name: 'photo.png', data: PNG }, { name: 'deck.pdf', data: PDF }], ['x@example.com']));
    const [{ id: emailId }] = await db.select({ id: emails.id }).from(emails).where(eq(emails.campaignId, res.body.campaign.id));
    scheduledEmailIds.push(emailId);

    const detail = (await (await fetch(`${base}/api/emails/${emailId}`, { headers: { Cookie: cookie } })).json()) as any;
    const [png, pdf] = detail.email.attachments;
    assert.deepEqual(Object.keys(png).sort(), ['contentType', 'filename', 'id', 'size'], 'metadata only, no content');
    assert.equal(png.size, PNG.length);

    const img = await fetch(`${base}/api/emails/${emailId}/attachments/${png.id}`, { headers: { Cookie: cookie } });
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.match(img.headers.get('content-disposition')!, /^inline; filename="photo.png"/);
    assert.match(img.headers.get('content-security-policy')!, /sandbox/);
    assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(sha(Buffer.from(await img.arrayBuffer())), sha(PNG));

    const doc = await fetch(`${base}/api/emails/${emailId}/attachments/${pdf.id}`, { headers: { Cookie: cookie } });
    assert.match(doc.headers.get('content-disposition')!, /^attachment; filename="deck.pdf"/, 'non-images always download');

    const other = await makeUser('intruder');
    const denied = await fetch(`${base}/api/emails/${emailId}/attachments/${png.id}`, { headers: { Cookie: other.cookie } });
    assert.equal(denied.status, 404);
  });

  test('server enforces limits and types (not just the UI)', async () => {
    const { cookie } = await makeUser('limits');
    const tooMany = Array.from({ length: env.ATTACHMENT_MAX_FILES + 1 }, (_, i) => ({ name: `${i}.png`, data: PNG }));
    const r1 = await schedule(cookie, scheduleForm(tooMany));
    assert.equal(r1.status, 400);
    assert.match(r1.body.error.message, /At most/);

    const r2 = await schedule(cookie, scheduleForm([{ name: 'big.pdf', data: Buffer.concat([PDF, Buffer.alloc(env.ATTACHMENT_MAX_TOTAL_BYTES)]) }]));
    assert.equal(r2.status, 413);

    const r3 = await schedule(cookie, scheduleForm([{ name: 'evil.exe', data: Buffer.from('MZ') }]));
    assert.equal(r3.status, 400);
    assert.match(r3.body.error.message, /can't be attached/);

    const r4 = await schedule(cookie, scheduleForm([{ name: 'fake.png', data: Buffer.from('not a png') }]));
    assert.equal(r4.status, 400);

    // Nothing was stored for any rejected request.
    const [{ id: userId }] = await db.select({ id: users.id }).from(users).where(eq(users.email, `limits@${DOMAIN}`));
    assert.equal((await db.select().from(attachments).where(eq(attachments.userId, userId))).length, 0);
  });
});
