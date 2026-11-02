import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { uniq } from '../src/env';

// Every clinic used to get its own connection pool (pool_size 5 + max_overflow 10) that was never closed:
// one more idle Postgres connection per onboarded clinic, until the shared server ran out. Tenants now
// share the one pool that /metrics/database-pools reports (backend .env: DATABASE_POOL_SIZE=5, MAX_OVERFLOW=10).
const POOL_SIZE = 5;
const POOL_LIMIT = 15;
const ALLOW_LISTED_PHONE = '+919876543211'; // VERIFICATION_TEST_PHONES: onboarding skips phone.email

const onboarding = (slug: string) => ({
  organization: {
    name: `Pool Clinic ${slug}`, type: 'clinic', contact_email: `${slug}@example.com`, contact_phone: ALLOW_LISTED_PHONE,
    address_line1: '1 Road', city: 'Pune', state: 'MH', postal_code: '411001',
  },
  plan: { plan_type: 'basic', max_users: 5, max_patients: 100, max_sessions_per_month: 500 },
  admin: { email: `admin.${slug}@example.com`, password: 'Password123!', first_name: 'Pool', last_name: 'Admin', phone: ALLOW_LISTED_PHONE },
  admin_role: 'ADMIN',
  team_members: [],
});

test.describe('database connections across clinics', () => {
  requireApi();
  requireAuth();

  test('three new clinics in use share one bounded pool', async ({ anon, api }) => {
    for (let i = 0; i < 3; i++) {
      const slug = uniq('pool').toLowerCase();
      const onboarded = await anon.post('/api/v1/onboarding/complete', { data: onboarding(slug) });
      expect(onboarded.status(), await onboarded.text()).toBe(200);
      const login = await anon.post('/api/v1/auth/login', { data: { email: `admin.${slug}@example.com`, password: 'Password123!' } });
      expect(login.status()).toBe(200);
      const headers = { Authorization: `Bearer ${(await login.json()).access_token}` };
      expect((await anon.get('/api/v1/patients/', { headers })).status()).toBe(200);
      expect((await anon.get('/api/v1/kanban/boards', { headers })).status()).toBe(200);
    }

    const res = await api.get('/metrics/database-pools');
    expect(res.status()).toBe(200);
    const { pool_status } = await res.json();
    expect(Object.keys(pool_status)).toEqual(['public_pool']); // no per-tenant pools
    const pool = pool_status.public_pool;
    expect(pool.size).toBe(POOL_SIZE);
    expect(pool.checked_in + pool.checked_out).toBeGreaterThanOrEqual(1); // the pool that served the requests
    expect(pool.checked_in + pool.checked_out).toBeLessThanOrEqual(POOL_LIMIT);
  });

  test('pool metrics need a login (401)', async ({ anon }) => {
    expect((await anon.get('/metrics/database-pools')).status()).toBe(401);
  });
});
