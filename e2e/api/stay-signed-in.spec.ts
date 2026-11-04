import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { env, DEMO_PATIENT } from '../src/env';
import type { APIRequestContext } from '@playwright/test';

/**
 * "Stay signed in": login hands out a refresh key; POST /auth/session/refresh swaps it for a new key and a
 * fresh 1-hour access token; logout ends the sign-in, by key when the access token has expired. The key just
 * replaced, shown again within 5 min (a lost response), is rotated again; any older key ends the sign-in.
 * Limits: unticked staff 2 h idle / 12 h max, unticked patients 24 h; ticked staff 7 d / patients 30 d idle.
 * Each test signs in on its own, so no sign-in is shared between tests.
 */
const REFRESH = '/api/v1/auth/session/refresh';

const claims = (jwt: string) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());

async function signIn(anon: APIRequestContext, opts: { remember?: boolean; patient?: boolean } = {}) {
  const who = opts.patient ? DEMO_PATIENT : { email: env.EMAIL, password: env.PASSWORD };
  const res = await anon.post('/api/v1/auth/login', {
    data: { ...who, audience: opts.patient ? 'patient' : 'staff', ...(opts.remember === undefined ? {} : { remember: opts.remember }) },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

const me = (anon: APIRequestContext, token: string, tenantId: string) =>
  anon.get('/api/v1/auth/me', { headers: { Authorization: `Bearer ${token}`, 'X-Tenant-ID': tenantId } });

test.describe('stay signed in — login', () => {
  requireApi();
  requireAuth();

  test('staff login without remember returns a refresh key and a 2 h idle sign-in', async ({ anon }) => {
    const body = await signIn(anon);
    expect(typeof body.refresh_token).toBe('string');
    expect(body.refresh_token).toMatch(/^[0-9a-f]{32}\.[\w-]{64}$/);
    expect(body.refresh_token.split('.')[0]).toBe(claims(body.access_token).sid.replace(/-/g, ''));
    expect(body.expires_in).toBe(3600);
    expect(body.session_expires_in).toBe(7200);
  });

  test('patient login without remember gets a 24 h sign-in', async ({ anon }) => {
    expect((await signIn(anon, { patient: true })).session_expires_in).toBe(86400);
  });

  test('staff login with remember gets a 7-day sign-in', async ({ anon }) => {
    expect((await signIn(anon, { remember: true })).session_expires_in).toBe(604800);
  });

  test('patient login with remember gets a 30-day sign-in', async ({ anon }) => {
    expect((await signIn(anon, { remember: true, patient: true })).session_expires_in).toBe(2592000);
  });

  test('the access token names its sign-in and lasts one hour', async ({ anon }) => {
    const c = claims((await signIn(anon)).access_token);
    expect(c.sid).toMatch(/^[0-9a-f-]{36}$/);
    expect(c.exp - c.iat).toBe(3600);
  });
});

test.describe('stay signed in — POST /auth/session/refresh', () => {
  requireApi();
  requireAuth();

  test('returns a new access token and a new refresh key; the new token works', async ({ anon }) => {
    const first = await signIn(anon, { remember: true });
    const res = await anon.post(REFRESH, { data: { refresh_token: first.refresh_token } });
    expect(res.status(), await res.text()).toBe(200);
    const next = await res.json();
    expect(next.refresh_token).not.toBe(first.refresh_token);
    expect(next.expires_in).toBe(3600);
    expect(next.session_expires_in).toBe(604800);
    expect(claims(next.access_token).sid).toBe(claims(first.access_token).sid);
    expect((await me(anon, next.access_token, first.tenant.id)).status()).toBe(200);
  });

  test('the replaced key, shown again straight away (lost response), gets a fresh working key', async ({ anon }) => {
    const first = await signIn(anon);
    const lost = await anon.post(REFRESH, { data: { refresh_token: first.refresh_token } });
    expect(lost.status()).toBe(200); // the device never received this answer
    const again = await anon.post(REFRESH, { data: { refresh_token: first.refresh_token } });
    expect(again.status()).toBe(200);
    const next = await again.json();
    expect(next.refresh_token).not.toBe((await lost.json()).refresh_token);
    expect((await me(anon, next.access_token, first.tenant.id)).status()).toBe(200);
    expect((await anon.post(REFRESH, { data: { refresh_token: next.refresh_token } })).status()).toBe(200);
  });

  test('a key two rotations old ends the sign-in: the current key stops working too', async ({ anon }) => {
    const first = await signIn(anon);
    const second = await (await anon.post(REFRESH, { data: { refresh_token: first.refresh_token } })).json();
    const third = await (await anon.post(REFRESH, { data: { refresh_token: second.refresh_token } })).json();
    const stale = await anon.post(REFRESH, { data: { refresh_token: first.refresh_token } });
    expect(stale.status()).toBe(401);
    expect((await stale.json()).message).toBe('Session ended');
    const current = await anon.post(REFRESH, { data: { refresh_token: third.refresh_token } });
    expect(current.status()).toBe(401);
    expect((await current.json()).message).toBe('Session ended');
  });

  test('a forged secret for a real sign-in ends that sign-in', async ({ anon }) => {
    const first = await signIn(anon);
    const forged = `${first.refresh_token.split('.')[0]}.${'A'.repeat(64)}`;
    expect((await anon.post(REFRESH, { data: { refresh_token: forged } })).status()).toBe(401);
    expect((await anon.post(REFRESH, { data: { refresh_token: first.refresh_token } })).status()).toBe(401);
  });

  test('logout with only the refresh key (access token expired) ends the sign-in', async ({ anon }) => {
    const first = await signIn(anon, { remember: true });
    const out = await anon.post('/api/v1/auth/logout', {
      headers: { Authorization: 'Bearer expired.or.garbage' },
      data: { refresh_token: first.refresh_token },
    });
    expect(out.status()).toBe(200);
    expect((await out.json()).message).toBe('Successfully logged out');
    const res = await anon.post(REFRESH, { data: { refresh_token: first.refresh_token } });
    expect(res.status()).toBe(401);
    expect((await res.json()).message).toBe('Session ended');
  });

  test('logout with nothing is still 200 and ends nothing', async ({ anon }) => {
    const first = await signIn(anon);
    expect((await anon.post('/api/v1/auth/logout')).status()).toBe(200);
    expect((await anon.post(REFRESH, { data: { refresh_token: first.refresh_token } })).status()).toBe(200);
  });

  test('after logout, the refresh key is refused', async ({ anon }) => {
    const first = await signIn(anon, { remember: true });
    const out = await anon.post('/api/v1/auth/logout', {
      headers: { Authorization: `Bearer ${first.access_token}`, 'X-Tenant-ID': first.tenant.id },
    });
    expect(out.status()).toBe(200);
    const res = await anon.post(REFRESH, { data: { refresh_token: first.refresh_token } });
    expect(res.status()).toBe(401);
    expect((await res.json()).message).toBe('Session ended');
  });

  test('after logout, /auth/refresh-token is refused', async ({ anon }) => {
    const first = await signIn(anon);
    const headers = { Authorization: `Bearer ${first.access_token}`, 'X-Tenant-ID': first.tenant.id };
    expect((await anon.post('/api/v1/auth/logout', { headers })).status()).toBe(200);
    expect((await anon.post('/api/v1/auth/refresh-token', { headers })).status()).toBe(401);
  });

  test('/auth/refresh-token keeps the original expiry', async ({ anon }) => {
    const first = await signIn(anon);
    const res = await anon.post('/api/v1/auth/refresh-token', {
      headers: { Authorization: `Bearer ${first.access_token}`, 'X-Tenant-ID': first.tenant.id },
    });
    expect(res.status()).toBe(200);
    expect(claims((await res.json()).access_token).exp).toBe(claims(first.access_token).exp);
  });

  test('a made-up refresh key is refused', async ({ anon }) => {
    const res = await anon.post(REFRESH, { data: { refresh_token: 'x'.repeat(64) } });
    expect(res.status()).toBe(401);
    expect((await res.json()).message).toBe('Session ended');
  });

  test('an access token sent as a refresh key is refused', async ({ anon }) => {
    const first = await signIn(anon);
    expect((await anon.post(REFRESH, { data: { refresh_token: first.access_token } })).status()).toBe(401);
  });

  test('a refresh without a body is a validation error', async ({ anon }) => {
    expect((await anon.post(REFRESH, { data: {} })).status()).toBe(422);
  });
});
