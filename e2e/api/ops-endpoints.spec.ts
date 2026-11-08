import { request as pwRequest, APIRequestContext } from '@playwright/test';
import { test, expect, requireApi } from '../src/fixtures';
import { env, DEMO_PATIENT, DEMO_THERAPIST, PLATFORM_STAFF } from '../src/env';

/**
 * Platform internals are for PsyClinicalMind's own staff only. /health/detailed (pool status, worker
 * heartbeat) and /metrics/database-pools answer platform staff; every clinic role and a portal PATIENT get the
 * answer of a missing route (404 "Not Found"); no token is 401 as on any non-public path. The do-nothing
 * POST /api/system/maintenance is gone. /health stays public and minimal.
 */
const NOT_FOUND = { detail: 'Not Found' };
const GATED = ['/health/detailed', '/metrics/database-pools'];

async function as(user: { email: string; password: string }, audience?: 'patient'): Promise<APIRequestContext> {
  const anon = await pwRequest.newContext({ baseURL: env.API_URL });
  const res = await anon.post('/api/v1/auth/login', {
    data: { email: user.email, password: user.password, ...(audience ? { audience } : {}) },
  });
  expect(res.status(), await res.text()).toBe(200);
  const body = await res.json();
  await anon.dispose();
  return pwRequest.newContext({
    baseURL: env.API_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${body.access_token}`, 'X-Tenant-ID': body.tenant?.id ?? '' },
  });
}

test.describe('@docs platform internals: platform staff only', () => {
  requireApi();

  test('platform staff read detailed health and pool metrics', async () => {
    const staff = await as(PLATFORM_STAFF);
    try {
      const health = await staff.get('/health/detailed');
      expect(health.status(), await health.text()).toBe(200);
      const body = await health.json();
      expect(body.status).toBe('healthy');
      expect(Object.keys(body.services)).toEqual(expect.arrayContaining(['database', 'followups_worker']));

      const pools = await staff.get('/metrics/database-pools');
      expect(pools.status(), await pools.text()).toBe(200);
      expect(Object.keys((await pools.json()).pool_status)).toEqual(['public_pool']);
    } finally {
      await staff.dispose();
    }
  });

  test('clinic ADMIN, THERAPIST and a portal PATIENT get the answer of a missing route', async ({ api }) => {
    const therapist = await as(DEMO_THERAPIST);
    const patient = await as(DEMO_PATIENT, 'patient');
    try {
      for (const [who, ctx] of [['ADMIN', api], ['THERAPIST', therapist], ['PATIENT', patient]] as const) {
        for (const path of GATED) {
          const res = await ctx.get(path);
          expect(res.status(), `${who} ${path}`).toBe(404);
          expect(await res.json()).toEqual(NOT_FOUND);
        }
      }
    } finally {
      await therapist.dispose();
      await patient.dispose();
    }
  });

  test('no token: 401', async ({ anon }) => {
    for (const path of GATED) expect((await anon.get(path)).status(), path).toBe(401);
  });

  test('the maintenance trigger is gone, for platform staff too', async ({ api }) => {
    const staff = await as(PLATFORM_STAFF);
    try {
      for (const ctx of [staff, api]) {
        const res = await ctx.post('/api/system/maintenance');
        expect(res.status()).toBe(404);
        expect(await res.json()).toEqual(NOT_FOUND);
      }
    } finally {
      await staff.dispose();
    }
  });
});
