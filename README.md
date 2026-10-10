# MailFlow – Email Job Scheduler

[![CI](https://github.com/Rakshitha-c29/mailflow-email-scheduler/actions/workflows/ci.yml/badge.svg)](https://github.com/Rakshitha-c29/mailflow-email-scheduler/actions/workflows/ci.yml)

Schedule personalised cold-email campaigns and let a pool of workers send them **on time,
within per-sender rate limits, at most once (never duplicated), and safely across crashes and
restarts**. An email whose delivery can't be known (a crash in the middle of SMTP) is marked
`UNCERTAIN` rather than resent.

- **Compose** a campaign: rich-text body, recipients typed/pasted or imported from a CSV
  ("Upload List"), attachments, a start time ("Send Later"), a delay between emails and an
  hourly limit.
- **Dashboard** with Scheduled / Sent tabs, full-text search (Elasticsearch), filters, stars,
  and an email detail view (sanitized HTML, attachments, delivery history, cancel).
- **Sign in** with Google or email + password.
- Emails go out through real SMTP ([Ethereal](https://ethereal.email) test mailboxes, one or
  more per user), with optional **Slack alerts** when a sender hits its hourly limit.
- An email interrupted mid-send is never resent automatically; the user can **Send again**
  it explicitly (as a new email).

## Quick start

**Fastest way to try it** (no Google or Slack keys needed). You need Node.js 20+, Docker, and
internet access for the Ethereal test mailboxes.

```bash
docker compose up -d                       # Postgres, Redis, Elasticsearch; wait for 3× healthy

cd backend
npm install
cp .env.example .env                       # Windows: copy .env.example .env
# In .env, set SESSION_SECRET and ENCRYPTION_KEY to two different values from:
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Optional, to see rate limits within minutes: RATE_WINDOW_MS=60000 ("demo mode")
npm run seed:demo                          # demo account + sample emails
npm run dev                                # API on :4000 — keep running
npm run dev:worker                         # in a 2nd terminal — keep running

cd frontend                                # in a 3rd terminal, from the repo root
npm install
npm run dev                                # http://localhost:5173
```

Open **http://localhost:5173** and sign in with **`oliver.brown@domain.io` /
`oliver-demo-password`**. Everything works without keys:
- Compose, CSV upload, Send / Send Later, the Scheduled and Sent tabs, search and attachments.
- Real delivery through Ethereal: open a sent email → "to ▾" → **Open in Ethereal**.
- The read-only queue dashboard at **http://localhost:5173/admin/queues**.

> **Local development only.** The demo account and its password are published here, so they
> must never exist in production. `npm run seed:demo` refuses to run when `NODE_ENV=production`.

**Optional:**
- To use "Sign in with Google", follow [Google sign-in setup](#google-sign-in-setup): your own
  OAuth client, redirect URI `http://localhost:4000/api/auth/google/callback`.
- To use "Connect Slack", follow [Slack setup](#slack-setup): a Slack app plus an HTTPS tunnel
  for local development.

## Features → implementation

Where each feature lives in the code and which tests cover it. Backend tests run with
`npm test` in `backend/`; browser tests with `npm run e2e` in `frontend/`.

| Feature | Implementation | Tests |
|---|---|---|
| Schedule emails through an API, for a specific time | [email.service.ts](backend/src/modules/emails/email.service.ts) (`scheduleCampaign`), [planner.ts](backend/src/scheduler/planner.ts) | [scheduling.test.ts](backend/test/scheduling.test.ts), [compose.e2e.cjs](frontend/e2e/compose.e2e.cjs) |
| BullMQ delayed jobs on Redis, no cron | [queues/index.ts](backend/src/queues/index.ts), [worker.ts](backend/src/worker.ts) | [restart.test.ts](backend/test/restart.test.ts) |
| Send through Ethereal SMTP, from multiple senders | [sender.service.ts](backend/src/modules/senders/sender.service.ts), [email.processor.ts](backend/src/workers/email.processor.ts) | [senders.test.ts](backend/test/senders.test.ts), [etherealProvisioning.test.ts](backend/test/etherealProvisioning.test.ts), [ethereal-attachments.e2e.ts](backend/test/e2e/ethereal-attachments.e2e.ts) (real delivery) |
| Survive restarts: future emails still go out on time | [reconcile.ts](backend/src/recovery/reconcile.ts) | [restart.test.ts](backend/test/restart.test.ts), [restartOrder.test.ts](backend/test/restartOrder.test.ts) |
| Never send the same email twice | conditional status updates in [email.processor.ts](backend/src/workers/email.processor.ts); `jobId = emailId`; `Idempotency-Key` in [email.service.ts](backend/src/modules/emails/email.service.ts) | [restart.test.ts](backend/test/restart.test.ts), [resend.test.ts](backend/test/resend.test.ts) |
| Search scheduled and sent emails (Elasticsearch) | [search.service.ts](backend/src/modules/search/search.service.ts) | [search.test.ts](backend/test/search.test.ts) |
| Live BullMQ dashboard | Bull Board in [app.ts](backend/src/app.ts) (read-only, admins only) | [admin.test.ts](backend/test/admin.test.ts) |
| Configurable concurrency, safe in parallel | [worker.ts](backend/src/worker.ts), atomic Lua scripts in [rateLimiter.ts](backend/src/scheduler/rateLimiter.ts) | [sendGate.test.ts](backend/test/sendGate.test.ts), [scheduling.test.ts](backend/test/scheduling.test.ts) |
| Minimum delay and hourly limit per sender, in Redis; over-limit emails move to the next window | [rateLimiter.ts](backend/src/scheduler/rateLimiter.ts), [planner.ts](backend/src/scheduler/planner.ts) | [scheduling.test.ts](backend/test/scheduling.test.ts), [windowBoundary.test.ts](backend/test/windowBoundary.test.ts), [limitHistory.test.ts](backend/test/limitHistory.test.ts) |
| 1000+ emails at the same moment | chunked inserts and `addBulk` in [email.service.ts](backend/src/modules/emails/email.service.ts) | [scheduling.test.ts](backend/test/scheduling.test.ts); two-worker run in [Behaviour under load](#behaviour-under-load-1000-emails) |
| Slack alert when a sender hits its limit | [modules/slack](backend/src/modules/slack), [notification.processor.ts](backend/src/workers/notification.processor.ts) | [slack.test.ts](backend/test/slack.test.ts), [account.e2e.cjs](frontend/e2e/account.e2e.cjs) |
| Google login (real OAuth), then the dashboard | [auth.routes.ts](backend/src/modules/auth/auth.routes.ts), [LoginPage.tsx](frontend/src/pages/LoginPage.tsx) | [auth.test.ts](backend/test/auth.test.ts), [auth.e2e.cjs](frontend/e2e/auth.e2e.cjs); a live Google sign-in needs your own keys |
| User name, email, avatar and logout | [Sidebar.tsx](frontend/src/components/dashboard/Sidebar.tsx), [UserMenu.tsx](frontend/src/components/dashboard/UserMenu.tsx) | [dashboard.e2e.cjs](frontend/e2e/dashboard.e2e.cjs) |
| Compose: subject, body, CSV upload with count, start time, delay, hourly limit | [ComposePage.tsx](frontend/src/pages/ComposePage.tsx), [leadList.ts](frontend/src/components/compose/leadList.ts) | [compose.e2e.cjs](frontend/e2e/compose.e2e.cjs) |
| Scheduled and Sent lists (time, status, loading, empty states) | [DashboardPage.tsx](frontend/src/pages/DashboardPage.tsx), [EmailRow.tsx](frontend/src/components/dashboard/EmailRow.tsx) | [dashboard.e2e.cjs](frontend/e2e/dashboard.e2e.cjs) |
| Frontend code quality (structure, reusable components, types) | [components/ui](frontend/src/components/ui), typed API client in `frontend/src/lib/` | typecheck and build in CI |
| Documentation: setup, Ethereal, architecture, restarts, rate limits, concurrency, features | this file | — |

## Architecture

```
 Browser (React + TanStack Query, Vite dev server :5173, proxies /api → :4000)
    │  httpOnly session cookie
    ▼
 API  (Express, backend/src/server.ts, :4000) ──────────────┐
    │ writes rows in one transaction, then enqueues          │ search queries
    ▼                                                        ▼
 Postgres  ◀──────────── source of truth ────────────▶  Elasticsearch (read model)
    ▲                                                        ▲
    │ conditional state transitions                          │ upserts latest rows
 Worker(s) (BullMQ, backend/src/worker.ts)  ─── Redis ───────┘
    │   queues: email-send (1 delayed job per email), search-index, slack-notify
    │   plus rate-limit counters, send gate, cooldowns, locks, session-version cache
    ▼
 SMTP (Ethereal) · Slack webhook
```

**One email's life, in plain English:**

1. **Scheduled.** The API plans each email's send time, then saves one row per recipient
   (`SCHEDULED`) in one transaction and adds one delayed BullMQ job per email (job id = email id).
2. **Waiting.** Nothing polls: Redis holds the job until its time, Postgres holds the truth.
3. **Claimed.** The worker takes the row only if it's still `SCHEDULED`; cancelled or already
   sent emails are skipped.
4. **Paced.** It reserves a rate-limit slot in Redis. If the slot is later, the email sleeps
   until then. The reservation that fills a sender's window triggers one Slack alert.
5. **Sent.** A last Redis check enforces the gap between sends, then SMTP to Ethereal; the row
   becomes `SENT`.
6. **If it fails:** a 4xx pauses the sender and retries later; a 5xx marks it `FAILED`; a crash
   before SMTP is retried; a crash *during* SMTP marks it `UNCERTAIN`, never resent automatically.

So delivery is **at most once**: duplicates are prevented by design (one job per email,
conditional status updates, idempotent scheduling), and the one unknowable case, a crash
mid-SMTP, is reported as `UNCERTAIN` instead of being retried. Details:
[Architecture details](#architecture-details), [Restart safety](#restart-safety).

## Intentional decisions (FAQ)

- **Demo password in the README?** So anyone can try the app locally with no setup. It's local-only:
  `seed:demo` refuses to run with `NODE_ENV=production`
  ([seedDemoGuard.test.ts](backend/test/seedDemoGuard.test.ts)).
- **Email + password sign-in?** Google sign-in is fully implemented but needs your own keys;
  passwords let the app work without them. A later Google sign-in to the same email removes the
  unverified password and signs out every session ([Authentication](#authentication)).
- **Google-only accounts?** Password login answers "This account uses Google sign-in". The owner
  can add a password from the user menu after a recent (15 min) Google sign-in.
- **"Per minute (demo mode)"?** `RATE_WINDOW_MS=60000` shortens the hourly window to a minute
  for demos; the default is one hour, and any other length is labelled demo mode ([Setup](#setup)).
- **`UNCERTAIN` emails?** The worker stopped mid-SMTP, so delivery is unknown and an automatic
  resend could duplicate it. The user can choose **Send again**, which creates a new email and
  leaves the original unchanged ([Restart safety](#restart-safety)).
- **Read-only queue dashboard?** Hand-retrying or promoting jobs could bypass the rate limits or
  duplicate protection, so Bull Board refuses those actions server-side. Only `ADMIN_EMAILS` can
  open it (empty = any signed-in user).
- **Slack tunnel?** Slack redirects only to HTTPS after approval; the local API is plain HTTP. A
  deployment uses its own HTTPS domain. Alerts themselves need no tunnel ([Slack setup](#slack-setup)).
- **Ethereal?** Real SMTP, but mail is captured, not delivered, so testing never spams anyone. Each
  user gets at least 2 mailboxes ([Ethereal Email](#ethereal-email)).
- **User info in the sidebar, not a top header?** The sidebar's top card shows the name, email
  and avatar, and its menu holds Slack, Set password and logout, keeping account actions in one place.
- **Elasticsearch as a read model?** Postgres is the truth; Elasticsearch is a search copy
  updated in the background and rebuildable (`npm run reindex`). If it's down, only search stops.

**Contents:** [Quick start](#quick-start) · [Features → implementation](#features--implementation) · [Architecture](#architecture) · [FAQ](#intentional-decisions-faq) · [Architecture details](#architecture-details) · [Features implemented](#features-implemented) · [Setup](#setup) · [Ethereal Email](#ethereal-email) · [Restart safety](#restart-safety) ·
[Rate limiting](#rate-limiting) · [Behaviour under load](#behaviour-under-load-1000-emails) · [Concurrency](#concurrency) · [Provider throttling](#provider-throttling) · [Slack alerts](#slack-alerts) ·
[Authentication](#authentication) · [Importing recipients](#importing-recipients-upload-list) ·
[Attachments](#attachments) ·
[Testing](#testing) · [Trade-offs and known limitations](#trade-offs-and-known-limitations) · [Project structure](#project-structure)

---

## Architecture details

| Component | Role |
|---|---|
| **Postgres** | Source of truth: users, senders (SMTP passwords AES-256-GCM encrypted), campaigns, emails and their status, attachments (stored once per campaign), an append-only `email_events` audit trail, Slack integrations. |
| **Redis** | BullMQ queues and every piece of shared coordination: rate-limit windows, the send-start gate, sender cooldowns, locks, auth attempt counters, the session-version cache. Runs with append-only persistence and `noeviction`. |
| **API** | Auth, scheduling (validates, plans send times, commits rows, enqueues jobs), dashboard reads, search, attachments, Slack OAuth, Bull Board at `/admin/queues`. Stateless: run as many as you like. |
| **Worker** | Processes the three queues. Also stateless and horizontally scalable; runs a one-time reconciliation on boot. |
| **Elasticsearch** | Search read model, rebuilt from Postgres at any time (`npm run reindex`). The app keeps scheduling and sending if it's down. |

**One email = one row + one delayed job** (`jobId = emailId`). The job wakes at the planned
time and runs this pipeline (`backend/src/workers/email.processor.ts`):

```
claim ─▶ sender cooling down? ─▶ reserve rate-limit slot ─▶ slot in the future? ─▶ SENDING ─▶ send-start gate ─▶ SMTP ─▶ SENT
  │            └ defer               (Lua, atomic)              └ defer & sleep                                    │
  └ not claimable (cancelled / sent / deleted): no-op                                         4xx: cooldown + defer ┤
                                                                                              5xx: FAILED           ┘
```

**Email status lifecycle:**

```
SCHEDULED ──claim──▶ PROCESSING ──▶ SENDING ──SMTP ok──▶ SENT
    ▲                    │              │
    └── deferred/retry ──┘              ├── 4xx throttled ──▶ back to SCHEDULED (not an attempt)
                                        └── crash mid-SMTP ──▶ UNCERTAIN (never auto-resent)
SCHEDULED/PROCESSING/SENDING ──final failure──▶ FAILED        SCHEDULED ──user──▶ CANCELLED
```

## Features implemented

**Backend**

| Area | What's implemented | Where |
|---|---|---|
| Scheduler | `POST /api/emails/schedule` stores the campaign and one row per recipient in Postgres, then one **BullMQ delayed job** per email (`jobId = emailId`). No cron anywhere. | `modules/emails/email.service.ts`, `queues/index.ts`, `workers/email.processor.ts` |
| Persistence | Restarts don't lose or repeat emails: jobs live in Redis (persisted to disk), Postgres holds the truth, the worker reconciles the two on boot, and conditional state transitions stop duplicates. | [Restart safety](#restart-safety), `recovery/reconcile.ts` |
| Rate limiting | Per-sender hourly limit and minimum delay between sends (both configurable), enforced atomically in Redis, so it's safe across workers. Over-limit emails move to the next window, never dropped. Plus a global per-second cap. | [Rate limiting](#rate-limiting), `scheduler/rateLimiter.ts` |
| Concurrency | Configurable worker concurrency (`WORKER_CONCURRENCY`), any number of worker processes, and race-free state changes. | [Concurrency](#concurrency), `worker.ts` |
| Multiple senders | Every user gets `SENDERS_PER_USER` (at least 2) Ethereal mailboxes; Compose's From picks one per campaign. | `modules/senders` |
| Search | Elasticsearch index of all emails (recipient, subject, body, sender, status, dates), kept in sync on every change. Email addresses are split into parts on `. @ - _ +`, so "park", "example" or "example.com" find `eve.park@example.com`. Addresses and subjects also match by the start of a word ("redi" finds "Redis"). Results are always only the signed-in user's emails. | `modules/search`, `workers/index.processor.ts` |
| Live queue dashboard | **Bull Board** at `/admin/queues` (email-send, search-index, slack-notify), **read-only** (view jobs; no retry, promote, delete or pause, refused server-side), for the accounts in `ADMIN_EMAILS` only (others get 403; empty = any signed-in user). | `app.ts` |
| Slack alerts | Real OAuth v2 connect per user; one message when a sender hits its hourly limit; disconnect/reconnect without a redeploy. | [Slack alerts](#slack-alerts) |
| Provider throttling | A temporary SMTP rejection pauses the sender with backoff instead of failing emails. | [Provider throttling](#provider-throttling) |
| Auth | Google OAuth (real) plus email/password, httpOnly sessions that can be revoked. | [Authentication](#authentication) |
| Extras | Attachments, "Send again" for uncertain emails, cancel, star. | [Attachments](#attachments), [Restart safety](#restart-safety) |

**Frontend** (React + TypeScript + Tailwind + TanStack Query)

| Area | What's implemented |
|---|---|
| Login | Google sign-in (real OAuth), plus email/password and sign-up. After login you land on the dashboard. |
| Header / user | Sidebar user card with **name, email, avatar**; its menu has Slack, Set password and **Log out**. |
| Dashboard | **Scheduled** and **Sent** tabs with live counts, a **Compose** button, search, filters, stars, refresh, infinite scroll, phone layout. |
| Compose | Subject, rich-text body, **Upload List** (CSV/TSV/TXT; shows the **number of addresses detected**), recipient chips, **start time** (Send Later), **delay between emails**, **hourly limit**, attachments, then **Send / Send Later** → the schedule API. |
| Scheduled list | Recipient, subject, **scheduled time** (the orange clock pill) and **status** (a grey chip in the Sent pill's style: "Scheduled", or "Sending" while in flight), loading skeletons, empty state. |
| Sent list | Recipient, subject, **sent time**, **status** (Sent / Failed / Uncertain), loading skeletons, empty state. |
| Email detail | Sanitized body, attachments, delivery history, cancel, Send again. |
| Quality | Reusable UI components (`components/ui/` Button, IconButton, Modal; TextField, ConfirmDialog, FileCard, Avatar…), typed API responses and props. Loading: skeleton rows, spinners, count placeholders. Empty states in both tabs and for searches. Errors are never silent: a first load that fails shows "Try again" (lists, email detail, Compose's senders, the password dialog), and a failed background refresh or failed counts show a toast while the last loaded data stays. Actions that fail show a toast. Each case is covered by the browser suites. |

## Setup

**Prerequisites:** Node.js 20+ (developed on 24), Docker (for Postgres 16, Redis 7,
Elasticsearch 8), and internet access (Ethereal mailboxes are created on first sign-in).

```bash
# 1. Infrastructure
docker compose up -d                      # wait until `docker compose ps` shows 3× healthy

# 2. Backend
cd backend
npm install
cp .env.example .env                      # then set SESSION_SECRET and ENCRYPTION_KEY (commands inside)
npm run dev                               # API on :4000 (applies database migrations on start)
npm run dev:worker                        # in a second terminal: the worker

# 3. Frontend (third terminal, from the repo root)
cd frontend
npm install
npm run dev                               # http://localhost:5173

# 4. Optional: the demo account and sample emails (from the repo root)
cd backend && npm run seed:demo           # oliver.brown@domain.io / oliver-demo-password (local only)
```

Configuration is validated on start (`backend/src/config/env.ts`): a wrong value stops the
process with a message naming the variable. Every setting, its default and its meaning are in
[`backend/.env.example`](backend/.env.example); the frontend's two optional settings are in
[`frontend/.env.example`](frontend/.env.example). For demos, `RATE_WINDOW_MS=60000` turns the
"hourly" limit into a per-minute one. Any window other than 1 hour is **demo mode**, and the
app says so wherever the limit appears. The UI reads the window length from the server
(`/api/senders` limits, and each email's campaign settings), so nothing is hard-coded:

| Where | 1-hour window (default) | Demo mode (e.g. 1 minute) |
|---|---|---|
| Compose, next to "Hourly Limit" | no hint | "Demo mode: 1 window = 1 minute" |
| Email detail → Campaign settings | "3 per hour" | "3 per window (1 minute, demo mode)" |
| Slack alert | "⚠️ Hourly limit reached", "3 emails per hour" | "⚠️ Per-minute limit reached (demo mode)", "3 emails per minute (demo mode)" |

**Google sign-in** needs a real OAuth client (Google Cloud Console → Credentials → OAuth
client "Web application", redirect URI `http://localhost:4000/api/auth/google/callback`).
Everything else works without it. **Slack** is optional (all three `SLACK_*` or none); locally
it needs an HTTPS tunnel, see [Slack setup](#slack-setup).

### Google sign-in setup

1. https://console.cloud.google.com → create or pick a project → **APIs & Services → OAuth
   consent screen** (called **Google Auth Platform** in newer consoles): user type/audience
   *External*, fill in the app name and your email, and under **Test users** add the Google
   accounts that will sign in. While the app is in testing, only those accounts can sign in.
2. **APIs & Services → Credentials → Create credentials → OAuth client ID** → type **Web
   application**. Under **Authorized redirect URIs**, add exactly:
   `http://localhost:4000/api/auth/google/callback`
3. In `backend/.env`, set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from the client you
   just created. `GOOGLE_REDIRECT_URI` must be the same URL as in step 2 (it already is in
   `.env.example`).
4. Restart the API. **Sign in with Google** on the login page now works.

Serving the app through an HTTPS tunnel instead (cloudflared, ngrok or any other)? Add
`https://<tunnel-domain>/api/auth/google/callback` as a redirect URI and use it for `GOOGLE_REDIRECT_URI`.

| Command (in `backend/`) | What it does |
|---|---|
| `npm run dev` / `npm run dev:worker` | API / worker with reload on change |
| `npm run build` then `npm start` / `npm run start:worker` | Production build and run |
| `npm test` | Unit + integration tests (needs the docker services; offline) |
| `npm run test:ethereal` | Real delivery test through Ethereal over SMTP + IMAP (needs internet) |
| `npm run test:throttling` | Just the provider-throttling suite (≈ 25 s) |
| `npm run typecheck` | TypeScript check |
| `npm run db:generate` / `npm run db:migrate` | Create / apply migrations (the API also applies them on start) |
| `npm run seed:demo` | (Re)create the demo account and its emails. **Local development only**: refuses to run with `NODE_ENV=production` (set in the shell or in `.env`), before it connects to anything. |
| `npm run reindex` (`-- --recreate`) | Rebuild the search index from Postgres. Use `--recreate` after a mapping change (the API logs a warning if the index is outdated). |
| `npm run load-test -- --count 1000 --hourly 50` | End-to-end rate-limit check with a report; exits non-zero on any violation |
| `npm run cleanup:test-leftovers` | Dry run listing test leftovers in the app's data; `-- --apply` removes them (see [Testing](#testing)) |

Frontend (`frontend/`): `npm run dev`, `npm run build`, `npm run typecheck`, and `npm run e2e` (browser
end-to-end tests against the running app, see [Testing](#testing)).

## Ethereal Email

[Ethereal](https://ethereal.email) is a fake SMTP service: it accepts mail like a real
provider but never delivers it, and keeps every message for you to inspect.

- **No setup needed.** On a user's first sign-in the backend creates `SENDERS_PER_USER`
  (2–10, default 2; the app refuses to start with 1) Ethereal mailboxes via Nodemailer's
  `createTestAccount()`, and Compose's **From** lets you pick one per campaign. Each is a real
  account with its own SMTP credentials. Credentials are stored per sender in Postgres, with
  the password encrypted using `ENCRYPTION_KEY`, and reused across restarts. If Ethereal
  is briefly unreachable at sign-in, or the setting was raised later, the missing ones are
  created the next time Compose loads or a campaign is scheduled. Nodemailer normally caches
  **one** test account per process, which would hand every "new" sender the same mailbox, so
  that cache is switched off where the app loads Nodemailer (`src/lib/nodemailer.ts`).
- **Seeing what was sent:** open any sent email → **"to … ▾" → Open in Ethereal**. That's the
  message preview URL Nodemailer returns for each send, and it shows the exact message
  including attachments. The detail view's From line shows which Ethereal mailbox sent it.
- **Env variables involved:** `SENDERS_PER_USER`, `ENCRYPTION_KEY` (must never change once
  senders exist), and the pacing settings (`MIN_DELAY_BETWEEN_EMAILS_MS`,
  `MAX_EMAILS_PER_HOUR_PER_SENDER`, `RATE_WINDOW_MS`). All are documented in
  [`backend/.env.example`](backend/.env.example).
- Ethereal may throttle a heavily used mailbox (it answers `429`); see
  [Provider throttling](#provider-throttling).

## Restart safety

Postgres is the source of truth; Redis holds the work queue. Every failure mode below ends
with each email sent **at most once** and nothing silently lost:

| What happens | Result |
|---|---|
| API dies after committing a campaign, before enqueueing its jobs | Rows are `SCHEDULED` without jobs. The worker's **boot reconciliation** re-adds them. |
| Enqueueing fails (Redis down) | The request rolls the campaign back and answers `503`; nothing half-scheduled. Retrying with the same `Idempotency-Key` can't create a duplicate campaign. |
| Worker dies before SMTP (`PROCESSING`) | Safe to redo: BullMQ's stalled-job check (or boot reconciliation) runs it again. |
| Worker dies **during** SMTP (`SENDING`) | Can't know if the provider accepted it, so it becomes **`UNCERTAIN`** and is never resent automatically (the dashboard explains why). A duplicate is worse than a gap. |
| SMTP succeeded but marking `SENT` failed | The write is retried; if the database stays down the row remains `SENDING` → `UNCERTAIN` on the next run, never resent. |
| Normal deploy / `Ctrl+C` / `SIGTERM` | The worker stops taking jobs and waits up to 25 s for in-flight sends to finish; the API drains requests. (In a container, set the stop grace period above 25 s.) |
| Redis restarts | Append-only file with `fsync` every second: at most ~1 s of writes at risk, and reconciliation re-adds any `SCHEDULED` email whose job went missing. |
| Elasticsearch down | Scheduling and sending continue; index jobs retry with backoff; `npm run reindex` rebuilds everything. |

**Boot reconciliation** (`backend/src/recovery/reconcile.ts`) runs once when a worker
starts, before it takes jobs, under a Redis lock so only one worker does it: `SCHEDULED`
without a live job → re-add; `PROCESSING` without an active job → back to `SCHEDULED` +
re-add; `SENDING` without an active job → `UNCERTAIN`. Jobs still marked active are left
to BullMQ's stalled check, which re-runs them through the same claim rules.

**Order after a restart.** If the worker was off past the send time, all overdue emails
become due at once. Taken in parallel, they would race for rate-limit slots (first to reach
Redis wins), so e.g. bob could go out after eve. So the last step of boot reconciliation, still
under the lock and before any job is taken, hands out their slots itself:

- **Order:** one sender at a time, by planned time. Within a campaign, planned times already
  follow recipient order, since each email is at least the gap after the previous one. Ties
  across campaigns go by campaign, then email creation, then id.
- **Same rules:** it uses the **same Redis script** as the worker, so the limit and the gap are
  unchanged. The first slot is 1 s after startup, so each email wakes at its own slot, one gap
  after the previous one, as in normal running.
- **What's recorded:** each job keeps its slot. The row's time and its History are updated
  ("… moved to … (after a restart, in planned order)"), and the Slack limit alert fires as usual.
- **What still applies:** when the job runs, the worker uses that slot. The send-start gate still
  checks the gap and that the window hasn't ended. `jobId = emailId` and the conditional
  updates still prevent duplicates.
- **Skipped:** senders in a provider cooldown, and jobs that aren't waiting or delayed (e.g.
  running in another worker). Those reserve at run time, as before.

Verified by `backend/test/restartOrder.test.ts`. With the worker off past the send time, 8
emails (limit 3) go out in the original order after the restart, with at most 3 per window,
starts at least the gap apart, and each delivered once. Without this step the same test fails.

**Remaining limits on order:**
- **Emails due at the same moment while the worker is running** (e.g. several campaigns of
  one sender due at the same second, or a worker so busy that jobs wake late) can still
  race for slots and go out in either order.
- **A slot in the last instant of a window whose job starts late** is moved to the next free
  place by the window-ended check (see [Rate limiting](#rate-limiting)), which can put it
  after later emails.

In every case the limit, the gap and "at most once" still hold.

Duplicate-proofing: `jobId = emailId` (re-adding a job is a no-op), every state change is a
conditional `UPDATE … WHERE status IN (…)`, and cancelling only wins while the email is
still `SCHEDULED`.

*Earlier development observation (not re-run for this README):* 120 emails at 30/min with the
worker hard-killed mid-send → 2 emails were caught mid-SMTP and became `UNCERTAIN`, the other
118 were sent, none twice. The automated checks of the same guarantees are
`backend/test/restart.test.ts` (a mid-SMTP email becomes `UNCERTAIN` and is never re-sent; a
duplicate job delivers nothing) and `backend/test/restartOrder.test.ts`.

**Resolving an UNCERTAIN email: "Send again".** The email detail view explains that the
email may or may not have arrived, and offers **Send again** (with a confirmation that warns
about a possible duplicate). `POST /api/emails/:id/resend` creates a **new email** (new id,
same campaign, so the same body and attachments, and `resend_of` pointing at the original)
and queues it through the normal pipeline, rate limits included. The original row is never
modified; both emails link to each other and record the action in their history. It's
**idempotent**: a unique index on `resend_of` allows one copy per original, so repeated or
concurrent clicks return the same copy. Verified by `backend/test/resend.test.ts` (new id,
original row identical field for field, 5 concurrent requests → 1 copy, only `UNCERTAIN`
allowed) and the `account` browser suite (through the UI, delivered by the worker).

## Rate limiting

**Chosen values:** at least **2 seconds between two sends of the same sender**
(`MIN_DELAY_BETWEEN_EMAILS_MS=2000`), at most **200 emails per hour per sender**
(`MAX_EMAILS_PER_HOUR_PER_SENDER=200`), and at most **20 emails per second overall**
(`GLOBAL_MAX_EMAILS_PER_SECOND=20`). All are env settings; nothing is hard-coded.

Every sender is limited by two rules: **at most N emails per window** (hourly by default,
`RATE_WINDOW_MS`) and **a minimum gap between two sends**. A campaign can choose stricter
values than the system ceilings in `.env`, never looser. On top of that, BullMQ's queue-wide
limiter caps total throughput (`GLOBAL_MAX_EMAILS_PER_SECOND`).

Enforcement happens in three layers, all in Redis so it holds across any number of workers:

1. **Plan (at submit time).** `scheduler/planner.ts` spaces emails by the gap and pushes
   overflow into later windows, so the dashboard shows realistic send times immediately.
   This is a prediction, not enforcement.

2. **Slot reservation (when a job wakes).** One atomic Lua script (`reserveSendSlot`) picks
   the earliest time that satisfies both rules and counts it in its window. If the current
   window is full it reserves a slot in a *future* window and the job sleeps until then, so
   1000 emails against a 200/h limit spread over 5 windows with each job rescheduled at most
   once, with no thundering herd on every hour boundary. The reservation is stored on the
   job so waking up doesn't count it twice. When a sender fills its window, one Slack
   message is sent per sender per window (a `SET NX` claim).

3. **Send-start gate (immediately before SMTP).** Reserved slots are spaced exactly, but a
   delayed job wakes slightly *after* its slot (BullMQ timer, event loop and the steps before
   SMTP), so two actual sends could start closer than the gap. Measured from the 60 sends
   recorded in the development database (reserved slot → actual SMTP start): median 61 ms,
   95th percentile 205 ms, maximum 692 ms, and never before the slot. A second atomic Lua script
   (`sendStartGate`) closes that hole:

   ```
   now = Redis TIME
   if now − lastStart[sender] < gap:  return wait = gap − (now − lastStart)
   else:                              lastStart[sender] = now; return 0   → start SMTP
   ```

   Because the check and the write are one script, two concurrent jobs, even on different
   machines, can never both pass. Redis's own clock is used, so workers don't need synced
   clocks. A short wait (≤ 1 s) sleeps in-process and retries; a longer one puts the email
   back to SCHEDULED and re-queues the job with `moveToDelayed`, so a worker slot is never
   blocked. The gate runs after everything else (DB update, SMTP transport lookup), so
   nothing slow sits between "allowed to start" and `sendMail`.

4. **Window check at the gate.** The same gate script also refuses to start an email whose
   slot was counted in a window that has **already ended**. A job whose slot is the last
   moment of one window can wake a few milliseconds late. Without this check it would start
   just after the boundary, one send too many for the new window if that window is already
   full. (This happened once: a slot at 12:14:59.991 started at 12:15:00.041, the 4th start
   in a window with a limit of 3.) Such an email is put back and counted in the current window,
   or the next free one. Its History says "Its limit window ended just before sending
   started, so it was counted in the next window instead", and it goes through the gate again,
   so the gap still holds. The old slot stays counted (the strict side).
5. **Order.** Slots are handed out in the order jobs ask for them. While the worker is
   running, emails become due one by one in planned order, so they go out in that order.
   After a restart, overdue emails are given their slots in planned order at startup, so
   they don't race. For details and the remaining edge cases, see
   [Order after a restart](#restart-safety).

**Verified by:**

- `npm test` (`backend/test/sendGate.test.ts`): 30 jobs released at the same instant never
  start closer than the gap, including through the re-queue path. With the gate disabled,
  the tests fail.
- `npm test` (`backend/test/windowBoundary.test.ts`): the exact case above. A slot in the last
  moment of a window, a job waking late, and the next window already full: the email is not
  sent there, it moves to the next free window with that History entry, and still keeps the gap
  to the email due at the same moment. With the window check disabled, the test fails.
- `npm run load-test`: an end-to-end run that reports sends per window, the gap between
  reserved slots and the gap between actual SMTP starts (recorded on each `SENT` event),
  and exits non-zero if any guarantee is violated. Latest run with two worker processes:
  at most 50 per window for a limit of 50, and a minimum start gap of 501 ms for a 500 ms rule
  (see [Behaviour under load](#behaviour-under-load-1000-emails)).

**Start time vs. finish time.** The limit and the gap apply to send **starts**, so the Sent
list and the detail show when sending **started** (stored as `send_started_at`, from the
gate's Redis clock). When the mail server **accepted** it (SMTP finished) is in the row's
tooltip and in the detail's "to ▾" panel ("started" and "sent · accepted by server"). Ethereal
often takes 1–4 s per message, so finish times bunch up even when starts are spaced correctly.
For example, emails with a 1 s delay started at 12:15:01.05, 02.05 and 03.06 but finished at
05.02, 04.85 and 05.74.

**Trade-offs:**

- Slots that end up unused (a job re-reserves after waking late, or retries after an
  error) stay counted. The limiter can only err on the strict side, never exceed the limit.
- The gate runs while the email is `SENDING`. If a worker is killed during the ≤ 1 s gate
  wait, that email is marked `UNCERTAIN` on recovery even though SMTP never started. That's
  the safe direction: never a duplicate.
- The provider's own limits are handled separately: see [Provider throttling](#provider-throttling).

## Behaviour under load (1000+ emails)

What happens when **1000+ emails are scheduled for the same moment** and that exceeds the
hourly limit:

1. **Accepting them is one request.** Rows are inserted in chunks of 1000 inside one
   transaction, and jobs are enqueued with `addBulk` in chunks of 500. Through the real
   HTTP API, 1000 recipients were accepted in 2.2 s (about 1 s in the integration test).
2. **The dashboard shows realistic times immediately.** The planner assigns each email a time:
   spaced by the delay, at most *limit* per window, and the rest in the following windows,
   in order.
3. **Sending never exceeds the limit, and nothing is dropped.** Each job, when due, reserves a
   slot with the atomic Lua script. With 1000 emails and a limit of 200/h: 200 go in the
   current hour and the rest are **rescheduled into the next available hours** (200 each),
   in order. Each job moves at most once, so there's no retry storm at every hour boundary.
   Jobs are never failed because of the limit.
4. **Throughput stays bounded.** Worker concurrency caps parallel sends per process, the
   global per-second limiter caps all workers together, and the send-start gate keeps the
   minimum delay between two sends of a sender.
5. **The UI stays fast.** The lists are paginated and scroll infinitely; indexing happens in
   the background in batches of 500.
6. **If the provider pushes back** (4xx), the sender cools down instead of failing emails
   (see [Provider throttling](#provider-throttling)).

**Verified by** `backend/test/scheduling.test.ts`: the planner puts 1000 simultaneous emails
into 5 × 200; **1000 concurrent slot reservations** give exactly 200 per window over 5
consecutive windows, none dropped and no two sharing a slot; and scheduling **1000
recipients through the API** creates 1000 rows and 1000 delayed jobs within the limit.
`npm run load-test -- --count 1000 --hourly 50` checks the same thing end to end against
the running worker.

**Observed end to end** (real Ethereal SMTP, demo mode with 1-minute windows, **two worker
processes** running side by side). Command: `npm run load-test -- --count 1000 --hourly 50
--delay 500`, as its own `load-test@mailflow.local` account.

- **Accepted:** all 1000 in **2.2 s** in one API request. They were planned at 50 per window
  across 20 windows; the first window only had its last ~17 s left, so it got 33.
- **Run:** the send was left running through 4 full windows, then the remaining 755 were
  cancelled and the account removed with `npm run cleanup:test-leftovers -- --load-test --apply`.

Measured from the send start times recorded in Postgres:

| Window (UTC) | Sends started | First → last start |
|---|---|---|
| 11:56 (partial) | 32 | 11:56:43.9 → 11:56:59.9 |
| 11:57 | **50** | 11:57:00.5 → 11:57:25.4 |
| 11:58 | **50** | 11:58:00.1 → 11:58:25.0 |
| 11:59 | **50** | 11:59:00.2 → 11:59:25.1 |
| 12:00 | **50** | 12:00:00.1 → 12:00:25.1 |
| 12:01 (cancelled during it) | 13 | 12:01:00.2 → 12:01:06.7 |

- **Most sends in any window: 50** (limit 50). Each full window's 50 took 25 s, which is 50 × 0.5 s,
  and the rest of the minute was idle, as the limit requires.
- **Shortest gap between two starts: 501 ms** (rule: 500 ms), across both workers.
- **Workers:** they shared the load (125 and 120 sends) with no warnings or errors.
- **Duplicates: 0.** No email had two `SENT` records and no message id repeated.
- **Failed: 0, uncertain: 0.** 245 sent, 755 cancelled.
- **Ethereal throttled 0 times** at this pace (average SMTP time 1.4 s, max 4.3 s), so the
  provider cooldown wasn't needed. It is covered by `npm run test:throttling`.
- **Window boundary:** one email had the last slot of 11:56, woke late and would have started at
  11:57:00.47 in a window already promised to 50 others. The send-start gate's window check
  refused it and moved it into 11:57, which is why 11:56 shows 32 rather than 33.

## Concurrency

The system is built to run **N API processes and M worker processes** against the same
Postgres and Redis. Nothing correctness-related lives in process memory.

| Concern | How it's handled |
|---|---|
| Parallel sending | Each worker runs `WORKER_CONCURRENCY` jobs at once (default 5); add worker processes to scale. BullMQ locks each job to one worker; a crashed worker's jobs are picked up by the stalled-job check. |
| Total throughput | BullMQ's queue-wide limiter (`GLOBAL_MAX_EMAILS_PER_SECOND`) applies across all workers. |
| Per-sender limits | Atomic Lua scripts (slot reservation, send-start gate, cooldown). Two jobs can never take the same slot or both pass the gate, across machines. |
| Email state races | Every transition is a conditional `UPDATE`: claim `SCHEDULED/PROCESSING → PROCESSING`, `PROCESSING → SENDING`, `SENDING → SENT`. Cancel vs. send: cancel only succeeds on `SCHEDULED`; if the worker claims first, cancel answers `409`, and if cancel wins, the claim finds nothing and the job no-ops. |
| Double submit | `Idempotency-Key` header + unique index (`user_id, idempotency_key`): a retried or double-clicked Send returns the first campaign; two concurrent requests race on the index and the loser returns the winner's result. The Compose screen sends one key per session. |
| Enqueue duplicates | `jobId = emailId`: adding an existing job is a no-op (recovery and retries are safe). |
| Boot-time work | Reconciliation runs under a Redis lock (token-checked release); database migrations under a Postgres advisory lock. |
| Search index | Index jobs load the latest row and upsert it, so duplicates and out-of-order jobs are harmless. |
| Sessions / auth | Session-version cache: writers `SET` after commit, readers fill misses with `SET NX` (a stale reader can't overwrite a fresh value). Brute-force counters are atomic `INCR + EXPIRE` scripts. |
| Attachments | Loaded per campaign and cached per worker (≤ 64 MB, LRU); read-only, so no coordination needed. |

## Provider throttling

Our limits are the ones *we* choose; the SMTP provider can still push back. A **temporary
SMTP reply (any 4xx: 421, 450, 451, 452, 454, Ethereal's 429 …)** means "slow down", so the
worker (`handleThrottle` in `email.processor.ts`):

1. puts the **whole sender on a cooldown** in Redis: `THROTTLE_COOLDOWN_BASE_S` (60 s) the
   first time, **doubling on each repeat**, capped at `THROTTLE_COOLDOWN_MAX_S` (15 min). The
   doubling level is remembered for an hour and reset by the next successful send;
2. **defers the email** to the end of the cooldown **without counting a failed attempt**
   (the attempt counter is undone and the job is moved to delayed, which BullMQ doesn't
   count either);
3. makes the sender's **other emails wait** too: before reserving a slot, every job checks
   the cooldown and defers itself, so a throttled sender doesn't keep hammering the provider
   or burn its hourly slots;
4. logs a `THROTTLED` email event (code, reply, cooldown length, deferral n of max), which
   the email detail view's History shows.

Guard rails:
- **Capped:** after `THROTTLE_MAX_DEFERRALS` (10) throttles an email **fails** with a clear
  reason (*"Provider kept rate-limiting this sender (10 deferrals); last reply: …"*) instead
  of looping forever. The count comes from the email's events in Postgres, so it survives
  restarts and requeues.
- **No compounding:** the cooldown is one atomic Lua script. If several emails of a sender
  are rejected at the same moment, the first one starts the cooldown and the others join it
  instead of doubling it once each.
- **Permanent errors still fail immediately:** a 5xx reply marks the email `FAILED` with no
  retries and no cooldown. Network errors (no SMTP reply) keep the normal limited retries
  with exponential backoff.

**Verified by** `npm test` (`backend/test/throttling.test.ts`), which runs the real email
processor against a local SMTP server with scripted replies: 421 twice then accepted →
`SENT` with 1 attempt, cooldowns 1 s then 2 s; a cooldown holds back the sender's other
emails; a 550 fails at once with no cooldown; permanent 421s fail after the cap with the
reason; concurrent throttles share one cooldown, doubling stops at the max, and a success
resets it. With the "not a failed attempt" fix removed, the test fails.

## Slack alerts

Optional: set all three `SLACK_*` settings or none. Each user connects their own workspace from the **user menu → Connect Slack**
(OAuth v2, `incoming-webhook` scope: Slack's consent screen asks for the channel). The menu
then shows the **workspace and channel**, **Send test message** and **Disconnect**; the
dashboard confirms the OAuth outcome with a toast (`?slack=connected|error|cancelled`).

When a sender fills its window, **one** message per sender per window goes to that channel
(a Redis `SET NX` claim, so a campaign of 1000 emails doesn't post 1000 alerts). The
integration is read fresh for every message, so connecting or disconnecting takes effect
immediately. A webhook Slack has removed marks the integration `REVOKED` and the menu offers
**Reconnect**. The OAuth `state` is a single-use Redis nonce (not a cookie), so the flow
works through a tunnel on another domain. Tokens and webhook URLs are encrypted at rest.

The alert uses **Block Kit**: a header named after the real window ("⚠️ Hourly limit
reached", or "⚠️ Per-minute limit reached (demo mode)" with `RATE_WINDOW_MS=60000`), then the sender, the
limit, the current window, **how many emails the limit pushed into a later window** (not the
ones still going out in this window, and not campaigns simply scheduled for later) and when
sending resumes (times render in each reader's own timezone), and an **Open dashboard** button.
An email's History shows when the limit moved it: at scheduling time when the planner already
placed it in a later window ("Sending limit (3) reached, scheduled for …"), or at send time when
the worker had to move it ("… moved to …"). A short wait for the delay between emails is shown
as spacing, not as the limit. It also carries a plain-text
fallback for notifications. The test message is one short line. `npm run slack:preview`
(in `backend/`) prints both messages and a Block Kit Builder link, without sending anything.
Optional: set the Slack app's **Interactivity** Request URL (see [Slack setup](#slack-setup)),
otherwise Slack shows a small warning icon after the button is clicked.

Verified by `backend/test/slack.test.ts` (install redirect, every callback outcome,
single-use state, encryption at rest, test message to a real local webhook, revocation,
disconnect) and the `account` browser suite (menu states, redirect toasts, and a real
campaign hitting its limit posting exactly one alert to a local webhook).

### Slack setup

**Why a tunnel (local development only).** Slack only redirects to **HTTPS** URLs after the
user approves the app. Locally the API is plain `http://localhost:4000`, so a tunnel gives it a
temporary public HTTPS address. Only Slack's redirect (and the optional button callback) goes
through the tunnel; you keep using the app at `http://localhost:5173`, and after connecting
you land back there. Alerts themselves are sent *from* the worker *to* Slack, so they need no
tunnel.

**A real deployment needs no tunnel.** It already has its own HTTPS domain: use
`SLACK_REDIRECT_URI=https://<your-api-domain>/api/integrations/slack/callback` and add that
exact URL in the Slack app.

**1. Start a tunnel to the API** (local only). This uses Cloudflare's free quick tunnels; no account needed.

- **Windows** (PowerShell):
  ```powershell
  winget install --id Cloudflare.cloudflared
  # close and reopen the terminal so cloudflared is on PATH, then:
  cloudflared tunnel --url http://localhost:4000
  ```
  Without winget: download `cloudflared-windows-amd64.exe` from
  https://github.com/cloudflare/cloudflared/releases/latest and run
  `.\cloudflared-windows-amd64.exe tunnel --url http://localhost:4000` in its folder.
- **Mac** (Terminal, with Homebrew):
  ```bash
  brew install cloudflared
  cloudflared tunnel --url http://localhost:4000
  ```

It prints an address like `https://random-words-here.trycloudflare.com`. Keep that window
open; the tunnel stops when you close it. Check it: opening
`https://random-words-here.trycloudflare.com/api/health` should show `"status":"ok"`.

ngrok (`ngrok http 4000`) or any other HTTPS tunnel works just as well; use its address below.

**2. Create the Slack app** at https://api.slack.com/apps → **Create New App** → **From
scratch** → pick a name and your workspace. Then:
- **OAuth & Permissions → Redirect URLs**: add
  `https://random-words-here.trycloudflare.com/api/integrations/slack/callback` and **Save URLs**.
- **OAuth & Permissions → Scopes → Bot Token Scopes**: add `incoming-webhook`.
- **Basic Information → App Credentials**: copy the **Client ID** and **Client Secret**.
- Optional, **Interactivity & Shortcuts**: turn it on with Request URL
  `https://random-words-here.trycloudflare.com/api/integrations/slack/interactions`. That
  endpoint just answers 200, which stops Slack showing a warning icon when the alert's button
  is clicked.

**3. Configure and restart.** In `backend/.env`:

```
SLACK_CLIENT_ID=<client id>
SLACK_CLIENT_SECRET=<client secret>
SLACK_REDIRECT_URI=https://random-words-here.trycloudflare.com/api/integrations/slack/callback
```

Restart the API and worker. Then in the app: **user menu → Connect Slack**, approve and pick a
channel, and use **Send test message**.

**Quick-tunnel addresses change every time `cloudflared` restarts.** If you restart it,
update `SLACK_REDIRECT_URI` and the Slack app's Redirect URL (and the Interactivity URL) to the
new address, then restart the API. An already connected workspace keeps receiving alerts
meanwhile; only connecting (or reconnecting) needs the current address. A named Cloudflare
tunnel, or ngrok with a reserved domain, gives a stable address if you need one.

## Authentication

Two ways to sign in, both ending in the same httpOnly, `SameSite=Lax` JWT session cookie:

- **Google OAuth**: CSRF `state` cookie, ID-token signature check, and only Google-verified
  emails are accepted.
- **Email + password**: `POST /api/auth/signup` (name, email, password) and
  `POST /api/auth/login`. Emails are trimmed and lowercased and are unique across all
  accounts. Passwords are 8–128 characters and hashed with **argon2id** (64 MiB, t=3, p=4).
  The 128 cap also bounds the hashing cost an attacker can force per request. New password
  users get Ethereal senders provisioned exactly like Google users.

**Account linking.** One email = one account. When someone signs in with Google and a
password account with the same (Google-verified) email exists, the Google identity is
attached to it (the account and its data are kept). Password login on a Google-only account
answers "This account uses Google sign-in".

**Account pre-hijacking is closed.** Password sign-up can't prove email ownership (there's
no real email delivery, see below), so without protection an attacker could register
`victim@gmail.com` with their own password, wait for the real owner to sign in with Google,
and keep access through the linked account. Two changes prevent this:

1. **Linking removes the unverified password and revokes every session.** Google is the
   first party to *prove* who owns the email, so on linking `password_hash` is set to
   `NULL` and `users.session_version` is incremented in the same UPDATE. The attacker's
   password stops working, and so do any sessions they already had.
2. **Sessions can be revoked.** Sessions are stateless JWTs, so each token carries the
   user's `session_version` (`sv`). `requireAuth` rejects a token whose `sv` isn't the
   user's current version. The current version is cached in Redis (`auth:sv:<userId>`,
   10 min TTL), so authenticating a request isn't a database query:
   - writers publish the new version with `SET` *after* the DB commit, and readers fill
     misses with `SET NX`, so a reader holding a stale value can never overwrite a fresh one;
   - if Redis is slow or down, the check reads Postgres (fails safe, never "allow").

   Tokens issued before versioning existed (no `sv`) are rejected.

After linking, the owner can create a real password from the **user menu → Set password**
(`POST /api/auth/password`; "Change password" when the account already has one). It also bumps `session_version`, logging out every other device, and re-issues
the current device's cookie. To be safe against a stolen session:
- if the account already has a password, the **current password is required** (wrong
  attempts count toward the per-email login limit);
- if it's Google-only, the session must be **recent** (signed in within 15 min), otherwise
  `403 REAUTH_REQUIRED`; the dialog then explains why and offers **Sign in with Google**.

Trade-off: someone who legitimately signed up with a password and later uses "Sign in
with Google" loses their old password (by design, since it was never verified) and can set a
new one right away with the endpoint above.

**Login errors are generic.** A wrong password and an unknown email return the same
`401 Invalid email or password`. Unknown emails are still checked against a dummy argon2
hash, so response time doesn't reveal whether an account exists.

**Brute-force limits (Redis, shared by all API instances, `429` + `Retry-After`):**

| | Per IP | Per email |
|---|---|---|
| Login | 20 attempts / 15 min | 5 **failed** attempts / 15 min (a success resets it) |
| Sign-up | 10 / 15 min | 3 / 15 min |

Counting only failures per email means an attacker can lock a user out for at most one
window. Emails are SHA-256 hashed in Redis key names. All limits are env-configurable
(`LOGIN_MAX_PER_IP`, `LOGIN_MAX_FAILURES_PER_EMAIL`, …).

**Verified by** `npm test` (`backend/test/auth.test.ts`):
- signup, validation, duplicates, login, identical responses for a wrong password and an
  unknown email, the Google-only message, and every rate limit;
- the **pre-hijacking scenario end to end**: an attacker signs up with the victim's email →
  the victim signs in with Google → the attacker's old session gets `401` and their password
  is refused, while the owner's session works;
- set-password: other sessions revoked, current password required, recent sign-in required;
- the Redis version cache being what decides, the fallback to Postgres on a miss, and
  pre-versioning tokens being rejected.

With the linking fix removed, the pre-hijacking test fails.

## Importing recipients ("Upload List")

Compose's **Upload List** reads a lead list in the browser and adds its addresses to the
To field as chips (the server re-validates every address when scheduling):

- Accepts `.csv`, `.tsv` and `.txt` up to 5 MB. Quoted CSV fields (commas and line
  breaks inside quotes), a UTF-8 BOM, and comma / semicolon / tab delimiters are handled.
- Finds the address column by its header (`Email`, `E-mail address`, `email_id`, …); without
  a recognised header, by content (the column where most cells are addresses); failing both,
  it scans the whole text for addresses (plain lists, notes).
- Lowercases and de-duplicates (within the file and against addresses already added), and
  reports what happened, e.g. *"Imported 250 addresses from leads.csv (3 rows without a
  valid address skipped, 12 duplicates ignored)"*.
- Stops at the per-campaign limit (`MAX_RECIPIENTS_PER_CAMPAIGN`, 10 000) and says how many
  were left out. Excel files (.xlsx) aren't parsed; export them as CSV.

A sample file is in [`demo/leads.csv`](demo/leads.csv).

## Attachments

Compose's paperclip (or drag & drop) attaches files; every email of the campaign is sent
with them, and the email detail view shows them as cards (images with a thumbnail).

- **Stored once per campaign.** Files go into the `attachments` table (Postgres, so they
  survive restarts) linked to the campaign, not per email: 1000 recipients × 2 files = 2 rows.
- **No file contents in Redis.** Queue jobs carry only the email id; the worker loads the
  campaign's files from Postgres (cached per worker, bounded to 64 MB, LRU).
- **Limits enforced on the server:** at most `ATTACHMENT_MAX_FILES` (5) files and
  `ATTACHMENT_MAX_TOTAL_BYTES` (10 MB) in total. Multer stops reading oversized uploads
  early (413). The UI mirrors the same limits, read from `GET /api/senders`.
- **Safe types only:** PNG, JPG, GIF, WebP, PDF, Word, Excel, PowerPoint, OpenDocument,
  TXT, CSV. The type is taken from the extension **and** must match the file's magic
  bytes; the browser's MIME type is ignored. So `invoice.pdf.exe`, a renamed executable,
  SVG/HTML (script-capable), macro-enabled Office files and archives are all rejected.
- **Sanitized names:** path parts, control and bidi-override characters (the
  `gpj.exe` → "exe.jpg" trick), and characters illegal on common file systems are
  removed; length is capped; reserved Windows names are prefixed.
- **Safe download:** `GET /api/emails/:id/attachments/:attachmentId` checks ownership
  through the email. Only images are served inline (for thumbnails); everything else is a
  download. Responses carry `nosniff` and a `sandbox` CSP.
- Nodemailer (v10) transports run with `disableFileAccess`/`disableUrlAccess`: only
  in-memory content is ever sent.

**Verified by:**
- `npm test` (`backend/test/attachments.test.ts`): file-name sanitizing, type/magic-byte
  checks, count/size limits (server-side), one stored copy per campaign, job payloads in
  Redis containing only the email id, and the download route's headers and ownership.
- `npm run test:ethereal` (`backend/test/e2e/ethereal-attachments.e2e.ts`, needs
  internet): schedules a 3-recipient campaign with a PNG and a PDF through the API, runs
  the real worker, then reads the Ethereal mailbox over IMAP and checks every email arrived
  with both attachments byte-for-byte (SHA-256).

## Testing

| Command | What | Needs |
|---|---|---|
| `backend: npm test` | 110+ tests: restart recovery and idempotency, 1000-email load, rate limiter and send gate, provider throttling against a scripted SMTP server, auth (incl. pre-hijacking, sessions, limits), attachments, Slack (incl. the worker's alert), Send again, list/search/star | docker services |
| `backend: npm run test:throttling` | Just the throttling suite | docker services |
| `backend: npm run test:ethereal` | Real delivery with attachments, verified over IMAP (not in CI, see below) | internet |
| `backend: npm run load-test` | Rate-limit guarantees end to end, with a report | running app |
| `frontend: npm run e2e` | Browser suites in real Chrome: auth, dashboard, detail, compose, account ([details](frontend/e2e/README.md)) | running app + Chrome |

**Continuous integration** ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs on
every push and pull request:
- **Backend job:** typecheck, `npm test` and `npm run test:throttling`, against Postgres 16,
  Redis 7 and Elasticsearch 8 service containers. It uses throwaway settings; the tests fake
  Google, Slack and Ethereal's account API.
- **Frontend job:** typecheck and production build.

**`npm run test:ethereal` is not run in CI.** It creates real mailboxes on ethereal.email,
sends real mail through Ethereal's SMTP server and reads it back over IMAP. So it depends on
an outside service being up and reachable, which isn't something CI can control, and Ethereal
limits how often it can be used. Run it locally before a release; the CI-safe
`etherealProvisioning.test.ts` covers the provisioning logic without the network.

**Backend tests never touch the app's data.** `test/helpers/testEnv.mts` is preloaded into
every test process. It switches to a separate Postgres database (`mailflow_test`, created
automatically), Redis database 1 and search index `emails_test`, and refuses to run if they
would be the real ones. A running dev worker therefore never sees test jobs. Override with
`TEST_DATABASE_URL`, `TEST_REDIS_URL` and `TEST_ELASTICSEARCH_INDEX`. The browser suites
(`npm run e2e`) are different: they drive the running app, so they use its data and the
demo account. They clean up after themselves: the sign-up suite deletes the `e2e-…@example.com`
account it creates, and whenever a suite or `seed:demo` deletes emails directly, their queue
jobs go too.

**Removing test leftovers** from the app's data (e.g. from runs before the above):
`cd backend && npm run cleanup:test-leftovers`. It is a dry run by default and prints exactly
what it would remove. `-- --apply` removes it, and `-- --load-test` also includes the
`npm run load-test` account and its emails. It only ever removes `e2e-…@example.com` accounts,
the load-test account (if asked), and queue jobs, rate-limit keys and search documents whose
email, user or sender no longer exists. Other accounts, their emails and running jobs are
never touched.

Several tests were checked by removing the code they protect and running them again; each then
fails:
- the send-start gate: 3 of 5 tests in `sendGate.test.ts`;
- the account-linking fix: 2 tests in `auth.test.ts`, including the pre-hijacking scenario;
- the "a throttle isn't a failed attempt" rule: 2 tests in `throttling.test.ts`;
- also the window-ended check (`windowBoundary.test.ts`), the restart ordering
  (`restartOrder.test.ts`), the Ethereal cache fix (`etherealProvisioning.test.ts`), the
  search mapping (`search.test.ts`) and the `seed:demo` guard (`seedDemoGuard.test.ts`).

## Trade-offs and known limitations

- **At-most-once over at-least-once.** An email interrupted mid-SMTP becomes `UNCERTAIN`
  rather than being resent; resending is the user's explicit choice (**Send again**).
- **No password reset and no email verification.** Both need real email delivery, and this
  project only has Ethereal inboxes (they capture mail, they don't deliver it). A half-done
  reset flow is worse than none; users can sign in with Google and set a new password from the
  user menu. The pre-hijacking protection above makes the lack of
  verification harmless to real owners.
- **Unused rate-limit slots stay counted**: the limiter can only be too strict, never too loose.
- **Ethereal only.** Senders are Ethereal test mailboxes provisioned automatically; adding
  your own SMTP account isn't supported.
- **Backend features without UI** (no UI yet): adding more senders, per-sender usage.
- **Search is eventually consistent** with Postgres (index jobs run right after each change).
- **HTTP rate limiting** (`express-rate-limit`) is per API process: 300 req/min per IP overall,
  10/min for scheduling a campaign (each call can create thousands of jobs), 30/min on the
  guessable auth endpoints (login, sign-up, password, Google OAuth; reading the
  session is not included, so page loads can't lock a user out). The brute-force limits that
  matter are in Redis and shared.

## Project structure

```
docker-compose.yml         Postgres 16, Redis 7 (AOF, noeviction), Elasticsearch 8
demo/                      sample lead lists (5 messy rows, 200 leads)
backend/
  src/server.ts            API entry (migrations → listen → ensure search index)
  src/worker.ts            worker entry (reconcile → start queues; graceful shutdown)
  src/app.ts               Express app: security middleware, routes, Bull Board, errors
  src/workers/             email / search-index / Slack-notification processors
  src/scheduler/           planner (send times) + rateLimiter (Lua: slots, gate, cooldown)
  src/recovery/            boot reconciliation
  src/modules/             auth, emails, senders, attachments, search, slack
  src/db/                  Drizzle schema + migration runner;  drizzle/  SQL migrations
  scripts/                 migrate, seed-demo, reindex, load-test, cleanup-test-leftovers, slack-preview
  test/                    node:test suites (+ test/e2e: real Ethereal delivery)
frontend/
  e2e/                     browser end-to-end suites (npm run e2e) + design check tools
  src/pages/               Login, Sign up, Dashboard, Email detail, Compose
  src/components/          ui (Button, IconButton, Modal), dashboard, compose (editor, recipients, attachments), email, account
  src/lib/                 API client, auth + email hooks (TanStack Query), formatting
```
