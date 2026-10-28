import { test as base, expect, request as pwRequest, APIRequestContext } from '@playwright/test';
import { env } from './env';

export interface AuthInfo {
  token: string;
  tenantId: string;
  user: { id: string; email: string; role: string } | null;
}

interface Fixtures {
  /** Request context authenticated as the E2E user (Bearer + X-Tenant-ID), like the frontend sends. */
  api: APIRequestContext;
  /** Request context with no credentials. */
  anon: APIRequestContext;
  auth: AuthInfo;
}

export const test = base.extend<Fixtures>({
  auth: async ({}, use) => {
    await use({
      token: process.env.E2E_TOKEN ?? '',
      tenantId: process.env.E2E_TENANT_ID ?? '',
      user: process.env.E2E_USER ? JSON.parse(process.env.E2E_USER) : null,
    });
  },
  api: async ({ auth }, use) => {
    const ctx = await pwRequest.newContext({
      baseURL: env.API_URL,
      extraHTTPHeaders: {
        Authorization: `Bearer ${auth.token}`,
        'X-Tenant-ID': auth.tenantId,
      },
    });
    await use(ctx);
    await ctx.dispose();
  },
  anon: async ({}, use) => {
    const ctx = await pwRequest.newContext({ baseURL: env.API_URL });
    await use(ctx);
    await ctx.dispose();
  },
});

export { expect };

/* Call at the top of a describe block; skips the whole group with a visible reason. */
export const requireApi = () =>
  test.skip(process.env.E2E_API_UP !== '1', `backend not reachable at ${env.API_URL}/health`);
export const requireAuth = () =>
  test.skip(
    process.env.E2E_AUTH_OK !== '1',
    `could not log in as ${env.EMAIL} — is the backend up and demo data seeded (scripts/setup_demo_data.py)?`,
  );
export const requireWeb = () =>
  test.skip(process.env.E2E_WEB_UP !== '1', `frontend not reachable at ${env.WEB_URL}`);
export const requireDeid = () =>
  test.skip(process.env.E2E_DEID_UP !== '1', `de-identification service not reachable at ${env.DEID_URL}/api/health`);

/**
 * The React ErrorBoundary (frontend/src/main.tsx) renders "Something went wrong" — but so does a
 * permanently-hidden fallback <div> in frontend/index.html, so count only VISIBLE matches.
 */
export const expectNoCrash = async (page: import('@playwright/test').Page) =>
  expect(page.getByText('Something went wrong').locator('visible=true')).toHaveCount(0);
