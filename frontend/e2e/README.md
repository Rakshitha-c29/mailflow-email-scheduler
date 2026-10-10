# Browser end-to-end tests

Real Chrome driving the real app: the Vite frontend, the API, the worker, and the docker
services, with nothing mocked unless a state can't be produced locally (noted in each
suite). They complement the backend's `npm test` (API/worker logic) by checking what a
user actually sees and does.

## Run

Prerequisites: the app running as in the main README's Setup (`docker compose up -d`, backend
`npm run dev` + `npm run dev:worker`, frontend `npm run dev`), the demo account
(`cd backend && npm run seed:demo`), and Google Chrome installed (or `CHROME_PATH=/path/to/chrome`).

```bash
cd frontend
npm run e2e                      # all suites, then re-seeds the demo account
npm run e2e -- compose detail    # just these suites
npm run e2e -- --no-reseed       # leave the data the suites created
```

Screenshots of key states are written to `e2e/screenshots/` (git-ignored). Settings:
`E2E_BASE_URL` (default `http://localhost:5173`), `E2E_ES_URL` (default `http://localhost:9200`).

## Suites

| Suite | Covers |
|---|---|
| `auth` | Sign-up validation (live), loading state, duplicate email, login with a wrong password (generic error) and with the right one, session surviving a reload, the Google OAuth error toast, per-email login rate limit (429 toast). |
| `dashboard` | Scheduled/Sent tabs with live counts, the time pill format, star (persisted), Elasticsearch search, status filter kept in the URL, phone layout and drawer, log out. |
| `detail` | Email detail from the list, HTML sanitizing (a planted `<script>`, `onerror` and `javascript:` link must not survive), details and history, star, back navigation, cancel with confirmation, not-found. |
| `compose` | Every editor toolbar button (checked against the produced HTML), recipient chips (paste, duplicates, invalid, "+N"), **Upload List** with messy CSV/TSV/TXT files, attachments (allowed and rejected), Send Later, the discard guard, a real send through the worker, and attachment cards in the sent email. Also checks the phone layout. |
| `account` | User menu: Slack (not configured / connect / revoked / connected with a real local webhook: test message, **live rate-limit alert**, disconnect), the `?slack=` redirect toasts, change password (mismatch, wrong current, success), the Google re-auth path, `/me` errors not logging the user out, and **Send again** for an UNCERTAIN email (new id, original untouched, idempotent, delivered by the worker). |

`lib.cjs` holds the shared helpers (Chrome launch, SQL and Redis access through docker, a
close sequence that can't hang), and `run.cjs` is the runner.

## Design check tools (`e2e/design/`)

Used to match the UI to the design exports. Each takes a PNG and prints or writes results:

| Tool | What it does |
|---|---|
| `colors.cjs` | Exact colours at given points |
| `scan.cjs` | Runs of colour along a line: borders, sizes and positions |
| `zoom.cjs` | Pixel-perfect enlargement of a region |
| `compare.cjs` | The design (cropped to its frame, scaled to 1440 px) stacked over a screenshot |
