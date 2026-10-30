import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { env, uniq, DEMO_PSYCHOLOGIST, DEMO_THERAPIST } from '../src/env';

test.describe('POST /api/v1/auth/login', () => {
  requireApi();

  test('returns token, user and tenant for valid credentials', async ({ anon }) => {
    requireAuth();
    const res = await anon.post('/api/v1/auth/login', { data: { email: env.EMAIL, password: env.PASSWORD } });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.token_type).toBe('bearer');
    expect(body.access_token.split('.')).toHaveLength(3);
    expect(body.expires_in).toBeGreaterThan(0);
    expect(body.user).toEqual(expect.objectContaining({ id: expect.any(String), email: env.EMAIL, role: expect.any(String) }));
    expect(body.tenant).toEqual(expect.objectContaining({ id: expect.any(String), organization_name: expect.any(String) }));
  });

  test('rejects a wrong password with 401', async ({ anon }) => {
    const res = await anon.post('/api/v1/auth/login', { data: { email: env.EMAIL, password: 'definitely-wrong' } });
    expect(res.status()).toBe(401);
    // main.py's HTTPException handler wraps errors as {error, message, status_code, request_id, ...}
    expect((await res.json()).message).toBe('Invalid email or password');
  });

  test('rejects an unknown email with 401 (no enumeration)', async ({ anon }) => {
    const res = await anon.post('/api/v1/auth/login', { data: { email: `${uniq('nobody')}@example.com`, password: 'whatever123' } });
    expect(res.status()).toBe(401);
    expect((await res.json()).message).toBe('Invalid email or password');
  });

  test('validates the body (422 when password missing / email malformed)', async ({ anon }) => {
    expect((await anon.post('/api/v1/auth/login', { data: { email: env.EMAIL } })).status()).toBe(422);
    expect((await anon.post('/api/v1/auth/login', { data: { email: 'not-an-email', password: 'x' } })).status()).toBe(422);
  });
});

test.describe('authenticated auth endpoints', () => {
  requireApi();
  requireAuth();

  test('GET /auth/me returns identity, tenant and permissions from the token', async ({ api, auth }) => {
    const res = await api.get('/api/v1/auth/me');
    expect(res.status()).toBe(200);
    const me = await res.json();
    expect(me.email).toBe(env.EMAIL);
    expect(me.id).toBe(auth.user?.id);
    expect(me.tenant_id).toBe(auth.tenantId);
    expect(me.role).toBe(auth.user?.role);
    expect(Array.isArray(me.permissions)).toBe(true);
    expect(me.permissions.length).toBeGreaterThan(0);
  });

  test('GET /auth/me returns the stored name, in the same snake_case shape as login', async ({ anon }) => {
    const login = await anon.post('/api/v1/auth/login', { data: DEMO_PSYCHOLOGIST });
    expect(login.status(), await login.text()).toBe(200);
    const { access_token, user } = await login.json();
    expect(user.first_name).not.toBe('dr'); // the seed's real name, not the email's local part

    const res = await anon.get('/api/v1/auth/me', { headers: { Authorization: `Bearer ${access_token}` } });
    expect(res.status()).toBe(200);
    const me = await res.json();
    expect(me).toEqual(expect.objectContaining({
      id: user.id,
      first_name: user.first_name,
      last_name: user.last_name,
      full_name: `${user.first_name} ${user.last_name}`,
      is_verified: user.is_verified,
    }));
  });

  test('POST /auth/logout succeeds', async ({ api }) => {
    const res = await api.post('/api/v1/auth/logout');
    expect(res.status()).toBe(200);
    expect((await res.json()).message).toContain('logged out');
  });

  test('POST /auth/refresh-token issues a new token', async ({ api }) => {
    const res = await api.post('/api/v1/auth/refresh-token');
    expect(res.status()).toBe(200);
    expect((await res.json()).access_token.split('.')).toHaveLength(3);
  });
});

test.describe('stubbed auth flows (documented, not yet implemented)', () => {
  requireApi();

  test('POST /auth/register creates a tenant and admin', async ({ anon }) => {
    test.fixme(true, 'register_user_and_tenant never writes to the DB and returns placeholder ids; real signup is /api/v1/onboarding/complete');
    const res = await anon.post('/api/v1/auth/register', {
      data: {
        organization_name: uniq('Org'),
        organization_type: 'clinic',
        contact_email: `${uniq('org')}@example.com`,
        admin_user: { email: `${uniq('admin')}@example.com`, password: 'password123', first_name: 'A', last_name: 'B' },
      },
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).tenant.id).not.toBe('new_tenant_id');
  });

  test('POST /auth/request-password-reset always answers 200 without leaking existence', async ({ anon }) => {
    const res = await anon.post('/api/v1/auth/request-password-reset', { data: { email: `${uniq('nobody')}@example.com` } });
    expect(res.status()).toBe(200);
    expect((await res.json()).message).toMatch(/If the email exists/);
  });

  test('POST /auth/reset-password rejects a bad token with 400', async ({ anon }) => {
    const res = await anon.post('/api/v1/auth/reset-password', { data: { token: 'bogus', new_password: 'password123' } });
    expect(res.status()).toBe(400);
  });

  test('POST /auth/set-password rejects a bad invite token with 400', async ({ anon }) => {
    const res = await anon.post('/api/v1/auth/set-password', { data: { token: 'bogus', password: 'password123' } });
    expect(res.status()).toBe(400);
  });
});

test.describe('login response carries the role permissions (no reload needed)', () => {
  requireApi();
  requireAuth();

  // Log in, then read /auth/me with the same token. The login user object must already carry the
  // fields /auth/me returns, so the UI (Quick Actions) is not empty until the first reload.
  async function loginAndMe(anon: any, creds: { email: string; password: string }) {
    const login = await anon.post('/api/v1/auth/login', { data: creds });
    expect(login.status(), await login.text()).toBe(200);
    const body = await login.json();
    const meRes = await anon.get('/api/v1/auth/me', {
      headers: { Authorization: `Bearer ${body.access_token}`, 'X-Tenant-ID': body.tenant.id },
    });
    expect(meRes.status(), await meRes.text()).toBe(200);
    return { user: body.user, me: await meRes.json() };
  }

  test('the admin login user carries the same permissions /auth/me returns', async ({ anon }) => {
    const { user, me } = await loginAndMe(anon, { email: env.EMAIL, password: env.PASSWORD });
    expect(Array.isArray(user.permissions)).toBe(true);
    expect(user.permissions.length).toBeGreaterThan(0);
    expect(user.tenant_id).toBeTruthy();
    expect(user.firm_code).toBe(me.firm_code);
    expect([...user.permissions].sort()).toEqual([...me.permissions].sort());
  });

  test('permissions are role-derived: a therapist gets fewer than an admin, matching its own /auth/me', async ({ anon }) => {
    const admin = await loginAndMe(anon, { email: env.EMAIL, password: env.PASSWORD });
    const therapist = await loginAndMe(anon, DEMO_THERAPIST);
    expect(therapist.user.permissions.length).toBeGreaterThan(0);
    expect([...therapist.user.permissions].sort()).toEqual([...therapist.me.permissions].sort());
    expect(admin.user.permissions.length).toBeGreaterThan(therapist.user.permissions.length);
  });
});
