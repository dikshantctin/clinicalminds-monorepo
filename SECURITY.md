# Security: dependency audit status

The weekly `.github/workflows/audit.yml` runs `pip-audit` on `backend/requirements-dev.txt` and
`npm audit --audit-level=high` on `frontend/` and `e2e/`.

**Target (2026-11 upgrades): backend 0 findings, frontend 0 high/critical, e2e 0.**

Versions are pinned exactly. Each is the newest release that has gone about 4 weeks without follow-up patches,
at or above the audit-fix minimum. Details and "what to check if something breaks" are in the "Dependency upgrades
(2026-11)" sections of `backend/CLAUDE.md` and `frontend/CLAUDE.md`.

## Accepted risk (reviewed 2026-11-08)

| Finding | Severity | Why accepted | Revisit |
|---|---|---|---|
| `react-router` / `react-router-dom` 6.30.6: open redirect via backslash in `<Link>`; constructor injection via deserialization | moderate | Fixed only in v7, a router migration. We use the SPA `<BrowserRouter>` only: no SSR, no data loaders, no user-supplied `<Link>` targets. | router v7 migration |
| `minimatch` (under typescript-eslint 6), `glob`, `sucrase`, `workbox-build`, `vite-plugin-pwa` | moderate | Run at lint or build time only and never ship to browsers. | typescript-eslint 8 / next tooling upgrade |
| `@rollup/plugin-node-resolve`, `deepmerge` | low | Build time only. | with the above |
| Backend AI chain: `anthropic==0.8.1` → tokenizers → huggingface-hub; `requirements-simple.txt` | none open | Deferred by the user: no AI work now. `anthropic` is never imported, and `requirements-simple.txt` is referenced nowhere and not audited. The httpx2 pin and anyio 4 currently lift the chain onto fixed releases. | when AI work starts |
