import { request as pwRequest, APIRequestContext } from '@playwright/test';
import { test, expect, requireApi } from '../src/fixtures';
import { env, uniq } from '../src/env';
import { E2E_CLINIC, deleteClinic } from '../src/clinics';

/**
 * A token's role and clinic are re-read on every request: removing a staff member ends their session at
 * once, and a demotion takes effect at once, not when the JWT runs out. Removal and any role change also end
 * the person's "stay signed in" sign-ins at that clinic, so a refresh key from before never works again.
 */
const ALLOW_LISTED_PHONE = '+919876543211'; // VERIFICATION_TEST_PHONES: onboarding skips phone.email
const PASSWORD = 'Password123!';
const ENDED = { detail: 'Session no longer valid' };

const bearer = (token: string) =>
  pwRequest.newContext({ baseURL: env.API_URL, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
const login = async (anon: APIRequestContext, email: string) => {
  const res = await anon.post('/api/v1/auth/login', { data: { email, password: PASSWORD } });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
};
const roleIn = (token: string): string => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).role;

/** A clinic whose owner is ADMIN, with one team member of `role` who has a password. */
async function clinicWithMember(anon: APIRequestContext, role: string) {
  const slug = uniq('rc').toLowerCase();
  const owner = `owner.${slug}@example.com`;
  const member = `member.${slug}@example.com`;
  const res = await anon.post('/api/v1/onboarding/complete', {
    data: {
      organization: {
        name: `${E2E_CLINIC} ${slug}`, type: 'clinic', contact_email: `${slug}@example.com`, contact_phone: ALLOW_LISTED_PHONE,
        address_line1: '1 Road', city: 'Pune', state: 'MH', postal_code: '411001',
      },
      plan: { plan_type: 'basic', max_users: 5, max_patients: 100, max_sessions_per_month: 500 },
      admin: { email: owner, password: PASSWORD, first_name: 'Owner', last_name: 'Admin', phone: ALLOW_LISTED_PHONE },
      admin_role: 'ADMIN',
      team_members: [{
        email: member, role, first_name: 'Team', last_name: 'Member', phone: ALLOW_LISTED_PHONE,
        license_number: 'RCI-1', license_type: 'RCI', temporary_password: PASSWORD, send_invitation: false,
      }],
    },
  });
  expect(res.status(), await res.text()).toBe(200);
  const tenantId: string = (await res.json()).tenant_id;
  const o = await login(anon, owner);
  const ownerCtx = await bearer(o.access_token);
  const m = await login(anon, member);
  return {
    owner, ownerCtx, ownerKey: o.refresh_token as string, tenantId, member,
    memberId: m.user.id as string, memberToken: m.access_token as string, memberKey: m.refresh_token as string,
  };
}

test.describe('the role and clinic of a token are re-read per request', () => {
  requireApi();

  test("a removed staff member's existing token is refused at once, refresh included", async ({ anon }) => {
    const c = await clinicWithMember(anon, 'PSYCHOLOGIST');
    const member = await bearer(c.memberToken);
    try {
      expect((await member.get('/api/v1/patients/')).status()).toBe(200);

      const del = await c.ownerCtx.delete(`/api/v1/tenants/${c.tenantId}/users/${c.memberId}`);
      expect(del.status(), await del.text()).toBe(200);

      for (const [method, path] of [['get', '/api/v1/patients/'], ['get', '/api/v1/sessions/'], ['post', '/api/v1/auth/refresh-token']] as const) {
        const res = await member[method](path);
        expect(res.status(), `${method} ${path}`).toBe(401);
        expect(await res.json()).toEqual(ENDED);
      }
      // the sign-in cannot be renewed either (stay signed in)
      const renew = await anon.post('/api/v1/auth/session/refresh', { data: { refresh_token: c.memberKey } });
      expect(renew.status()).toBe(401);
      expect((await renew.json()).message).toBe('Session ended');
      // the clinic's own admin is unaffected
      expect((await c.ownerCtx.get('/api/v1/patients/')).status()).toBe(200);
    } finally {
      await member.dispose();
      await c.ownerCtx.dispose();
      await deleteClinic(c.owner);
    }
  });

  test("removal ends the member's sign-ins: invited back, the old refresh key still fails; the owner's works", async ({ anon }) => {
    const c = await clinicWithMember(anon, 'PSYCHOLOGIST');
    try {
      const del = await c.ownerCtx.delete(`/api/v1/tenants/${c.tenantId}/users/${c.memberId}`);
      expect(del.status(), await del.text()).toBe(200);
      const back = await c.ownerCtx.post(`/api/v1/tenants/${c.tenantId}/invite`, {
        data: { email: c.member, role: 'THERAPIST', first_name: 'Team', last_name: 'Member' },
      });
      expect(back.status(), await back.text()).toBe(200);

      // the key from before the removal was ended at removal, not only refused while removed
      const old = await anon.post('/api/v1/auth/session/refresh', { data: { refresh_token: c.memberKey } });
      expect(old.status(), await old.text()).toBe(401);
      expect((await old.json()).message).toBe('Session ended');
      // signing in again works, with the new role
      expect((await login(anon, c.member)).user.role).toBe('THERAPIST');
      // another person's sign-in at the same clinic is untouched
      const owner = await anon.post('/api/v1/auth/session/refresh', { data: { refresh_token: c.ownerKey } });
      expect(owner.status(), await owner.text()).toBe(200);
    } finally {
      await c.ownerCtx.dispose();
      await deleteClinic(c.owner);
    }
  });

  test('a demoted ADMIN loses admin rights on the existing token, and their sign-ins end', async ({ anon }) => {
    const c = await clinicWithMember(anon, 'ADMIN');
    const member = await bearer(c.memberToken);
    try {
      const patient = await c.ownerCtx.post('/api/v1/patients/', { data: { first_name: uniq('Recheck'), last_name: 'Patient' } });
      expect(patient.status(), await patient.text()).toBe(200);
      const patientId = (await patient.json()).id;

      // ?role= for today's route, the body for the staff-invite one (#68)
      const put = await c.ownerCtx.put(`/api/v1/tenants/${c.tenantId}/users/${c.memberId}/role`, {
        params: { role: 'THERAPIST' }, data: { role: 'THERAPIST' },
      });
      expect(put.status(), await put.text()).toBe(200);

      const del = await member.delete(`/api/v1/patients/${patientId}`);
      expect(del.status(), await del.text()).toBe(403);
      expect((await del.json()).message).toBe('Insufficient permissions. Required: delete_patients');
      expect((await member.get('/api/v1/patients/')).status()).toBe(200); // still a THERAPIST here

      // the role change ended the sign-in: neither refresh works; signing in again gives the new role
      expect((await member.post('/api/v1/auth/refresh-token')).status()).toBe(401);
      const renewed = await anon.post('/api/v1/auth/session/refresh', { data: { refresh_token: c.memberKey } });
      expect(renewed.status(), await renewed.text()).toBe(401);
      expect((await renewed.json()).message).toBe('Session ended');
      expect(roleIn((await login(anon, c.member)).access_token)).toBe('THERAPIST');
      // the admin who made the change keeps their own sign-in
      const owner = await anon.post('/api/v1/auth/session/refresh', { data: { refresh_token: c.ownerKey } });
      expect(owner.status(), await owner.text()).toBe(200);
    } finally {
      await member.dispose();
      await c.ownerCtx.dispose();
      await deleteClinic(c.owner);
    }
  });
});
