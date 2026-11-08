import { request as pwRequest, APIRequestContext } from '@playwright/test';
import { test, expect, requireApi } from '../src/fixtures';
import { env, DEMO_PATIENT, DEMO_THERAPIST, PLATFORM_STAFF } from '../src/env';

/**
 * /api/v1/docs: the internal docs (feature register, help book, support runbook) for PsyClinicalMind's
 * own staff. Platform staff = an active platform_staff row, re-read on every request. Everyone else gets
 * exactly the answer of a route that does not exist (404 "Not Found"); no token is 401 as on any path.
 */
const NOT_FOUND = { detail: 'Not Found' };
const HELP_SLUGS = [
  'help/booking-link', 'help/clinic-hours', 'help/clinic-setup', 'help/clinician-hours', 'help/clinician-time',
  'help/follow-ups-and-tasks', 'help/install-app', 'help/inviting-staff', 'help/leave-and-blocked-time',
  'help/onboarding', 'help/patient-portal', 'help/razorpay', 'help/roles', 'help/services',
  'help/sessions-and-outcomes', 'help/stay-signed-in',
];

async function as(user: { email: string; password: string }, audience?: 'patient'): Promise<APIRequestContext> {
  const anon = await pwRequest.newContext({ baseURL: env.API_URL });
  const res = await anon.post('/api/v1/auth/login', { data: { email: user.email, password: user.password, ...(audience ? { audience } : {}) } });
  expect(res.status(), await res.text()).toBe(200);
  const body = await res.json();
  await anon.dispose();
  return pwRequest.newContext({
    baseURL: env.API_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${body.access_token}`, 'X-Tenant-ID': body.tenant?.id ?? '' },
  });
}

test.describe('@docs internal docs API', () => {
  requireApi();

  test('platform staff list every doc and read one', async () => {
    const staff = await as(PLATFORM_STAFF);
    const list = await staff.get('/api/v1/docs');
    expect(list.status(), await list.text()).toBe(200);
    const slugs = ((await list.json()) as { slug: string }[]).map((d) => d.slug).sort();
    expect(slugs).toEqual(['register', 'runbook', ...HELP_SLUGS].sort());

    const doc = await staff.get('/api/v1/docs/register');
    expect(doc.status()).toBe(200);
    const body = await doc.json();
    expect(body.slug).toBe('register');
    expect(body.section).toBe('Feature register');
    expect(body.markdown.startsWith('# Feature register\n')).toBe(true);

    const help = await staff.get('/api/v1/docs/help/razorpay');
    expect(help.status()).toBe(200);
    expect((await help.json()).section).toBe('Help book');
    await staff.dispose();
  });

  test('platform staff: an unknown or path-like slug is 404', async () => {
    const staff = await as(PLATFORM_STAFF);
    for (const slug of ['nope', 'help/nope', '..%2F..%2Fmain.py', 'help%2F..%2F..%2Fconfig%2Fsettings.py', 'README']) {
      const res = await staff.get(`/api/v1/docs/${slug}`);
      expect(res.status(), slug).toBe(404);
      expect(await res.json()).toEqual(NOT_FOUND);
    }
    await staff.dispose();
  });

  test('clinic ADMIN gets the answer of a missing route', async ({ api }) => {
    for (const path of ['/api/v1/docs', '/api/v1/docs/register', '/api/v1/docs/runbook']) {
      const res = await api.get(path);
      expect(res.status(), path).toBe(404);
      expect(await res.json()).toEqual(NOT_FOUND);
    }
    const missing = await api.get('/api/v1/no-such-route');
    expect(missing.status()).toBe(404);
    expect(await missing.json()).toEqual(NOT_FOUND);
  });

  test('a clinician gets 404', async () => {
    const therapist = await as(DEMO_THERAPIST);
    const res = await therapist.get('/api/v1/docs');
    expect(res.status()).toBe(404);
    expect(await res.json()).toEqual(NOT_FOUND);
    await therapist.dispose();
  });

  test('a patient gets 404', async () => {
    const patient = await as(DEMO_PATIENT, 'patient');
    for (const path of ['/api/v1/docs', '/api/v1/docs/register']) {
      const res = await patient.get(path);
      expect(res.status(), path).toBe(404);
      expect(await res.json()).toEqual(NOT_FOUND);
    }
    await patient.dispose();
  });

  test('no token is 401', async ({ anon }) => {
    for (const path of ['/api/v1/docs', '/api/v1/docs/register']) {
      const res = await anon.get(path);
      expect(res.status(), path).toBe(401);
      expect(await res.json()).toEqual({ detail: 'Authentication required' });
    }
  });
});
