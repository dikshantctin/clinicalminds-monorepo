# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ClinicalMinds is a multi-tenant AI-powered mental health platform with three main components:
- **Backend**: FastAPI-based API server with PostgreSQL, AI integration (Claude 3.5, GPT-4), and multi-tenant architecture
- **Frontend**: React/TypeScript application with Vite, Tailwind CSS, and healthcare-grade UI
- **De-identification Service**: HIPAA-compliant microservice for clinical data de-identification

## Essential Commands

### Backend Development
```bash
cd backend

# Run development server
python main.py
# or
uvicorn main:app --host 0.0.0.0 --port 8000 --reload

# Code quality checks
black . --line-length 100 && ruff check . && mypy app/

# Database operations
alembic revision --autogenerate -m "description"
alembic upgrade head

# Load demo data
python scripts/create_demo_data_working.py

# Run tests
pytest
pytest --cov=app
```

### Frontend Development
```bash
cd frontend

# Development
npm run dev              # Start dev server on http://localhost:3000

# Build & Production
npm run build           # TypeScript check + Vite production build
npm run preview         # Preview production build

# Code Quality
npm run lint            # ESLint with TypeScript rules
npm run type-check      # TypeScript type checking
```

### De-identification Service
```bash
cd deidentification-service

# Backend
cd backend
uvicorn app.main:app --reload --port 8002

# Frontend
cd frontend
npm install && npm start

# Docker (minimal setup)
./quick_build.sh --quick
docker compose -f docker-compose.minimal.yml up
```

## Architecture Overview

### Multi-Tenant Architecture
The platform uses **schema-based isolation** where each tenant (organization) gets a separate PostgreSQL schema. All database operations are automatically scoped to the tenant context.

**Key Components:**
- `TenantBase`: Base class for tenant-scoped models (always use this for tenant data)
- `Base`: For public schema models (Tenant, User)
- Tenant context middleware automatically sets the tenant scope
- Role-based access control: Admin, Clinical Director, Psychologist, Therapist, Intern

### Backend Structure (`backend/`)
```
app/
├── api/v1/              # API endpoints (auth, patients, sessions, kanban, teams)
├── core/
│   ├── ai/              # AI services (model_router, crisis_detection)
│   └── security/        # Authentication and authorization
├── models/              # Database models with multi-tenant support
├── middleware/          # Tenant context, auth, audit, monitoring
├── services/            # Business logic layer
├── schemas/             # Pydantic models for API validation
└── config/              # Application settings
```

### Frontend Structure (`frontend/`)
```
src/
├── components/          # Reusable UI components
│   ├── ai/             # AI assistant components
│   ├── auth/           # Authentication components
│   ├── crisis/         # Crisis management UI
│   ├── dashboard/      # Dashboard widgets
│   ├── kanban/         # Task management board
│   └── patients/       # Patient management
├── pages/              # Page components
├── services/           # API client and services
├── context/            # React context providers (Auth, Tenant, Theme)
└── hooks/              # Custom React hooks
```

### Key Features

**AI Integration:**
- Intelligent routing between Claude 3.5 Sonnet and GPT-4O
- Crisis detection with multi-layer assessment
- Cost tracking per tenant for billing
- Context-aware responses based on session type

**Kanban Task Management:**
- Team-based task assignment
- Drag-and-drop interface with real-time updates
- Role-based permissions for task management
- Notifications and activity tracking

**Healthcare Compliance:**
- DPDP Act 2023 compliance (Indian data protection)
- Audit logging for all clinical operations
- Crisis escalation protocols
- Patient data isolation per tenant

## Database Patterns

### Always Include Tenant Context
```python
# Backend example
async def get_patients(tenant_id: UUID, db: AsyncSession):
    return await db.execute(
        select(Patient).where(Patient.tenant_id == tenant_id)
    )
```

### Use Proper Model Base Classes
```python
# Tenant-scoped model
class Patient(TenantBase):
    __tablename__ = "patients"
    # Fields...

# Public model (no tenant scope)
class User(Base):
    __tablename__ = "users"
    # Fields...
```

## API Patterns

### Authentication & Permissions
```python
from app.utils.auth import require_permission

@router.get("/patients")
@require_permission("view_patients")
async def get_patients(current_user: User = Depends(get_current_user)):
    # Implementation
```

### AI Model Usage
```python
# Use the model router for intelligent AI routing
response = await model_router.generate_response(
    query=query,
    context={"session_type": "therapy", "patient_id": patient_id}
)
```

## Frontend Patterns

### API Integration with React Query
```typescript
// Data fetching with caching
const { data, isLoading, error } = useQuery(['patients'], PatientAPI.getPatients);

// Mutations with optimistic updates
const mutation = useMutation(PatientAPI.updatePatient, {
  onSuccess: () => queryClient.invalidateQueries(['patients'])
});
```

### Form Handling with React Hook Form + Zod
```typescript
const schema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email()
});

const { register, handleSubmit, formState: { errors } } = useForm({
  resolver: zodResolver(schema)
});
```

### Path Aliases
TypeScript and Vite are configured with these aliases:
- `@/` → `src/`
- `@components/` → `src/components/`
- `@services/` → `src/services/`
- `@hooks/` → `src/hooks/`
- `@context/` → `src/context/`

## Environment Variables

### Backend (.env)
- Database: `DATABASE_URL`, `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`
- AI APIs: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`
- Security: `SECRET_KEY`, `JWT_SECRET_KEY`
- Email: `EMAIL_HOST`, `EMAIL_PORT`, `EMAIL_USERNAME`, `EMAIL_PASSWORD`

### Frontend (.env)
- `VITE_API_URL` - Backend API URL (defaults to `http://localhost:8000`)

## Testing

### Backend Testing
```bash
pytest tests/                     # Run all tests
pytest tests/test_multi_tenant.py # Run specific test
pytest --cov=app                  # With coverage
```

### Frontend Testing
Currently no test framework configured. When adding tests, use React Testing Library with Vitest.

## Important Considerations

1. **Healthcare Compliance**: This is a healthcare application. Ensure patient data security and DPDP Act 2023 compliance.
2. **Multi-tenant Isolation**: Always consider tenant context when making changes. Never allow cross-tenant data access.
3. **Crisis Management**: Crisis detection features are critical - handle with care and test thoroughly.
4. **Professional UI**: Maintain healthcare-grade professional appearance with appropriate clinical colors.
5. **AI Cost Tracking**: Monitor AI usage as it directly impacts billing for tenants.

## Common Tasks

### Adding a New API Endpoint
1. Create route in `backend/app/api/v1/`
2. Add Pydantic schemas in `backend/app/schemas/`
3. Include tenant context and permissions
4. Add corresponding API client in `frontend/src/services/api.ts`

### Adding Database Models
1. Inherit from `TenantBase` for tenant-scoped data
2. Include standard fields (`created_at`, `updated_at`, `is_active`)
3. Create Alembic migration
4. Add appropriate indexes for tenant queries

### Implementing New Features
1. Check tenant scope requirements
2. Define role-based permissions
3. Follow existing patterns for consistency
4. Add comprehensive error handling
5. Include audit logging for compliance

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
