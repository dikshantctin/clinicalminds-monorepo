import { request as pwRequest, APIRequestContext } from '@playwright/test';
import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { env, uniq, DEMO_THERAPIST } from '../src/env';
import { inviteTokenFor } from '../src/outbox';

/**
 * One clinic can never reach another's rows: the tenant always comes from the JWT (a spoofed
 * X-Tenant-ID is ignored), purpose tokens (invite / reset / verification) are not login tokens,
 * and a team only takes members from its own clinic.
 */

const ALLOW_LISTED_PHONE = '+919876543211'; // VERIFICATION_TEST_PHONES: onboarding skips phone.email
const PASSWORD = 'Password123!';

interface Foreign { ctx: APIRequestContext; tenantId: string; adminId: string; sessionDay: string; patientName: string }

/** A second clinic with one patient and one session, so a leak has something to show. */
async function onboardForeignClinic(anon: APIRequestContext): Promise<Foreign> {
  const slug = uniq('iso').toLowerCase();
  const res = await anon.post('/api/v1/onboarding/complete', {
    data: {
      organization: {
        name: `Clinic ${slug}`, type: 'clinic', contact_email: `${slug}@example.com`, contact_phone: ALLOW_LISTED_PHONE,
        address_line1: '1 Road', city: 'Pune', state: 'MH', postal_code: '411001',
      },
      plan: { plan_type: 'basic', max_users: 5, max_patients: 100, max_sessions_per_month: 500 },
      admin: { email: `admin.${slug}@example.com`, password: PASSWORD, first_name: 'Other', last_name: 'Admin', phone: ALLOW_LISTED_PHONE },
      admin_role: 'ADMIN',
      team_members: [],
    },
  });
  expect(res.status(), await res.text()).toBe(200);
  const login = await anon.post('/api/v1/auth/login', { data: { email: `admin.${slug}@example.com`, password: PASSWORD } });
  expect(login.status(), await login.text()).toBe(200);
  const { access_token, tenant, user } = await login.json();
  const ctx = await pwRequest.newContext({
    baseURL: env.API_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${access_token}`, 'X-Tenant-ID': tenant.id },
  });
  const first = uniq('Foreign');
  const patient = await ctx.post('/api/v1/patients/', { data: { first_name: first, last_name: 'Patient' } });
  expect(patient.status(), await patient.text()).toBe(200);
  const sessionDay = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  const session = await ctx.post('/api/v1/sessions/', {
    data: { patient_id: (await patient.json()).id, scheduled_at: `${sessionDay}T10:00:00+05:30`, duration_minutes: 50 },
  });
  expect(session.status(), await session.text()).toBe(200);
  return { ctx, tenantId: tenant.id, adminId: user.id, sessionDay, patientName: `${first} Patient` };
}

test.describe('tenant and token isolation', () => {
  requireApi();
  requireAuth();
  test.describe.configure({ mode: 'serial' });

  let foreign: Foreign;
  test.beforeAll(async () => {
    const anon = await pwRequest.newContext({ baseURL: env.API_URL });
    foreign = await onboardForeignClinic(anon);
    await anon.dispose();
  });
  test.afterAll(async () => {
    await foreign?.ctx.dispose();
  });

  test("a spoofed X-Tenant-ID does not show another clinic's schedule", async ({ auth }) => {
    // the foreign clinic sees its own session
    const own = await (await foreign.ctx.get('/api/v1/schedules/daily', { params: { schedule_date: foreign.sessionDay } })).json();
    expect(own.sessions.map((s: { patientName: string }) => s.patientName)).toContain(foreign.patientName);

    const spoof = await pwRequest.newContext({
      baseURL: env.API_URL,
      extraHTTPHeaders: { Authorization: `Bearer ${auth.token}`, 'X-Tenant-ID': foreign.tenantId },
    });
    try {
      for (const path of ['/api/v1/schedules/daily', '/api/v1/schedules/weekly']) {
        const res = await spoof.get(path, { params: { schedule_date: foreign.sessionDay, week_start: foreign.sessionDay } });
        expect(res.status(), await res.text()).toBe(200);
        expect(JSON.stringify(await res.json())).not.toContain(foreign.patientName);
      }
      const stats = await spoof.get('/api/v1/schedules/stats');
      expect(stats.status(), await stats.text()).toBe(200);
    } finally {
      await spoof.dispose();
    }
  });

  test('a patient invite token is not a login token (401)', async ({ api, anon }) => {
    const patient = await (await api.post('/api/v1/patients/', { data: { first_name: uniq('InviteTok'), last_name: 'Patient' } })).json();
    const email = `${uniq('invtok')}@example.com`.toLowerCase();
    const inv = await api.post(`/api/v1/patients/${patient.id}/invite`, { data: { email, first_name: 'Invite', last_name: 'Token' } });
    expect(inv.status(), await inv.text()).toBe(200);
    const token = inviteTokenFor(email);

    for (const path of ['/api/v1/auth/me', '/api/v1/patients/', '/api/v1/schedules/daily']) {
      const res = await anon.get(path, { headers: { Authorization: `Bearer ${token}` } });
      expect(res.status(), `${path}: ${await res.text()}`).toBe(401);
    }
  });

  test("a team refuses a member from another clinic (404); the clinic's own staff still join", async ({ api }) => {
    const team = await (await api.post('/api/v1/teams/teams', {
      data: { name: uniq('IsoTeam'), description: 'e2e', team_type: 'CLINICAL', color: '#3B82F6', max_members: 10 },
    })).json();
    try {
      const foreignAdd = await api.post(`/api/v1/teams/teams/${team.id}/members`, { data: { user_id: foreign.adminId, role: 'MEMBER' } });
      expect(foreignAdd.status(), await foreignAdd.text()).toBe(404);
      const members = await (await api.get(`/api/v1/teams/teams/${team.id}`)).json();
      expect(JSON.stringify(members)).not.toContain(foreign.adminId);

      const staff = (await (await api.get('/api/v1/teams/users')).json()) as { id: string; email: string }[] | { users: { id: string; email: string }[] };
      const list = Array.isArray(staff) ? staff : staff.users;
      const therapistId = list.find((u) => u.email === DEMO_THERAPIST.email)?.id;
      expect(therapistId, 'demo therapist is listed as clinic staff').toBeTruthy();
      const ownAdd = await api.post(`/api/v1/teams/teams/${team.id}/members`, { data: { user_id: therapistId, role: 'MEMBER' } });
      expect(ownAdd.status(), await ownAdd.text()).toBe(200);
    } finally {
      await api.delete(`/api/v1/teams/teams/${team.id}`);
    }
  });
});
