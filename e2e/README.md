# ClinicalMinds E2E (Playwright)

One suite, three targets:

| Project / tag | Target | Needs |
|---|---|---|
| `api` | backend FastAPI (`API_URL`, default `http://localhost:8000`) | backend running + demo data seeded |
| `web` | frontend (`WEB_URL`, default `http://localhost:3000`) | frontend running; authenticated specs also need the backend |
| `@deid` (inside `api`) | de-identification service (`DEID_URL`, default `http://localhost:8002`) | service running |

Specs **skip with a reason** when their service is unreachable, so `npx playwright test` is always
safe to run; a skipped spec is not a pass — look at the summary line printed by global setup:

```
[e2e] api=up (http://localhost:8000)  web=up (http://localhost:3000)  deid=DOWN (http://localhost:8002)  auth=ok
```

## Setup

```bash
cd e2e
npm install
npx playwright install chromium
cp .env.example .env          # adjust URLs / credentials if needed
```

Bring up the stack (see each component's `CLAUDE.md`):

```bash
# backend
cd ../backend && docker compose up -d postgres chromadb && python main.py
python scripts/setup_demo_data.py        # with the server up: onboards demo@clinicalmind.com / Password123! (ADMIN)
                                         # (POSTs /api/v1/onboarding/complete — the only path that writes both DB layers)
# frontend
cd ../frontend && npm install && npm run dev
# de-identification (optional)
cd ../deidentification-service/backend && uvicorn app.main:app --port 8002
```

## Run

```bash
npm test                      # everything
npm run test:api              # backend API only
npm run test:web              # browser UI only
npm run test:deid             # de-identification service only
npm run test:headed           # watch the browser
npm run report                # open the last HTML report
npm run type-check            # tsc over the suite
npx playwright test api/patients.spec.ts -g "create"   # one spec / one test
```

## How auth works

`global-setup.ts` logs in through `POST /api/v1/auth/login` with `E2E_EMAIL`/`E2E_PASSWORD` and:

- exports `E2E_TOKEN`, `E2E_TENANT_ID`, `E2E_USER` for the `api` fixture (adds
  `Authorization: Bearer …` and `X-Tenant-ID`, exactly like the frontend's Axios client);
- writes `.auth/state.json` seeding `localStorage` with `auth_token`, `auth_user`, `tenant_id` for
  the `web` project — the same keys `frontend/src/context/AuthContext.tsx` rehydrates from.

Specs that must start logged out (`web/auth.spec.ts`, `web/guards.spec.ts`,
`web/portal-onboarding.spec.ts`) override `storageState` to empty.

## Layout

```
playwright.config.ts   projects api / web, dotenv, reporters
global-setup.ts        service probes + API login + storage state
src/env.ts             URLs, credentials, reachable(), uniq()
src/fixtures.ts        test/expect + fixtures: api (authed), anon, auth; require*() skip helpers
src/pages/             page objects (login, dashboard nav + headings, add-patient form)
api/                   health, auth, security (guards, tenant isolation, permissions), patients, sessions,
                       kanban, teams, crisis, tenants (+analytics/schedules/catalog), otp-onboarding, deid
web/                   auth, guards, navigation, patients, sessions, tasks-teams, misc-pages, portal-onboarding
```

Specs create their own data with unique names (`uniq()`) and clean up in `finally` blocks.

## Known defects (marked `test.fixme(reason)`, listed in the report, never red)

A fixme **is** the regression test for the fix: remove the line when you fix the defect and the test
runs for real. Live status on 2026-10-28: 101 passed, 9 fixme, 5 skipped (de-id service not started).

| Spec | Reason |
|---|---|
| `api/auth.spec.ts` refresh-token | backend reads `current_user["id"]`; JWT key is `user_id` |
| `api/auth.spec.ts` register | `auth.register` returns placeholder ids, never writes to DB (real signup is `/onboarding/complete`) |
| `api/crisis.spec.ts` assess | `crisis_detector` dependency is `lambda: None` |
| `api/crisis.spec.ts` unknown event id | crisis event endpoints return hard-coded mock data; any id "exists" |
| `api/otp-onboarding.spec.ts` generate | needs SMTP credentials |
| `api/security.spec.ts` permissions ×2 | `permissions.py` is unfinished and deliberately not mounted |
| `api/tenants.spec.ts` usage/billing | `TenantUsage` model has no `tenant_id` column |

Two Playwright processes must not share `test-results/` (you get `ENOENT … trace` errors, not real
failures). For a second concurrent run set `PW_OUTPUT_DIR=/tmp/pw-out PW_REPORT_DIR=/tmp/pw-report`.
Also note that restarting the backend mid-run turns every request into a 401 and fails the UI specs.

## Adding tests

- API: new file under `api/`, import `{ test, expect, requireApi, requireAuth } from '../src/fixtures'`,
  call `requireApi(); requireAuth();` at the top of the `describe`. Use the `api` fixture.
- Web: new file under `web/`; `requireWeb(); requireAuth();` for logged-in pages. Prefer
  `getByRole`/`getByLabel`; the frontend has no `data-testid`s yet — add them to new interactive
  elements rather than relying on text.
- Note: the monorepo root `.gitignore` ignores `package-lock.json`; pin versions in `package.json`.
