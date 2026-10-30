import { request } from '@playwright/test';
import { test, expect, requireApi } from '../src/fixtures';
import { env, uniq } from '../src/env';

// CORS = backend PLATFORM_ORIGIN (expected to equal WEB_URL) + every trial/active tenant's
// frontend_origin from the platform DB, reloaded every 30s without a restart.
const ALLOW_LISTED_PHONE = '+919876543211'; // VERIFICATION_TEST_PHONES: onboarding skips phone.email

const preflight = (ctx: import('@playwright/test').APIRequestContext, origin: string) =>
  ctx.fetch('/api/v1/auth/login', {
    method: 'OPTIONS',
    headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
  });

const onboarding = (slug: string, frontend_origin: string) => ({
  organization: {
    name: `Clinic ${slug}`, type: 'clinic', contact_email: `${slug}@example.com`, contact_phone: ALLOW_LISTED_PHONE,
    address_line1: '1 Road', city: 'Pune', state: 'MH', postal_code: '411001', frontend_origin,
  },
  plan: { plan_type: 'basic', max_users: 5, max_patients: 100, max_sessions_per_month: 500 },
  admin: { email: `admin.${slug}@example.com`, password: 'Password123!', first_name: 'New', last_name: 'Admin', phone: ALLOW_LISTED_PHONE },
  admin_role: 'ADMIN',
  team_members: [],
});

test.describe('CORS origins from the platform DB', () => {
  requireApi();

  test('the shared app origin is allowed', async ({ anon }) => {
    const res = await preflight(anon, env.WEB_URL);
    expect(res.status()).toBe(200);
    expect(res.headers()['access-control-allow-origin']).toBe(env.WEB_URL);
  });

  test('onboarding with an origin outside TENANT_ORIGIN_PATTERN is rejected (422)', async ({ anon }) => {
    const res = await anon.post('/api/v1/onboarding/complete', { data: onboarding(uniq('org').toLowerCase(), 'https://evil.example.com') });
    expect(res.status(), await res.text()).toBe(422);
  });

  test('a new tenant\'s port is refused, then allowed after onboarding, and only sees its own data', async ({ anon }) => {
    test.setTimeout(60_000);
    const origin = `http://localhost:${40000 + Math.floor(Math.random() * 20000)}`;
    const slug = uniq('org').toLowerCase();

    const before = await preflight(anon, origin);
    expect(before.status()).toBe(400);
    expect(before.headers()['access-control-allow-origin']).toBeUndefined();

    const res = await anon.post('/api/v1/onboarding/complete', { data: onboarding(slug, origin) });
    expect(res.status(), await res.text()).toBe(200);
    const tenantId: string = (await res.json()).tenant_id;

    await expect
      .poll(async () => (await preflight(anon, origin)).headers()['access-control-allow-origin'], { timeout: 40_000, intervals: [2_000] })
      .toBe(origin);

    const login = await anon.post('/api/v1/auth/login', { data: { email: `admin.${slug}@example.com`, password: 'Password123!' } });
    expect(login.status(), await login.text()).toBe(200);
    const { access_token, tenant } = await login.json();
    expect(tenant.id).toBe(tenantId);

    const ctx = await request.newContext({
      baseURL: env.API_URL,
      extraHTTPHeaders: { Authorization: `Bearer ${access_token}`, 'X-Tenant-ID': tenantId, Origin: origin },
    });
    try {
      const patients = await ctx.get('/api/v1/patients/');
      expect(patients.status(), await patients.text()).toBe(200);
      expect(patients.headers()['access-control-allow-origin']).toBe(origin);
      expect((await patients.json()).patients).toEqual([]);
    } finally {
      await ctx.dispose();
    }
  });
});
