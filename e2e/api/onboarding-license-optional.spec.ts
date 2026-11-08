import { test, expect, requireApi } from '../src/fixtures';
import { uniq } from '../src/env';
import { ALLOW_LISTED_PHONE, CLINIC_PASSWORD, E2E_CLINIC, deleteClinic, loginAs } from '../src/clinics';

/** A license number is optional for every role: not every therapist or psychologist holds one. */
const payload = (slug: string, team: Record<string, unknown>[]) => ({
  organization: {
    name: `${E2E_CLINIC} ${slug}`, type: 'clinic', contact_email: `${slug}@example.com`, contact_phone: ALLOW_LISTED_PHONE,
    address_line1: '1 Road', city: 'Pune', state: 'MH', postal_code: '411001',
  },
  plan: { plan_type: 'basic', max_users: 10, max_patients: 100, max_sessions_per_month: 500 },
  admin: { email: `owner.${slug}@example.com`, password: CLINIC_PASSWORD, first_name: 'Owner', last_name: 'E2E', phone: ALLOW_LISTED_PHONE },
  admin_role: 'ADMIN',
  team_members: team,
});

const member = (slug: string, role: string, extra: Record<string, unknown> = {}) => ({
  email: `${role.toLowerCase()}.${slug}@example.com`, first_name: 'Team', last_name: role, role, phone: ALLOW_LISTED_PHONE,
  temporary_password: CLINIC_PASSWORD, send_invitation: false, ...extra,
});

test.describe('onboarding: license number is optional', () => {
  requireApi();
  const owners: string[] = [];
  test.afterAll(async () => {
    for (const owner of owners) await deleteClinic(owner);
  });

  test('validate accepts a therapist with no license and a psychologist with an empty one', async ({ anon }) => {
    const slug = uniq('lic').toLowerCase();
    const res = await anon.post('/api/v1/onboarding/validate', {
      data: payload(slug, [member(slug, 'THERAPIST'), member(slug, 'PSYCHOLOGIST', { license_number: '' })]),
    });
    expect(res.status(), await res.text()).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(true);
    expect(body.errors).toEqual([]);
  });

  test('complete creates a therapist and a psychologist with no license; a given license is still saved', async ({ anon }) => {
    const slug = uniq('lic').toLowerCase();
    const team = [
      member(slug, 'THERAPIST'),
      member(slug, 'PSYCHOLOGIST', { license_number: '' }),
      member(slug, 'INTERN', { license_number: 'RCI-123' }),
    ];
    const res = await anon.post('/api/v1/onboarding/complete', { data: payload(slug, team) });
    expect(res.status(), await res.text()).toBe(200);
    owners.push(`owner.${slug}@example.com`);

    const expected: Record<string, string | null> = { THERAPIST: null, PSYCHOLOGIST: null, INTERN: 'RCI-123' };
    for (const m of team) {
      const { ctx } = await loginAs(m.email);
      const me = await ctx.get('/api/v1/users/me');
      expect(me.status(), await me.text()).toBe(200);
      const profile = await me.json();
      expect(profile.role).toBe(m.role);
      expect(profile.license_number ?? null).toBe(expected[m.role]);
      await ctx.dispose();
    }
  });

  test('a license longer than 100 characters is still refused with 422 on that field', async ({ anon }) => {
    const slug = uniq('lic').toLowerCase();
    const res = await anon.post('/api/v1/onboarding/validate', {
      data: payload(slug, [member(slug, 'THERAPIST', { license_number: 'L'.repeat(101) })]),
    });
    expect(res.status()).toBe(422);
    const body = await res.json();
    expect((body.details as { loc: (string | number)[] }[]).map((d) => d.loc.slice(1).join('.'))).toEqual([
      'team_members.0.license_number',
    ]);
  });
});
