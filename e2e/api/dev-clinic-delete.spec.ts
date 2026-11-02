import { request as pwRequest } from '@playwright/test';
import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { env, uniq, DEMO_THERAPIST } from '../src/env';
import { E2E_CLINIC } from '../src/clinics';

// DELETE /api/v1/dev/tenants/{id}: dev/test-only, so specs can remove the clinics they onboard.
const ALLOW_LISTED_PHONE = '+919876543211'; // VERIFICATION_TEST_PHONES: onboarding skips phone.email
const PASSWORD = 'Password123!';

test.describe('dev/test-only clinic delete', () => {
  requireApi();
  requireAuth();

  test('the clinic admin deletes their clinic with its patients and sessions; nobody else can', async ({ anon, api, auth }) => {
    const slug = uniq('del').toLowerCase();
    const email = `admin.${slug}@example.com`;
    const onboard = await anon.post('/api/v1/onboarding/complete', {
      data: {
        organization: {
          name: `${E2E_CLINIC} ${slug}`, type: 'clinic', contact_email: `${slug}@example.com`, contact_phone: ALLOW_LISTED_PHONE,
          address_line1: '1 Road', city: 'Pune', state: 'MH', postal_code: '411001',
        },
        plan: { plan_type: 'basic', max_users: 5, max_patients: 100, max_sessions_per_month: 500 },
        admin: { email, password: PASSWORD, first_name: 'Del', last_name: 'Admin', phone: ALLOW_LISTED_PHONE },
        admin_role: 'ADMIN',
        team_members: [],
      },
    });
    expect(onboard.status(), await onboard.text()).toBe(200);
    const login = await anon.post('/api/v1/auth/login', { data: { email, password: PASSWORD } });
    const { access_token, tenant } = await login.json();
    const own = await pwRequest.newContext({
      baseURL: env.API_URL,
      extraHTTPHeaders: { Authorization: `Bearer ${access_token}`, 'X-Tenant-ID': tenant.id },
    });
    try {
      const patient = await own.post('/api/v1/patients/', { data: { first_name: uniq('Del'), last_name: 'Patient' } });
      expect(patient.status(), await patient.text()).toBe(200);
      const day = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
      const session = await own.post('/api/v1/sessions/', {
        data: { patient_id: (await patient.json()).id, scheduled_at: `${day}T10:00:00+05:30`, duration_minutes: 50 },
      });
      expect(session.status(), await session.text()).toBe(200);

      // another clinic's admin (the demo clinic) cannot delete it
      expect((await api.delete(`/api/v1/dev/tenants/${tenant.id}`)).status()).toBe(403);
      // no token
      expect((await anon.delete(`/api/v1/dev/tenants/${tenant.id}`)).status()).toBe(401);

      expect((await own.delete(`/api/v1/dev/tenants/${tenant.id}`)).status()).toBe(204);
    } finally {
      await own.dispose();
    }

    // gone: its admin cannot log in and its booking page is 404
    expect((await anon.post('/api/v1/auth/login', { data: { email, password: PASSWORD } })).status()).toBe(401);
    expect((await anon.get(`/api/v1/public/booking/${tenant.firm_code}`)).status()).toBe(404);
    // the demo clinic is untouched
    expect((await api.get('/api/v1/auth/me')).status()).toBe(200);
    expect(auth.tenantId).not.toBe(tenant.id);
  });

  test('a clinician cannot delete their own clinic (403)', async ({ anon, auth }) => {
    const login = await anon.post('/api/v1/auth/login', { data: DEMO_THERAPIST });
    expect(login.status(), await login.text()).toBe(200);
    const res = await anon.delete(`/api/v1/dev/tenants/${auth.tenantId}`, {
      headers: { Authorization: `Bearer ${(await login.json()).access_token}` },
    });
    expect(res.status()).toBe(403);
  });
});
