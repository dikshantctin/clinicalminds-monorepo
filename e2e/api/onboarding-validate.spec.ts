import { test, expect, requireApi } from '../src/fixtures';
import { uniq } from '../src/env';

/** A payload /onboarding/validate accepts; each test breaks one part of it. */
const validPayload = () => {
  const id = uniq('onb');
  return {
    organization: {
      name: `E2E ${id} Clinic`,
      type: 'clinic',
      contact_email: `${id}@example.com`,
      contact_phone: '+91 98765 43210',
      address_line1: '1 Main Street',
      city: 'Pune',
      state: 'Maharashtra',
      postal_code: '411001',
      country: 'India',
    },
    plan: { plan_type: 'trial', max_users: 5, max_patients: 100, max_sessions_per_month: 500, features: {} },
    admin: {
      email: `${id}-admin@example.com`,
      password: 'Password123!',
      first_name: 'E2E',
      last_name: 'Admin',
      phone: '+919876543210',
    },
    team_members: [] as Record<string, unknown>[],
    admin_role: 'CLINICAL_DIRECTOR',
    timezone: 'Asia/Kolkata',
    language: 'en',
    currency: 'INR',
  };
};

/** Field paths named by the 422 body, e.g. "organization.contact_email". */
const invalidFields = async (res: import('@playwright/test').APIResponse): Promise<string[]> => {
  const body = await res.json();
  return (body.details as { loc: (string | number)[] }[]).map((d) => d.loc.slice(1).join('.'));
};

test.describe('POST /api/v1/onboarding/validate field rules', () => {
  requireApi();

  test('a well-formed payload is valid', async ({ anon }) => {
    const res = await anon.post('/api/v1/onboarding/validate', { data: validPayload() });
    expect(res.status(), await res.text()).toBe(200);
    expect((await res.json()).valid).toBe(true);
  });

  test('bad email and phone answer 422 naming each field', async ({ anon }) => {
    const data = validPayload();
    data.organization.contact_email = 'not-an-email';
    data.organization.contact_phone = '12345abcde';
    data.admin.email = 'admin-at-example.com';
    data.admin.phone = 'call me maybe';
    const res = await anon.post('/api/v1/onboarding/validate', { data });
    expect(res.status()).toBe(422);
    expect((await invalidFields(res)).sort()).toEqual(
      ['admin.email', 'admin.phone', 'organization.contact_email', 'organization.contact_phone'].sort(),
    );
  });

  test('a missing organization type answers 422 on organization.type', async ({ anon }) => {
    const data = validPayload() as ReturnType<typeof validPayload> & { organization: { type?: string } };
    delete data.organization.type;
    const res = await anon.post('/api/v1/onboarding/validate', { data });
    expect(res.status()).toBe(422);
    expect(await invalidFields(res)).toEqual(['organization.type']);
  });

  test('a team member with a bad email answers 422 on team_members.0.email', async ({ anon }) => {
    const data = validPayload();
    data.team_members = [
      { email: 'bad-email', first_name: 'Team', last_name: 'Member', role: 'INTERN', send_invitation: true },
    ];
    const res = await anon.post('/api/v1/onboarding/validate', { data });
    expect(res.status()).toBe(422);
    expect(await invalidFields(res)).toEqual(['team_members.0.email']);
  });
});
