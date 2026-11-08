import { test, expect, requireApi } from '../src/fixtures';
import { uniq } from '../src/env';
import { ALLOW_LISTED_PHONE, CLINIC_PASSWORD, E2E_CLINIC, deleteClinic, loginAs } from '../src/clinics';

/**
 * Whoever registers a clinic always becomes its ADMIN, whatever role the request names (old clients still send
 * CLINICAL_DIRECTOR). An ADMIN is never bookable: an owner who also sees patients adds a second account.
 */
const payload = (slug: string, adminRole: string, team: Record<string, unknown>[] = []) => ({
  organization: {
    name: `${E2E_CLINIC} ${slug}`, type: 'clinic', contact_email: `${slug}@example.com`, contact_phone: ALLOW_LISTED_PHONE,
    address_line1: '1 Road', city: 'Pune', state: 'MH', postal_code: '411001',
  },
  plan: { plan_type: 'basic', max_users: 10, max_patients: 100, max_sessions_per_month: 500 },
  admin: { email: `owner.${slug}@example.com`, password: CLINIC_PASSWORD, first_name: 'Owner', last_name: 'E2E', phone: ALLOW_LISTED_PHONE },
  admin_role: adminRole,
  team_members: team,
});

const NO_CLINICIANS =
  'No clinical staff added. If you also see patients, add yourself under another email as a Psychologist or Therapist: an admin account cannot be booked';

test.describe('onboarding: the registrant is the ADMIN', () => {
  requireApi();
  const owners: string[] = [];
  test.afterAll(async () => {
    for (const owner of owners.splice(0)) await deleteClinic(owner); // afterAll runs per test (fullyParallel)
  });

  test('admin_role CLINICAL_DIRECTOR is ignored: the registrant is created as ADMIN and is not bookable', async ({ anon }) => {
    const slug = uniq('own').toLowerCase();
    const owner = `owner.${slug}@example.com`;
    const res = await anon.post('/api/v1/onboarding/complete', { data: payload(slug, 'CLINICAL_DIRECTOR') });
    expect(res.status(), await res.text()).toBe(200);
    owners.push(owner);
    expect((await res.json()).access_details.admin_credentials.role).toBe('ADMIN');

    const { ctx, user, tenant } = await loginAs(owner);
    expect(user.role).toBe('ADMIN');
    const me = await ctx.get('/api/v1/auth/me');
    expect(me.status(), await me.text()).toBe(200);
    expect((await me.json()).role).toBe('ADMIN');
    // the platform membership (Settings → Users & Permissions)
    const users = await ctx.get(`/api/v1/tenants/${tenant.id}/users`);
    expect(users.status(), await users.text()).toBe(200);
    expect((await users.json()).map((u: { email: string; role: string }) => [u.email, u.role])).toEqual([[owner, 'ADMIN']]);
    // the clinic database's membership: an ADMIN is not a clinician, so it cannot be put on a service
    const svc = await ctx.post('/api/v1/catalog/services', { data: { name: 'Therapy', duration_minutes: 50, price: 0, currency: 'INR' } });
    expect(svc.status(), await svc.text()).toBe(201);
    const put = await ctx.put(`/api/v1/catalog/services/${(await svc.json()).id}/clinicians`, { data: { clinician_ids: [user.id] } });
    expect(put.status(), await put.text()).toBe(422);
    expect((await put.json()).message).toBe('1 of the ids are not clinicians (psychologist, therapist, clinical director) of this clinic');
    await ctx.dispose();
  });

  test('validate ignores any admin role and warns an owner with no clinicians to add a clinical account', async ({ anon }) => {
    for (const role of ['CLINICAL_DIRECTOR', 'PATIENT', 'nonsense']) {
      const slug = uniq('own').toLowerCase();
      const res = await anon.post('/api/v1/onboarding/validate', { data: payload(slug, role) });
      expect(res.status(), await res.text()).toBe(200);
      const body = await res.json();
      expect(body.valid).toBe(true);
      expect(body.errors).toEqual([]);
      expect(body.warnings).toContain(NO_CLINICIANS);
    }
  });

  test('with a therapist on the team there is no missing-clinician warning', async ({ anon }) => {
    const slug = uniq('own').toLowerCase();
    const therapist = {
      email: `t.${slug}@example.com`, first_name: 'Team', last_name: 'Therapist', role: 'THERAPIST', license_number: 'RCI-E2E',
      temporary_password: CLINIC_PASSWORD, send_invitation: false,
    };
    const res = await anon.post('/api/v1/onboarding/validate', { data: payload(slug, 'ADMIN', [therapist]) });
    expect(res.status(), await res.text()).toBe(200);
    expect((await res.json()).warnings).not.toContain(NO_CLINICIANS);
  });
});
