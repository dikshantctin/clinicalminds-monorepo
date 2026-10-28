# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ClinicalMinds is a multi-tenant AI-powered mental health platform. This repository is a **monorepo
of git submodules**; each component is its own repo with its own `CLAUDE.md` — read the one for the
area you are changing, it holds the verified details (routes, models, defects, test commands):

| Path | Repo | What | Docs |
|---|---|---|---|
| `backend/` | `dikshantctin/clinicalminds-backend` | FastAPI + PostgreSQL (database-per-tenant), JWT auth, AI routing, crisis detection | `backend/CLAUDE.md` |
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
- All three `main` branches carry the kanban / OTP / onboarding work (merged 2026-10-28).

## Essential Commands

### Backend (`backend/`)
```bash
docker compose up -d postgres chromadb        # Postgres 16+pgvector :5432, ChromaDB :8001 (Redis :6379 not in compose)
pip install -r requirements.txt && cp .env.example .env
python main.py                                # :8000  (uvicorn main:app --reload)
python scripts/setup_demo_data.py             # with the server UP: onboards the demo org — demo@clinicalmind.com / Password123! (ADMIN)
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
├── api/v1/              # Routers: auth, otp, onboarding, patients, sessions, schedules, crisis, analytics,
│                        #   tenants, catalog, availability, booking, appointments, teams, kanban, permissions
├── core/ai/             # model_router (Claude 3.5 via legacy completions API — needs migration), crisis_detection (sklearn)
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
├── pages/               # auth, onboarding (8-step wizard), dashboard, patients, sessions, tasks (kanban), teams, ai, crisis, analytics, settings, portal
├── components/          # admin, ai, auth (ProtectedRoute, RoleGuard), booking, common, dashboard, debug, layout, notifications
├── services/api.ts      # Axios client + AuthAPI/PatientAPI/SessionAPI/AIAPI/CrisisAPI/AnalyticsAPI
├── context/             # AuthContext, TenantContext, ThemeContext
└── hooks/
```

### Key Features
- **AI**: routing between Claude 3.5 Sonnet and GPT-4o-mini; crisis detection (multi-layer); per-tenant cost tracking.
- **Kanban**: boards/tasks/comments/notifications, team assignment, dnd-kit UI, role permissions.
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

1. **Healthcare Compliance**: patient data security and DPDP Act 2023. Never log PHI.
2. **Multi-tenant Isolation**: never allow cross-tenant data access; tenant comes from the JWT.
3. **Crisis Management**: critical path — test thoroughly.
4. **Professional UI**: healthcare-grade appearance, WCAG 2.1 AA.
5. **AI Cost Tracking**: usage drives tenant billing.
6. **Known defects** are listed per component in each `CLAUDE.md` (e.g. backend `register`/`refresh-token`
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

<!-- code-review-graph MCP tools -->
## MCP Tools: code-review-graph

**IMPORTANT: This project has a knowledge graph. ALWAYS use the
code-review-graph MCP tools BEFORE using Grep/Glob/Read to explore
the codebase.** The graph is faster, cheaper (fewer tokens), and gives
you structural context (callers, dependents, test coverage) that file
scanning cannot.

### When to use graph tools FIRST

- **Exploring code**: `semantic_search_nodes` or `query_graph` instead of Grep
- **Understanding impact**: `get_impact_radius` instead of manually tracing imports
- **Code review**: `detect_changes` + `get_review_context` instead of reading entire files
- **Finding relationships**: `query_graph` with callers_of/callees_of/imports_of/tests_for
- **Architecture questions**: `get_architecture_overview` + `list_communities`

Fall back to Grep/Glob/Read **only** when the graph doesn't cover what you need.

### Key Tools

| Tool | Use when |
|------|----------|
| `detect_changes` | Reviewing code changes — gives risk-scored analysis |
| `get_review_context` | Need source snippets for review — token-efficient |
| `get_impact_radius` | Understanding blast radius of a change |
| `get_affected_flows` | Finding which execution paths are impacted |
| `query_graph` | Tracing callers, callees, imports, tests, dependencies |
| `semantic_search_nodes` | Finding functions/classes by name or keyword |
| `get_architecture_overview` | Understanding high-level codebase structure |
| `refactor_tool` | Planning renames, finding dead code |

### Workflow

1. The graph auto-updates on file changes (via hooks).
2. Use `detect_changes` for code review.
3. Use `get_affected_flows` to understand impact.
4. Use `query_graph` pattern="tests_for" to check coverage.
