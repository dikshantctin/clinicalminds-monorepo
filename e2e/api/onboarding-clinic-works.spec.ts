import { test, expect, requireApi } from '../src/fixtures';
import { uniq } from '../src/env';

/**
 * A freshly onboarded clinic works end to end without a database of its own: onboarding no longer creates
 * clinical_mind_tenant_* (backend tests/test_onboarding_no_tenant_database.py checks pg_database).
 */

const ALLOW_LISTED_PHONE = '+919876543211'; // VERIFICATION_TEST_PHONES: onboarding skips phone.email
const PASSWORD = 'Password123!';

test.describe('a newly onboarded clinic', () => {
  requireApi();

  test('admin logs in, /auth/me names the clinic, a patient can be created', async ({ anon }) => {
    const slug = uniq('works').toLowerCase();
    const email = `admin.${slug}@example.com`;
    const onboarded = await anon.post('/api/v1/onboarding/complete', {
      data: {
        organization: {
          name: `Clinic ${slug}`, type: 'clinic', contact_email: `${slug}@example.com`, contact_phone: ALLOW_LISTED_PHONE,
          address_line1: '1 Road', city: 'Pune', state: 'MH', postal_code: '411001',
        },
        plan: { plan_type: 'basic', max_users: 5, max_patients: 100, max_sessions_per_month: 500 },
        admin: { email, password: PASSWORD, first_name: 'New', last_name: 'Admin', phone: ALLOW_LISTED_PHONE },
        admin_role: 'ADMIN',
        team_members: [],
      },
    });
    expect(onboarded.status(), await onboarded.text()).toBe(200);
    const tenantId = (await onboarded.json()).tenant_id;

    expect((await anon.post('/api/v1/auth/login', { data: { email, password: 'Wrong-pass1!' } })).status()).toBe(401);
    const login = await anon.post('/api/v1/auth/login', { data: { email, password: PASSWORD } });
    expect(login.status(), await login.text()).toBe(200);
    const headers = { Authorization: `Bearer ${(await login.json()).access_token}` };

    const me = await anon.get('/api/v1/auth/me', { headers });
    expect(me.status(), await me.text()).toBe(200);
    expect(await me.json()).toMatchObject({ email, role: 'ADMIN', tenant_id: tenantId });

    const patient = await anon.post('/api/v1/patients/', { headers, data: { first_name: 'First', last_name: slug } });
    expect(patient.status(), await patient.text()).toBe(200);
    const listed = await anon.get(`/api/v1/patients/?search=${slug}`, { headers });
    expect(listed.status()).toBe(200);
    expect((await listed.json()).patients.map((p: { id: string }) => p.id)).toContain((await patient.json()).id);
  });
});
