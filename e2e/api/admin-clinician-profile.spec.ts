import { request as pwRequest } from '@playwright/test';
import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { env, uniq, RANDOM_UUID, DEMO_THERAPIST } from '../src/env';
import { demoClinicianIds } from '../src/catalog';

/**
 * /users/{id}/clinician-profile: an ADMIN or CLINICAL_DIRECTOR reads and replaces the public booking profile
 * of a clinician of their own clinic (stored where PUT /users/me {profile} puts it). A therapist → 403;
 * another clinic's user, a non-clinician or an unknown id → 404; no token → 401.
 */

const ALLOW_LISTED_PHONE = '+919876543211'; // VERIFICATION_TEST_PHONES: onboarding skips phone.email

async function bearer(creds: { email: string; password: string }) {
  const anon = await pwRequest.newContext({ baseURL: env.API_URL });
  const res = await anon.post('/api/v1/auth/login', { data: creds });
  expect(res.status(), `login ${creds.email}: ${await res.text()}`).toBe(200);
  const body = await res.json();
  await anon.dispose();
  return pwRequest.newContext({
    baseURL: env.API_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${body.access_token}`, 'X-Tenant-ID': body.tenant.id },
  });
}

test.describe('admins edit a clinician\'s public profile', () => {
  requireApi();
  requireAuth();

  test('admin: read, replace, and the change shows on /users/me and the booking page', async ({ api, anon, auth }) => {
    const [, smith] = await demoClinicianIds(); // the psychologist: other specs edit Jane's own profile
    const path = `/api/v1/users/${smith}/clinician-profile`;
    const before = await api.get(path);
    expect(before.status(), await before.text()).toBe(200);
    const original = (await before.json()).profile;

    const profile = { bio: uniq('Admin-written bio'), qualifications: ['M.Phil Clinical Psychology'], languages: ['English', 'Marathi'], photo_url: null };
    try {
      const put = await api.put(path, { data: profile });
      expect(put.status(), await put.text()).toBe(200);
      expect(await put.json()).toEqual({ user_id: smith, name: expect.any(String), profile });
      expect((await (await api.get(path)).json()).profile).toEqual(profile);

      const own = await bearer({ email: 'dr.smith@democlinic.com', password: 'Password123!' });
      try {
        expect((await (await own.get('/api/v1/users/me')).json()).profile).toEqual(profile);
      } finally {
        await own.dispose();
      }
      const info = await (await anon.get(`/api/v1/public/booking/${auth.firmCode}`)).json();
      const listed = info.practitioners.find((p: { id: string }) => p.id === smith);
      if (listed) expect(listed.profile).toEqual(profile); // listed only while a service is assigned to him

      const bad = await api.put(path, { data: { ...profile, photo_url: 'http://insecure.example.com/a.jpg' } });
      expect(bad.status(), await bad.text()).toBe(422);
    } finally {
      if (original) await api.put(path, { data: original });
      else {
        const own = await bearer({ email: 'dr.smith@democlinic.com', password: 'Password123!' });
        await own.put('/api/v1/users/me', { data: { profile: null } }); // the admin route replaces, /users/me clears
        await own.dispose();
      }
    }
  });

  test('a non-clinician or unknown id → 404', async ({ api, auth }) => {
    expect((await api.get(`/api/v1/users/${auth.user!.id}/clinician-profile`)).status()).toBe(404); // the admin
    expect((await api.put(`/api/v1/users/${RANDOM_UUID}/clinician-profile`, { data: { bio: 'x' } })).status()).toBe(404);
  });

  test('a therapist editing a colleague → 403; no token → 401', async ({ anon }) => {
    const [jane, smith] = await demoClinicianIds();
    const therapist = await bearer(DEMO_THERAPIST);
    try {
      expect((await therapist.get(`/api/v1/users/${smith}/clinician-profile`)).status()).toBe(403);
      expect((await therapist.put(`/api/v1/users/${smith}/clinician-profile`, { data: { bio: 'not mine' } })).status()).toBe(403);
    } finally {
      await therapist.dispose();
    }
    expect((await anon.get(`/api/v1/users/${jane}/clinician-profile`)).status()).toBe(401);
    expect((await anon.put(`/api/v1/users/${jane}/clinician-profile`, { data: { bio: 'x' } })).status()).toBe(401);
  });

  test('another clinic\'s admin → 404 for this clinic\'s clinician', async ({ anon }) => {
    test.setTimeout(60_000);
    const slug = uniq('org').toLowerCase();
    const res = await anon.post('/api/v1/onboarding/complete', {
      data: {
        organization: { name: `Clinic ${slug}`, type: 'clinic', contact_email: `${slug}@example.com`, contact_phone: ALLOW_LISTED_PHONE, address_line1: '1 Road', city: 'Pune', state: 'MH', postal_code: '411001' },
        plan: { plan_type: 'basic', max_users: 5, max_patients: 100, max_sessions_per_month: 500 },
        admin: { email: `admin.${slug}@example.com`, password: 'Password123!', first_name: 'Other', last_name: 'Admin', phone: ALLOW_LISTED_PHONE },
        admin_role: 'ADMIN',
        team_members: [],
      },
    });
    expect(res.status(), await res.text()).toBe(200);
    const [jane] = await demoClinicianIds();
    const foreign = await bearer({ email: `admin.${slug}@example.com`, password: 'Password123!' });
    try {
      expect((await foreign.get(`/api/v1/users/${jane}/clinician-profile`)).status()).toBe(404);
      expect((await foreign.put(`/api/v1/users/${jane}/clinician-profile`, { data: { bio: 'hijack' } })).status()).toBe(404);
    } finally {
      await foreign.dispose();
    }
  });
});
