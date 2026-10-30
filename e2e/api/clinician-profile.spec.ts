import { request as pwRequest } from '@playwright/test';
import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { env, DEMO_THERAPIST, DEMO_PATIENT } from '../src/env';

// A clinician describes themselves in Settings → Profile; patients see it on the booking page.
async function login(creds: { email: string; password: string }, audience?: 'patient') {
  const anon = await pwRequest.newContext({ baseURL: env.API_URL });
  const res = await anon.post('/api/v1/auth/login', { data: audience ? { ...creds, audience } : creds });
  expect(res.status(), await res.text()).toBe(200);
  const body = await res.json();
  await anon.dispose();
  return {
    id: body.user.id as string,
    ctx: await pwRequest.newContext({ baseURL: env.API_URL, extraHTTPHeaders: { Authorization: `Bearer ${body.access_token}` } }),
  };
}

test.describe('clinician profile', () => {
  requireApi();
  requireAuth();
  test.describe.configure({ mode: 'serial' }); // both tests edit the demo therapist's own profile

  test('a clinician saves a profile; GET /users/me and the public booking page show it', async ({ anon, auth }) => {
    const jane = await login(DEMO_THERAPIST);
    const before = (await (await jane.ctx.get('/api/v1/users/me')).json()).profile;
    const profile = {
      bio: 'Works with adults on anxiety and sleep, using CBT.',
      qualifications: ['M.Phil Clinical Psychology', 'RCI registered'],
      languages: ['English', 'Hindi'],
      photo_url: 'https://example.com/jane.jpg',
    };
    try {
      const put = await jane.ctx.put('/api/v1/users/me', { data: { profile } });
      expect(put.status(), await put.text()).toBe(200);
      expect((await put.json()).profile).toEqual(profile);
      expect((await (await jane.ctx.get('/api/v1/users/me')).json()).profile).toEqual(profile);

      const info = await (await anon.get(`/api/v1/public/booking/${auth.firmCode}`)).json();
      const card = info.practitioners.find((p: { id: string }) => p.id === jane.id);
      expect(card, 'the demo therapist offers services').toBeTruthy();
      expect(card.profile).toEqual(profile);
    } finally {
      await jane.ctx.put('/api/v1/users/me', { data: { profile: before ?? null } });
      await jane.ctx.dispose();
    }
  });

  test('bad profile input → 422; a patient cannot use /users/me (403)', async () => {
    const jane = await login(DEMO_THERAPIST);
    const patient = await login(DEMO_PATIENT, 'patient');
    try {
      for (const profile of [
        { photo_url: 'http://example.com/plain-http.jpg' },
        { photo_url: 'javascript:alert(1)' },
        { bio: 'x'.repeat(1001) },
        { languages: Array.from({ length: 11 }, (_, i) => `L${i}`) },
        { qualifications: [''.padEnd(121, 'q')] },
        { unknown: 'field' },
      ]) {
        const res = await jane.ctx.put('/api/v1/users/me', { data: { profile } });
        expect(res.status(), `${JSON.stringify(profile).slice(0, 60)}: ${await res.text()}`).toBe(422);
      }
      expect((await patient.ctx.put('/api/v1/users/me', { data: { profile: { bio: 'hi' } } })).status()).toBe(403);
    } finally {
      await jane.ctx.dispose();
      await patient.ctx.dispose();
    }
  });
});
