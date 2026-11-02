import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { env, uniq } from '../src/env';

/**
 * Login and password-reset rate limits (backend app/middleware/rate_limit.py, counters in Redis).
 * Per-account limits run at their production values here; per-IP limits are scaled up in CI
 * (RATE_LIMIT_IP_SCALE) because every spec shares one IP, so they are covered by backend pytest.
 * Each test onboards its own clinic so locking its admin never affects another spec.
 */
const ALLOW_LISTED_PHONE = '+919876543211'; // VERIFICATION_TEST_PHONES: onboarding skips phone.email
const PASSWORD = 'Password123!';
const LOGIN_FAILURES_ALLOWED = 10; // per account per 15 minutes

async function freshAdmin(anon: any): Promise<string> {
  const slug = uniq('rl').toLowerCase();
  const email = `admin.${slug}@example.com`;
  const res = await anon.post('/api/v1/onboarding/complete', {
    data: {
      organization: {
        name: `Rate Limit ${slug}`, type: 'clinic', contact_email: `${slug}@example.com`, contact_phone: ALLOW_LISTED_PHONE,
        address_line1: '1 Road', city: 'Pune', state: 'MH', postal_code: '411001',
      },
      plan: { plan_type: 'basic', max_users: 5, max_patients: 100, max_sessions_per_month: 500 },
      admin: { email, password: PASSWORD, first_name: 'Rate', last_name: 'Limit', phone: ALLOW_LISTED_PHONE },
      admin_role: 'ADMIN',
      team_members: [],
    },
  });
  expect(res.status(), await res.text()).toBe(200);
  return email;
}

const login = (anon: any, email: string, password: string) => anon.post('/api/v1/auth/login', { data: { email, password } });

async function failLogins(anon: any, email: string, times: number) {
  for (let i = 0; i < times; i++) expect((await login(anon, email, 'wrong-password-1')).status()).toBe(401);
}

function expectLimited(res: any) {
  expect(res.status()).toBe(429);
  const retryAfter = Number(res.headers()['retry-after']);
  expect(retryAfter).toBeGreaterThan(0);
  expect(retryAfter).toBeLessThanOrEqual(15 * 60);
}

test.describe('login rate limit (per account)', () => {
  requireApi();
  test.setTimeout(90_000); // up to 20 logins, each a password hash check

  test('10 failed logins lock the account: even the right password gets 429 with Retry-After', async ({ anon }) => {
    const email = await freshAdmin(anon);
    await failLogins(anon, email, LOGIN_FAILURES_ALLOWED);
    const locked = await login(anon, email, PASSWORD);
    expectLimited(locked);
    expect(await locked.json()).toEqual({ error: 'rate_limited', message: 'Too many attempts. Try again later.', status_code: 429 });
  });

  test('a locked account does not lock anyone else', async ({ anon }) => {
    requireAuth();
    const email = await freshAdmin(anon);
    await failLogins(anon, email, LOGIN_FAILURES_ALLOWED);
    expectLimited(await login(anon, email, PASSWORD));
    expect((await login(anon, env.EMAIL, env.PASSWORD)).status()).toBe(200);
  });

  test('a successful login clears the failure count', async ({ anon }) => {
    const email = await freshAdmin(anon);
    await failLogins(anon, email, LOGIN_FAILURES_ALLOWED - 1);
    expect((await login(anon, email, PASSWORD)).status()).toBe(200);
    await failLogins(anon, email, LOGIN_FAILURES_ALLOWED - 1); // would be 18 failures without the reset
    expect((await login(anon, email, PASSWORD)).status()).toBe(200);
  });

  test('the account is matched case-insensitively', async ({ anon }) => {
    const email = await freshAdmin(anon);
    await failLogins(anon, email.toUpperCase(), LOGIN_FAILURES_ALLOWED);
    expectLimited(await login(anon, email, PASSWORD));
  });

  test('a malformed body is still a 422, not counted', async ({ anon }) => {
    const email = await freshAdmin(anon);
    for (let i = 0; i < LOGIN_FAILURES_ALLOWED + 2; i++) {
      expect((await anon.post('/api/v1/auth/login', { data: { email } })).status()).toBe(422);
    }
    expect((await login(anon, email, PASSWORD)).status()).toBe(200);
  });
});

test.describe('password reset rate limit (per email)', () => {
  requireApi();

  test('5 reset requests per email per 15 minutes, then 429', async ({ anon }) => {
    const email = `${uniq('reset')}@example.com`;
    for (let i = 0; i < 5; i++) {
      expect((await anon.post('/api/v1/auth/request-password-reset', { data: { email } })).status()).toBe(200);
    }
    expectLimited(await anon.post('/api/v1/auth/request-password-reset', { data: { email } }));
    // another address is unaffected
    expect((await anon.post('/api/v1/auth/request-password-reset', { data: { email: `${uniq('other')}@example.com` } })).status()).toBe(200);
  });
});

test.describe('GET /health reports Redis', () => {
  requireApi();

  test('services.redis is "ok" while the limiter can reach Redis', async ({ anon }) => {
    const body = await (await anon.get('/health')).json();
    expect(body.services.redis).toBe('ok');
  });
});
