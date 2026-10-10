/**
 * Real provisioning path (only Ethereal's API is faked, locally): creating 2 senders in one
 * process must create 2 different mailboxes. Nodemailer caches one test account per process
 * by default, which used to make the 2nd sender the same mailbox and fail to save.
 * Don't import 'nodemailer' here: the app's own loader (src/lib/nodemailer) must load it.
 */
import { FAKE_ETHEREAL_PORT } from './helpers/fakeEtherealEnv'; // must be the first import
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { eq, like } from 'drizzle-orm';
import { db, pool } from '../src/lib/db';
import { redis } from '../src/lib/redis';
import { env } from '../src/config/env';
import { senders, users } from '../src/db/schema';
import { closeQueues } from '../src/queues';
import { runMigrations } from '../src/db/migrate';
import { ensureSenders, listSenders } from '../src/modules/senders/sender.service';

const RUN = randomUUID().slice(0, 8);
const DOMAIN = `ethereal-prov-${RUN}.local`;
let requests = 0;

// Every POST /user is a brand-new mailbox, like the real Ethereal API.
const fake: Server = createServer((req, res) => {
  req.resume().on('end', () => {
    requests++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      status: 'success', user: `fake-${RUN}-${requests}@ethereal.email`, pass: 'p',
      smtp: { host: 'smtp.ethereal.email', port: 587, secure: false },
      imap: { host: 'imap.ethereal.email', port: 993, secure: true },
      pop3: { host: 'pop3.ethereal.email', port: 995, secure: true },
      web: 'https://ethereal.email',
    }));
  });
});

before(async () => {
  await new Promise<void>((r) => fake.listen(FAKE_ETHEREAL_PORT, '127.0.0.1', r));
  await runMigrations();
});

after(async () => {
  await db.delete(users).where(like(users.email, `%@${DOMAIN}`));
  await new Promise<void>((r) => fake.close(() => r()));
  await closeQueues();
  await Promise.allSettled([redis.quit(), pool.end()]);
});

test('a new user gets SENDERS_PER_USER (≥ 2) different Ethereal mailboxes, in one process', async () => {
  const [u] = await db.insert(users).values({ googleId: `g-${randomUUID()}`, email: `new@${DOMAIN}`, name: 'New' }).returning();
  await ensureSenders(u.id);

  const list = await listSenders(u.id);
  assert.ok(env.SENDERS_PER_USER >= 2);
  assert.equal(list.length, env.SENDERS_PER_USER);
  assert.equal(new Set(list.map((s) => s.email)).size, list.length, 'each sender is its own mailbox');
  assert.equal(requests, env.SENDERS_PER_USER, 'one Ethereal account created per sender (no cached reuse)');
});

test('a second user in the same process also gets fresh mailboxes', async () => {
  const [u] = await db.insert(users).values({ googleId: `g-${randomUUID()}`, email: `second@${DOMAIN}`, name: 'Second' }).returning();
  await ensureSenders(u.id);
  const mine = await db.select().from(senders).where(eq(senders.userId, u.id));
  assert.equal(mine.length, env.SENDERS_PER_USER);
  assert.equal(requests, 2 * env.SENDERS_PER_USER);
});
