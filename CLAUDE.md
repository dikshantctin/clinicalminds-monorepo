# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ClinicalMinds is a multi-tenant AI-powered mental health platform. This repository is a **monorepo
of git submodules**; each component is its own repo with its own `CLAUDE.md` — read the one for the
area you are changing, it holds the verified details (routes, models, defects, test commands):

| Path | Repo | What | Docs |
|---|---|---|---|
| `backend/` | `dikshantctin/clinicalminds-backend` | FastAPI + PostgreSQL (database-per-tenant), JWT auth, self-booking + per-clinic payments, follow-up queue | `backend/CLAUDE.md` |
| `frontend/` | `dikshantctin/clinicalminds-frontend` | React 18 / TypeScript / Vite / Tailwind | `frontend/CLAUDE.md` |
| `deidentification-service/` | `dikshantctin/clinicalminds-deidentification` | HIPAA PHI de-identification microservice (:8002) | `deidentification-service/CLAUDE.md` |
| `e2e/` | (this repo) | Playwright suite for backend API, frontend UI and de-id service | `e2e/README.md` |

## Working with the submodules

```bash
git submodule update --init --recursive        # populate empty backend/ frontend/ deidentification-service/
git submodule foreach 'git checkout main && git pull'   # track latest main in each
git -C backend status                           # work inside a submodule like a normal repo
```

- Submodules check out **detached** at the pinned commit; `git -C <dir> checkout main` before committing.
- Commit inside the submodule and push it **first**, then `git add <dir>` in the monorepo and commit
  the new pointer. A monorepo commit that points at an unpushed submodule commit is broken for everyone else.

## Essential Commands

### Backend (`backend/`)
```bash
docker compose up -d postgres                 # Postgres 16+pgvector :5432 (Redis :6379 not in compose)
pip install -r requirements.txt && cp .env.example .env
python main.py                                # :8000  (uvicorn main:app --reload)
python scripts/setup_demo_data.py             # with the server UP: onboards the demo org — demo@clinicalmind.com / Password123! (ADMIN)
python scripts/demo_data.py import scripts/fixtures/demo_clinic.json   # real demo rows (patients/sessions/payments), dates re-based onto today
black . --line-length 100 && ruff check . && mypy app/
alembic revision --autogenerate -m "description" && alembic upgrade head
```

### Frontend (`frontend/`)
```bash
npm install && npm run dev                    # :3000
npm run build && npm run lint && npm run type-check
```

### De-identification Service (`deidentification-service/`)
```bash
cd backend && uvicorn app.main:app --reload --port 8002
cd backend && pytest tests/                   # unit + API tests (has its own suite)
./quick_build.sh --quick && docker compose -f docker-compose.minimal.yml up
```

### End-to-end tests (`e2e/`)
```bash
cd e2e && npm install && npx playwright install chromium
cp .env.example .env                          # API_URL, WEB_URL, DEID_URL, E2E_EMAIL, E2E_PASSWORD
npx playwright test                           # all; specs skip (with reason) for any service not reachable
npx playwright test --project=api             # backend API only
npx playwright test --project=web             # browser UI only
npx playwright test --grep @deid              # de-identification service
npx playwright show-report
```

## Architecture Overview

### Multi-Tenant Architecture
Two database layers coexist (see `backend/CLAUDE.md` → Architecture for the verified detail):
**identity** (login, `/auth/me`, onboarding, OTP) lives in the platform database
`clinical_mind_platform` managed by `MultiTenantDatabaseManager`; **all tenant data** (patients,
sessions, kanban, teams, schedules, tenants, catalog, analytics) lives in the `DATABASE_URL` database
through the older `DatabaseManager` (schema-per-tenant via `search_path`, rows scoped by `tenant_id`).
The per-tenant `clinical_mind_tenant_*` databases are created at onboarding but nothing reads them yet.
Onboarding writes users to both layers with the same user id.

**Key points:**
- Identity and tenant come from the JWT (`user_id`, `email`, `role`, `tenant_id`) via FastAPI
  dependencies (`get_current_user`, `get_tenant_context`, `get_app_context`) — never from request bodies.
- Middleware rejects non-public routes without a bearer token (401). Tenant falls back to
  `X-Tenant-ID`, then (development only) a default tenant.
- Roles: Admin, Clinical Director, Psychologist, Therapist, Intern, Support Staff, Patient.
  Both sides use UPPER_CASE (`ADMIN`, `CLINICAL_DIRECTOR`, …) — never compare to lowercase literals.
- Frontend stores `auth_token`, `auth_user`, `tenant_id` in `localStorage` and sends
  `Authorization: Bearer` + `X-Tenant-ID` on every request.

### Backend Structure (`backend/`)
```
app/
├── api/v1/              # Routers: auth, otp, onboarding, verification, public_booking, patients, sessions,
│                        #   schedules, analytics (GET overview only), tenants, catalog, teams, kanban, payments
├── core/multi_database_manager.py  # database-per-tenant
├── models/              # platform.py (platform DB), database.py (legacy + tenant), kanban/team/appointment/audit models
├── schemas/             # Pydantic models (kanban, team, tenant, onboarding, permissions, appointment)
├── services/            # Business logic
├── middleware/          # auth_middleware (PUBLIC_ENDPOINTS), audit, monitoring
├── dependencies/        # get_app_context etc.
└── config/settings.py
```

### Frontend Structure (`frontend/`)
```
src/
├── App.tsx              # All routes + RoleGuard role lists
├── config/navigation.ts # Sidebar items + roles
├── pages/               # auth, onboarding (8-step wizard), dashboard, patients, sessions, tasks (kanban), teams, settings, portal, booking
├── components/          # admin, auth (ProtectedRoute, RoleGuard), booking, common, dashboard, debug, layout, notifications, settings
├── services/api.ts      # Axios client + AuthAPI/PatientAPI/SessionAPI/OverviewAPI/TenantAPI/PublicBookingAPI/PaymentsAPI
├── context/             # AuthContext, TenantContext, ThemeContext
└── hooks/
```

### Key Features
- **Dashboard**: four live numbers from `GET /analytics/overview` (sessions this week, no-shows, revenue collected
  this month, patients needing follow-up). There is no AI assistant, crisis page or analytics page
  (mock-data facades were removed). Planned AI = a note-drafting scribe behind de-identification.
- **Self-booking**: public `/book/<firm_code>` page; a booking is a `therapy_session` (`booked_via="web"`),
  so it appears on the clinic's and the therapist's schedules. Patient phone proven via phone.email.
- **Payments**: each clinic connects its **own** Razorpay account (Settings → Payments; secret encrypted at rest);
  priced services are paid at booking time into the clinic's account with a 15-minute slot hold. The platform
  holds no merchant keys; `PAYMENTS_ENABLED` + `PAYMENTS_ENCRYPTION_KEY` in `backend/.env` switch it on.
  `.env` files are git-ignored; `.env.example` is the template.
- **Kanban + clinical follow-up queue**: boards/tasks/comments/notifications, team assignment, dnd-kit UI;
  the "Follow-up queue" board is generated from sessions and risk flags (missed session, risk flag,
  no first session, inactive 30+ days) by `POST /kanban/followups/sync`.
- **Onboarding + verification**: public business registration (`/onboarding/*`); admin email and phone are
  verified through the phone.email widget (`/verification/*`, hard gate: 403 `verification_required` for
  unverified users; demo/test identities are allow-listed in `VERIFICATION_TEST_*`). The SMTP OTP (`/otp/*`) is unused.
- **Compliance**: DPDP Act 2023, audit logging, crisis escalation, tenant isolation, de-identification before external AI calls.

## Patterns

### Backend endpoint
```python
@router.post("/", response_model=PatientResponse)
async def create_patient(
    payload: PatientCreate,
    current_user: Dict[str, Any] = Depends(get_current_user),
    tenant: Dict[str, Any] = Depends(get_tenant_context),
):
    ...
```

### Frontend data
```typescript
const { data, isLoading } = useQuery(['patients'], PatientAPI.getPatients);   // react-query v3
const mutation = useMutation(PatientAPI.updatePatient, {
  onSuccess: () => queryClient.invalidateQueries(['patients']),
});
```

### Forms: React Hook Form + Zod (`zodResolver`).

## Important Considerations

1. **Healthcare Compliance**: patient data security and DPDP Act 2023. Never log PHI, tokens, passwords,
   invite/reset links or API secrets — backend loggers and frontend `console.*` alike. Never return exception
   text to clients (`detail=str(e)`): log the exception type server-side, answer with a fixed message.
2. **Multi-tenant Isolation**: never allow cross-tenant data access; tenant comes from the JWT.
3. **No invented numbers**: every figure a clinic sees must come from its own rows (see `demo_data.py` for demos).
4. **Professional UI**: healthcare-grade appearance, WCAG 2.1 AA.
5. **Known defects** are listed per component in each `CLAUDE.md` (e.g. backend `register`/`refresh-token`
   stubs, orphaned frontend jest tests, de-id frontend lacks `package.json`). Check before building on an endpoint.

## Common Tasks

### Adding a New API Endpoint
1. Route in `backend/app/api/v1/` (register in `api/v1/__init__.py`), models in `app/schemas/`.
2. Identity/tenant via dependencies; add permission checks.
3. Client method in `frontend/src/services/api.ts`.
4. Spec in `e2e/api/`; row in the API table of `backend/CLAUDE.md`.

### Adding a Page
1. Page in `frontend/src/pages/`, route + `RoleGuard` in `App.tsx`, sidebar entry in `config/navigation.ts`.
2. Add `data-testid`s to interactive elements; spec in `e2e/web/`.

### Adding Database Models
1. Tenant data → tenant DB models; platform data → `models/platform.py`.
2. UUID PKs, `created_at`/`updated_at`/`is_active`; Alembic migration; tenant-aware indexes.

## Definition of done

Each submodule has `make check` (backend: ruff + mypy + pytest; frontend: lint + type-check + build);
the root `Makefile` runs both (`make check`) and the Playwright suite (`make e2e`). Nothing is "done"
until you have run `make check` in every submodule you touched **and** the relevant Playwright specs
(`cd e2e && npx playwright test <spec>`) against a running stack, and read the output. A skipped spec is not a pass.

## Reuse before adding

Before adding a column, table, migration, setting, endpoint, helper or script, prove it doesn't already exist:
- grep the models, schemas, `alembic/versions/`, `config/settings.py`, `app/services/` and `scripts/`;
- check the **live** databases (`clinical_mind_platform` and the `DATABASE_URL` one) via `information_schema.columns`,
  since they can hold columns the models don't declare;
- check JSONB columns (e.g. `platform_firms.settings`) for existing keys, and prefer a JSONB key over a new column
  when the value needs no index, constraint or join.

State what was checked and found in the plan. Extend what exists; add new schema only when nothing fits.

## Tests with every feature

Any feature or bugfix that changes user-visible behavior or an API contract ships with a Playwright spec in
`e2e/api/` or `e2e/web/`, written **first** (it fails, then the change makes it pass):
- exact asserts: one status (`toBe(403)`), exact body fields — never "200 or 422";
- at least one negative case (wrong role → 403, no token → 401, bad input → 422, foreign tenant → 403);
- `data-testid` selectors for anything the UI spec clicks or reads;
- no `test.skip` that hides a failure — skips are only for an unreachable service; a known, unfixed defect is
  a `test.fixme(reason)` listed in `e2e/README.md`, removed by the fix.

## Git workflow

- One branch + PR per change; never commit straight to `main`. Small, focused commits.
- Submodules: commit and push the submodule branch **first**, then commit the new pointer in the monorepo.
- Several Claude sessions may share one checkout. Do your work in a `git worktree`, check
  `git branch --show-current` right before committing, and push with an explicit refspec
  (`git push origin HEAD:<branch>`). A session switching the shared checkout's branch once sent a commit to the wrong branch.

## CI/CD

There is CI only, no deployment pipeline. Three GitHub Actions workflows:

| Repo | Workflow | Trigger | Runs |
|---|---|---|---|
| `backend` | `.github/workflows/ci.yml` | push to `main`, PR | Postgres service → `create_all` via `import main` → `make check` (ruff, mypy, pytest) |
| `frontend` | `.github/workflows/ci.yml` | push to `main`, PR | `npm ci` → `make check` (lint, build — `build` runs `tsc`) |
| monorepo | `.github/workflows/e2e.yml` | PR, push to `main` (both skip Markdown-only changes), manual | checkout with submodules → Postgres → backend on :8000 (`create_all`, `alembic stamp head`) → `setup_demo_data.py` + `demo_data.py import` → Vite on :3000 → `playwright test --project=api --project=web` (de-id specs skip); report uploaded as an artifact |

Merge order for a change spanning repos: backend PR (green) → frontend PR (green) → monorepo PR that bumps the
submodule pointers (its e2e runs against exactly those commits). A pointer must name a commit on the submodule's
`main` after merge (merge with a merge commit, not squash, or the pinned commit is orphaned).

Rules learned the hard way:
- **CI starts from an empty database.** Tests create every row they need (users included) and clean up after
  themselves; never read "some existing user" from the dev DB.
- **Every import must be in `requirements.txt` / `package.json`.** The local venv / `node_modules` hides missing
  dependencies; CI does not (`aiohttp` was missing).
- **A new required `Settings` field must be added to both** `backend/.github/workflows/ci.yml` (`env:`) and the
  `.env` heredoc in `e2e.yml`, or the backend fails to start in CI.
- **Secret `SUBMODULES_TOKEN`** (monorepo → Settings → Secrets → Actions) lets `e2e.yml` clone the private
  submodules. Use a **classic** PAT with the `repo` scope; the fine-grained token kept getting 403. Set it with
  `gh secret set SUBMODULES_TOKEN -R dikshantctin/clinicalminds-monorepo` (value only, no `NAME=` prefix).
  Checkout 403 on the submodules = token lacks access; `could not read Username` = the secret holds a revoked token.
- Read failures with `gh run view <id> -R dikshantctin/<repo> --log-failed`; re-run with `gh run rerun <id>`.
- Known flaky e2e specs (shared demo data, parallel workers): `api/patients.spec.ts` stats-vs-list totals and
  `api/payments.spec.ts` slot hold. A failure there is re-run once, not "fixed" by loosening asserts.
