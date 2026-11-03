import { request as pwRequest } from '@playwright/test';
import { expect } from './fixtures';
import { env } from './env';

/** Clinics the specs onboard are named `E2E <slug>`, so leftovers are easy to recognise. */
export const E2E_CLINIC = 'E2E';

/**
 * Delete a clinic the spec onboarded: log in as its admin, then call the backend's dev/test-only
 * DELETE /api/v1/dev/tenants/{id} (not mounted when ENVIRONMENT=production). Call it from afterAll.
 */
export async function deleteClinic(adminEmail: string, password = 'Password123!'): Promise<void> {
  const ctx = await pwRequest.newContext({ baseURL: env.API_URL });
  try {
    const login = await ctx.post('/api/v1/auth/login', { data: { email: adminEmail, password } });
    expect(login.status(), await login.text()).toBe(200);
    const { access_token, tenant } = await login.json();
    const res = await ctx.delete(`/api/v1/dev/tenants/${tenant.id}`, { headers: { Authorization: `Bearer ${access_token}` } });
    expect(res.status(), await res.text()).toBe(204);
  } finally {
    await ctx.dispose();
  }
}
