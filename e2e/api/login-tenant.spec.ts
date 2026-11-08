import { createHmac } from 'node:crypto';
import { request as pwRequest, APIRequestContext } from '@playwright/test';
import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { env, uniq, RANDOM_UUID } from '../src/env';
import { E2E_CLINIC, deleteClinic } from '../src/clinics';

/**
 * POST /auth/login with a tenant_id: the token is for that clinic only when the account has an active
 * mapping there, and carries that mapping's role. Anything else is 403 with a fixed message.
 */
const ALLOW_LISTED_PHONE = '+919876543211'; // VERIFICATION_TEST_PHONES: onboarding skips phone.email
const PASSWORD = 'Password123!';
const REFUSED = 'No access to this clinic';

const onboard = async (
  anon: APIRequestContext, adminEmail: string, team: { email: string; role: string }[] = [],
): Promise<string> => {
  const slug = uniq('lt').toLowerCase();
  const res = await anon.post('/api/v1/onboarding/complete', {
    data: {
      organization: {
        name: `${E2E_CLINIC} ${slug}`, type: 'clinic', contact_email: `${slug}@example.com`, contact_phone: ALLOW_LISTED_PHONE,
        address_line1: '1 Road', city: 'Pune', state: 'MH', postal_code: '411001',
      },
      plan: { plan_type: 'basic', max_users: 5, max_patients: 100, max_sessions_per_month: 500 },
      admin: { email: adminEmail, password: PASSWORD, first_name: 'Login', last_name: 'Tenant', phone: ALLOW_LISTED_PHONE },
      admin_role: 'ADMIN',
      team_members: team.map((m) => ({ ...m, first_name: 'Team', last_name: 'Member', send_invitation: false })),
    },
  });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).tenant_id;
};

const bearer = (token: string) =>
  pwRequest.newContext({ baseURL: env.API_URL, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });

/** An HS256 JWT signed with a key that is not the server's. */
const forged = (payload: Record<string, unknown>) => {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}`;
  return `${body}.${createHmac('sha256', 'not-the-server-key').update(body).digest('base64url')}`;
};

test.describe('login picks the clinic only from an active membership', () => {
  requireApi();
  requireAuth();

  test("a user of another clinic asking for this clinic's tenant_id is 403, and nothing of it is readable", async ({ anon }) => {
    const owner = `owner.${uniq('lt').toLowerCase()}@example.com`;
    const tenantB = await onboard(anon, owner);
    try {
      const res = await anon.post('/api/v1/auth/login', { data: { email: env.EMAIL, password: env.PASSWORD, tenant_id: tenantB } });
      expect(res.status(), await res.text()).toBe(403);
      const text = await res.text();
      expect(JSON.parse(text).message).toBe(REFUSED);
      expect(text).not.toContain(tenantB);

      for (const bad of [RANDOM_UUID, 'not-a-uuid']) {
        const other = await anon.post('/api/v1/auth/login', { data: { email: env.EMAIL, password: env.PASSWORD, tenant_id: bad } });
        expect(other.status(), `tenant_id ${bad}`).toBe(403);
        expect((await other.json()).message).toBe(REFUSED);
      }
    } finally {
      await deleteClinic(owner);
    }
  });

  test("a member of two clinics gets each clinic's token with that clinic's role", async ({ anon }) => {
    const x = `x.${uniq('lt').toLowerCase()}@example.com`;
    const y = `y.${uniq('lt').toLowerCase()}@example.com`;
    const tenantA = await onboard(anon, x); // x registers A: its ADMIN (primary)
    let tenantB = '';
    try {
      tenantB = await onboard(anon, y, [{ email: x, role: 'SUPPORT_STAFF' }]); // x: front desk of B (sees every patient)
      const xLogin = await (await anon.post('/api/v1/auth/login', { data: { email: x, password: PASSWORD } })).json();
      const xCtx = await bearer(xLogin.access_token);
      expect((await xCtx.post('/api/v1/patients/', { data: { first_name: uniq('OnlyInA'), last_name: 'Patient' } })).status()).toBe(200);
      await xCtx.dispose();
      const yLogin = await (await anon.post('/api/v1/auth/login', { data: { email: y, password: PASSWORD } })).json();
      const yCtx = await bearer(yLogin.access_token);
      const patientB = uniq('OnlyInB');
      expect((await yCtx.post('/api/v1/patients/', { data: { first_name: patientB, last_name: 'Patient' } })).status()).toBe(200);
      await yCtx.dispose();

      const inB = await anon.post('/api/v1/auth/login', { data: { email: x, password: PASSWORD, tenant_id: tenantB } });
      expect(inB.status(), await inB.text()).toBe(200);
      const b = await inB.json();
      expect([b.tenant.id, b.user.role]).toEqual([tenantB, 'SUPPORT_STAFF']);
      const xb = await bearer(b.access_token);
      try {
        const names = ((await (await xb.get('/api/v1/patients/')).json()).patients as { first_name: string }[]).map((p) => p.first_name);
        expect(names).toEqual([patientB]);
      } finally {
        await xb.dispose();
      }

      const inA = await (await anon.post('/api/v1/auth/login', { data: { email: x, password: PASSWORD, tenant_id: tenantA } })).json();
      expect([inA.tenant.id, inA.user.role]).toEqual([tenantA, 'ADMIN']);
      const primary = await (await anon.post('/api/v1/auth/login', { data: { email: x, password: PASSWORD } })).json();
      expect([primary.tenant.id, primary.user.role]).toEqual([tenantA, 'ADMIN']);
    } finally {
      if (tenantB) await deleteClinic(y); // B first: x still belongs to A, so B's delete keeps x
      await deleteClinic(x);
    }
  });

  test('a JWT not signed by the server is 401 on clinical routes, whatever tenant it names', async ({ auth }) => {
    const token = forged({
      user_id: auth.user?.id ?? RANDOM_UUID, email: env.EMAIL, role: 'ADMIN', tenant_id: auth.tenantId,
      email_verified: true, phone_verified: true, exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const ctx = await bearer(token);
    try {
      const res = await ctx.get('/api/v1/patients/');
      expect(res.status(), await res.text()).toBe(401);
    } finally {
      await ctx.dispose();
    }
  });
});
