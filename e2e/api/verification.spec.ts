import { request as pwRequest } from '@playwright/test';
import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { env, uniq, UNVERIFIED_USER } from '../src/env';

test.describe('/api/v1/verification (phone.email)', () => {
  requireApi();

  test('rejects a user_json_url that is not on the vendor host (SSRF guard)', async ({ anon }) => {
    const res = await anon.post('/api/v1/verification/phone-email', {
      data: { user_json_url: 'https://evil.example.com/user_abc.json', kind: 'email', email: 'someone@example.com' },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).message).toBe('Verification could not be confirmed');
  });

  test('a vendor-shaped URL that does not exist is rejected without leaking details', async ({ anon }) => {
    const id = uniq('e2e').replace(/[^a-z0-9]/gi, '');
    const res = await anon.post('/api/v1/verification/phone-email', {
      data: { user_json_url: `https://user.phone.email/user_${id}.json`, kind: 'phone', email: 'someone@example.com', phone: '9876543210' },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).message).toBe('Verification could not be confirmed');
  });

  test('validates the body', async ({ anon }) => {
    expect((await anon.post('/api/v1/verification/phone-email', { data: {} })).status()).toBe(422);
    expect((await anon.post('/api/v1/verification/phone-email', { data: { user_json_url: 'x', kind: 'fax', email: 'a@b.co' } })).status()).toBe(422);
  });

  test('status is public and false for an unknown email', async ({ anon }) => {
    const res = await anon.get('/api/v1/verification/status', { params: { email: `${uniq('nobody')}@example.com` } });
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ exists: false, email_verified: false, phone_verified: false });
  });

  test('the logged-in endpoint requires a token', async ({ anon }) => {
    const res = await anon.post('/api/v1/verification/me/phone-email', { data: { user_json_url: 'https://user.phone.email/user_a1.json', kind: 'email' } });
    expect(res.status()).toBe(401);
  });
});

test.describe('verification gate', () => {
  requireApi();
  requireAuth();

  test('the allow-listed demo admin is verified at login and in /auth/me', async ({ anon, api }) => {
    const login = await (await anon.post('/api/v1/auth/login', { data: { email: env.EMAIL, password: env.PASSWORD } })).json();
    expect(login.user).toEqual(expect.objectContaining({ email_verified: true, phone_verified: true }));
    const me = await (await api.get('/api/v1/auth/me')).json();
    expect(me).toEqual(expect.objectContaining({ email_verified: true, phone_verified: true }));
  });

  test('an unverified team member can log in but is blocked from clinical routes', async ({ anon }) => {
    const login = await anon.post('/api/v1/auth/login', { data: UNVERIFIED_USER });
    expect(login.status(), await login.text()).toBe(200);
    const body = await login.json();
    expect(body.user).toEqual(expect.objectContaining({ email_verified: false, phone_verified: false }));

    const ctx = await pwRequest.newContext({
      baseURL: env.API_URL,
      extraHTTPHeaders: { Authorization: `Bearer ${body.access_token}`, 'X-Tenant-ID': body.tenant.id },
    });
    try {
      // exempt: finishing verification, auth, own tenant
      expect((await ctx.get('/api/v1/auth/me')).status()).toBe(200);
      expect((await ctx.get('/api/v1/tenants/my-tenants')).status()).toBe(200);
      expect((await ctx.post('/api/v1/verification/me/phone-email', { data: { user_json_url: 'https://evil.example.com/x.json', kind: 'email' } })).status()).toBe(400);
      // everything clinical: 403 verification_required (from the auth middleware)
      for (const path of ['/api/v1/patients/', '/api/v1/sessions/', '/api/v1/kanban/boards', '/api/v1/schedules/daily']) {
        const res = await ctx.get(path);
        expect(res.status(), path).toBe(403);
        const err = await res.json();
        expect(err.detail ?? err.message, path).toBe('verification_required');
      }
    } finally {
      await ctx.dispose();
    }
  });

  test('onboarding refuses a non-allow-listed admin who has not verified', async ({ anon }) => {
    const slug = uniq('org').toLowerCase();
    const res = await anon.post('/api/v1/onboarding/complete', {
      data: {
        organization: { name: `Clinic ${slug}`, type: 'clinic', contact_email: `${slug}@example.com`, contact_phone: '+919111111111', address_line1: '1 Road', city: 'Pune', state: 'MH', postal_code: '411001' },
        plan: { plan_type: 'basic', max_users: 5, max_patients: 100, max_sessions_per_month: 500 },
        admin: { email: `admin.${slug}@example.com`, password: 'Password123!', first_name: 'New', last_name: 'Admin', phone: '+919222222222' },
        admin_role: 'ADMIN',
        team_members: [],
      },
    });
    expect(res.status(), await res.text()).toBe(400);
    const errors: string[] = (await res.json()).message.errors;
    expect(errors.join(' ')).toMatch(/Email verification required/);
    expect(errors.join(' ')).toMatch(/Phone verification required/);
  });

  test('POST /auth/refresh-token issues a fresh token with verification claims', async ({ api }) => {
    const res = await api.post('/api/v1/auth/refresh-token');
    expect(res.status(), await res.text()).toBe(200);
    const token: string = (await res.json()).access_token;
    expect(token.split('.')).toHaveLength(3);
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    expect(claims).toEqual(expect.objectContaining({ email_verified: true, phone_verified: true }));
  });
});
