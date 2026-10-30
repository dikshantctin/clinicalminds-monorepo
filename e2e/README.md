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
cd ../backend && docker compose up -d postgres && python main.py
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
src/outbox.ts          reads the backend's dev email outbox (EMAIL_OUTBOX_DIR in backend/.env): invite links
src/pages/             page objects (login, dashboard nav + headings, add-patient form)
api/                   health, auth, security (guards, tenant isolation, permissions),
                       role-access (table: route × role → exact 401/403/200; PATIENT needs a seeded
                       patient.demo@democlinic.com login), patient-portal (invite → set password → portal
                       login; the login audience picks staff vs PATIENT; an invite never overwrites a password),
                       patients, sessions (offsets, paging, filters, edit),
                       schedules (daily schedule in the clinic time zone), clinic-timezone (a New York clinic: slots,
                       booking, overview week/month, schedule stats + availability in its zone; Kolkata unchanged),
                       kanban, teams, tenants (+branding/schedules/catalog), overview (the dashboard's four
                       live numbers), otp-onboarding,
                       verification (phone.email endpoints + the 403 verification_required gate),
                       booking (public self-booking: info, slots, booking → clinic + therapist lists, 409/400),
                       payments (the clinic's own Razorpay keys, read from the demo DB: role gate, 422/400 validation,
                       secret never returned; once the demo clinic is connected: Rs 1 booking → order on the clinic's
                       account, slot held, "pending" on the session, forged signature → 400, free service → no payment,
                       signed payment.captured / refund.processed webhooks → paid / refunded, bad signature → 400),
                       overview also covers: no-show via POST …/no-show (status is not a PUT field), the 24 h stale
                       sweep, desk payments → revenue, clinician scope (logs in as the seeded psychologist, skips if
                       that login is blocked); sessions covers cancel/no-show guards and the clinician risk flag → queue,
                       followups (missed session → card, idempotent sync, closed cards stay closed), deid
web/                   auth, guards, navigation, patients, sessions, tasks-teams, misc-pages, portal-onboarding, portal-login (/portal/login → /portal; each login refuses the other kind of account),
                       verification (/auth/verify gate for the seeded unverified intern; Settings badges),
                       booking (/book/<firmCode> end to end with a free service and a test-listed phone; "Booked online" badge),
                       payments (admin sees the connected clinic's key id + masked hint in Settings → Payments, secret
                       never on the page; a Rs 1 booking reaches the pay step and Razorpay Checkout's iframe mounts),
                       sessions also: mark no-show from the list, record a cash payment, save a risk flag on the detail page,
                       journey (serial, browser-only clinic day: admin publishes a service, registers a patient,
                       schedules a session → patient books online → therapist starts it → missed session shows on
                       the Follow-up queue; the one API shortcut moves a session into the past)
```

Specs create their own data with unique names (`uniq()`) and clean up in `finally` blocks.

## Payments (Razorpay test mode)

Each clinic connects its **own** Razorpay account; the keys live in the **database** per tenant, not in
this suite's config. So you connect the demo clinic **once** and every run picks it up — nothing goes in
`e2e/.env`. The backend must run with `PAYMENTS_ENABLED=true` and a `PAYMENTS_ENCRYPTION_KEY`.

Connect the demo clinic (either way):

```bash
# from the backend, with the server running (test-mode keys from the Razorpay dashboard):
cd ../backend && python scripts/connect_demo_razorpay.py rzp_test_xxxxx <key_secret>
# …or in the app: log in as the demo admin → Settings → Payments → enter the keys → Connect.
```

The payment specs read the stored account (only the **public** key id; never the secret) and **skip with a
reason** until it is connected. The webhook spec stores a fixed e2e webhook secret on the demo clinic's
gateway (through `PUT /payments/config`) and signs its own deliveries with it; no public URL is needed. `E2E_RAZORPAY_*` is optional and only drives the extra "validate a fresh
pair" write test.

The actual payment cannot be automated (Razorpay Checkout is a vendor iframe), so to prove a real Rs 1 charge:

1. Give a service price `1`, open `/book/<firm_code>` (or `npx playwright test web/payments.spec.ts --headed`,
   which stops with Checkout open).
2. Pay with the UPI id `success@razorpay` or card `4111 1111 1111 1111` (any future expiry, any CVV).
3. The confirmation shows "Paid ₹1", Sessions shows the "Paid ₹1" badge, and the payment appears in the
   Razorpay test dashboard under the clinic's account.

Specs that book through the browser (`web/booking.spec.ts`, `web/journey.spec.ts`) use **free** services so
they never reach the pay step.

## Known defects (marked `test.fixme(reason)`, listed in the report, never red)

A fixme **is** the regression test for the fix: remove the line when you fix the defect and the test
runs for real. Live status on 2026-10-28: 101 passed, 9 fixme, 5 skipped (de-id service not started).

| Spec | Reason |
|---|---|
| `api/auth.spec.ts` register | `auth.register` returns placeholder ids, never writes to DB (real signup is `/onboarding/complete`) |
| `api/otp-onboarding.spec.ts` generate | needs SMTP credentials |
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
