import { request as pwRequest } from '@playwright/test';
import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { env, RANDOM_UUID } from '../src/env';

/** Guards enforced by app/middleware/auth_middleware.py and app/utils/auth.py. */
test.describe('authentication guard', () => {
  requireApi();

  const protectedRoutes = [
    '/api/v1/auth/me',
    '/api/v1/patients/',
    '/api/v1/sessions/',
    '/api/v1/kanban/boards',
    '/api/v1/teams/teams',
    '/api/v1/crisis/events',
    '/api/v1/tenants/my-tenants',
    '/api/v1/analytics/usage',
    '/api/v1/otp/health',
  ];

  for (const route of protectedRoutes) {
    test(`GET ${route} without a token → 401`, async ({ anon }) => {
      const res = await anon.get(route);
      expect(res.status()).toBe(401);
    });
  }

  test('a malformed bearer token → 401', async ({ anon }) => {
    const res = await anon.get('/api/v1/auth/me', { headers: { Authorization: 'Bearer not.a.jwt' } });
    expect(res.status()).toBe(401);
  });

  test('a token signed with the wrong secret → 401', async ({ anon }) => {
    // header.payload.signature with a valid-looking structure but an invalid signature
    const forged =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
      Buffer.from(JSON.stringify({ user_id: RANDOM_UUID, email: 'x@y.z', role: 'admin', tenant_id: RANDOM_UUID, exp: 4102444800 })).toString('base64url') +
      '.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const res = await anon.get('/api/v1/auth/me', { headers: { Authorization: `Bearer ${forged}` } });
    expect(res.status()).toBe(401);
  });

  test('public endpoints answer without a token', async ({ anon }) => {
    expect((await anon.get('/health')).status()).toBe(200);
    expect((await anon.get('/api/v1/onboarding/metadata')).status()).toBe(200);
  });
});

test.describe('tenant isolation', () => {
  requireApi();
  requireAuth();

  test('the tenant in the JWT wins over a spoofed X-Tenant-ID header', async ({ auth }) => {
    const ctx = await pwRequest.newContext({
      baseURL: env.API_URL,
      extraHTTPHeaders: { Authorization: `Bearer ${auth.token}`, 'X-Tenant-ID': RANDOM_UUID },
    });
    try {
      const me = await (await ctx.get('/api/v1/auth/me')).json();
      expect(me.tenant_id).toBe(auth.tenantId);
      expect(me.tenant_id).not.toBe(RANDOM_UUID);
    } finally {
      await ctx.dispose();
    }
  });

  test("another tenant's resources are not readable", async ({ api }) => {
    for (const path of [`/api/v1/tenants/${RANDOM_UUID}`, `/api/v1/tenants/${RANDOM_UUID}/users`, `/api/v1/tenants/${RANDOM_UUID}/features`]) {
      const res = await api.get(path);
      expect([403, 404], `${path} → ${res.status()}`).toContain(res.status());
    }
  });

  test('unknown resource ids are 404, not 500', async ({ api }) => {
    for (const path of [`/api/v1/kanban/boards/${RANDOM_UUID}`, `/api/v1/kanban/tasks/${RANDOM_UUID}`, `/api/v1/teams/teams/${RANDOM_UUID}`]) {
      const res = await api.get(path);
      expect(res.status(), path).toBe(404);
    }
  });
});

test.describe('permissions', () => {
  requireApi();
  requireAuth();

  const UNFINISHED = 'app/api/v1/permissions.py is unfinished (wrong require_permission signature, imports a non-existent get_user_permissions) and is deliberately not mounted → 404';

  test('GET /permissions/roles/ lists role permissions', async ({ api }) => {
    test.fixme(true, UNFINISHED);
    const res = await api.get('/api/v1/permissions/roles/');
    expect(res.status()).toBe(200);
  });

  test('GET /permissions/users/{id}/permissions returns the current user permissions', async ({ api, auth }) => {
    test.fixme(true, UNFINISHED);
    const res = await api.get(`/api/v1/permissions/users/${auth.user?.id}/permissions`);
    expect(res.status()).toBe(200);
  });
});
