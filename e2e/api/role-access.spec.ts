import { request as pwRequest, APIRequestContext, APIResponse } from '@playwright/test';
import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { env, uniq, RANDOM_UUID, DEMO_THERAPIST, DEMO_PSYCHOLOGIST, DEMO_PATIENT } from '../src/env';

/**
 * Role-based access, table-driven: every row asserts ONE exact status. A failing row is a real
 * authorization bug (or a missing seed user), never something to widen into "200 or 403".
 */

type Creds = { email: string; password: string };
type Session = { ctx: APIRequestContext; userId: string; tenantId: string };

/** Logs in through the API and returns a request context that sends what the frontend sends. */
async function loginAs(creds: Creds): Promise<Session> {
  const anon = await pwRequest.newContext({ baseURL: env.API_URL });
  const res = await anon.post('/api/v1/auth/login', { data: creds });
  const text = await res.text();
  await anon.dispose();
  expect(res.status(), `login as ${creds.email} (seeded by backend/scripts/setup_demo_data.py?): ${text}`).toBe(200);
  const body = JSON.parse(text);
  const ctx = await pwRequest.newContext({
    baseURL: env.API_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${body.access_token}`, 'X-Tenant-ID': body.tenant.id },
  });
  return { ctx, userId: body.user.id, tenantId: body.tenant.id };
}

type Method = 'get' | 'post' | 'put' | 'delete';
interface Row { method: Method; path: string; data?: unknown; expected: number }

const send = (ctx: APIRequestContext, { method, path, data }: Row): Promise<APIResponse> =>
  method === 'get' || method === 'delete' ? ctx[method](path) : ctx[method](path, { data: data ?? {} });

test.describe('role access: no token', () => {
  requireApi();

  const rows: Row[] = [
    { method: 'get', path: '/api/v1/patients/', expected: 401 },
    { method: 'post', path: '/api/v1/kanban/boards', data: { name: 'x' }, expected: 401 },
    { method: 'put', path: `/api/v1/teams/teams/${RANDOM_UUID}`, data: { description: 'x' }, expected: 401 },
    { method: 'post', path: `/api/v1/patients/${RANDOM_UUID}/invite`, data: { email: 'x@example.com' }, expected: 401 },
  ];
  for (const row of rows) {
    test(`${row.method.toUpperCase()} ${row.path} → ${row.expected}`, async ({ anon }) => {
      const res = await send(anon, row);
      expect(res.status(), await res.text()).toBe(row.expected);
    });
  }
});

test.describe('role access: PATIENT is kept out of staff areas', () => {
  requireApi();
  requireAuth();

  const rows: Row[] = [
    { method: 'get', path: '/api/v1/kanban/boards', expected: 403 },
    { method: 'post', path: '/api/v1/kanban/boards', data: { name: 'patient board' }, expected: 403 },
    { method: 'get', path: '/api/v1/kanban/tasks', expected: 403 },
    { method: 'get', path: '/api/v1/kanban/notifications', expected: 403 },
    { method: 'post', path: '/api/v1/kanban/notifications/mark-all-read', expected: 403 },
    { method: 'get', path: '/api/v1/kanban/followups', expected: 403 },
    { method: 'get', path: '/api/v1/teams/teams', expected: 403 },
    { method: 'get', path: '/api/v1/teams/users', expected: 403 },
    { method: 'put', path: `/api/v1/teams/teams/${RANDOM_UUID}`, data: { description: 'x' }, expected: 403 },
    { method: 'get', path: '/api/v1/patients/', expected: 403 },
  ];
  for (const row of rows) {
    test(`PATIENT ${row.method.toUpperCase()} ${row.path} → ${row.expected}`, async () => {
      const patient = await loginAs(DEMO_PATIENT);
      try {
        const res = await send(patient.ctx, row);
        expect(res.status(), await res.text()).toBe(row.expected);
      } finally {
        await patient.ctx.dispose();
      }
    });
  }
});

test.describe('role access: staff positive controls', () => {
  requireApi();
  requireAuth();

  const paths = ['/api/v1/kanban/boards', '/api/v1/kanban/tasks', '/api/v1/kanban/notifications', '/api/v1/teams/teams', '/api/v1/patients/'];
  for (const [role, creds] of [['THERAPIST', DEMO_THERAPIST], ['PSYCHOLOGIST', DEMO_PSYCHOLOGIST]] as const) {
    test(`${role} GET ${paths.join(', ')} → 200`, async () => {
      const s = await loginAs(creds);
      try {
        for (const path of paths) {
          const res = await s.ctx.get(path);
          expect(res.status(), `${role} ${path}: ${await res.text()}`).toBe(200);
        }
      } finally {
        await s.ctx.dispose();
      }
    });
  }

  test(`ADMIN GET ${paths.join(', ')} → 200`, async ({ api }) => {
    for (const path of paths) {
      const res = await api.get(path);
      expect(res.status(), `${path}: ${await res.text()}`).toBe(200);
    }
  });
});

test.describe('role access: a THERAPIST cannot manage a team they do not lead', () => {
  requireApi();
  requireAuth();

  test('PUT team → 403, remove another member → 403, remove self → 200; the admin creator can do both', async ({ api }) => {
    const therapist = await loginAs(DEMO_THERAPIST);
    const psych = await loginAs(DEMO_PSYCHOLOGIST);
    await psych.ctx.dispose();
    const created = await api.post('/api/v1/teams/teams', {
      data: { name: uniq('RoleTeam'), description: 'e2e role-access', team_type: 'CLINICAL', color: '#3B82F6', max_members: 10 },
    });
    expect(created.status(), await created.text()).toBe(200);
    const team = await created.json();
    try {
      for (const userId of [therapist.userId, psych.userId]) {
        const add = await api.post(`/api/v1/teams/teams/${team.id}/members`, { data: { user_id: userId, role: 'MEMBER' } });
        expect(add.status(), await add.text()).toBe(200);
      }

      const put = await therapist.ctx.put(`/api/v1/teams/teams/${team.id}`, { data: { description: 'hijacked by a therapist' } });
      expect(put.status(), await put.text()).toBe(403);
      expect((await (await api.get(`/api/v1/teams/teams/${team.id}`)).json()).description).toBe('e2e role-access');

      const addMember = await therapist.ctx.post(`/api/v1/teams/teams/${team.id}/members`, { data: { user_id: RANDOM_UUID, role: 'MEMBER' } });
      expect(addMember.status(), await addMember.text()).toBe(403);

      const removeOther = await therapist.ctx.delete(`/api/v1/teams/teams/${team.id}/members/${psych.userId}`);
      expect(removeOther.status(), await removeOther.text()).toBe(403);

      const removeSelf = await therapist.ctx.delete(`/api/v1/teams/teams/${team.id}/members/${therapist.userId}`);
      expect(removeSelf.status(), await removeSelf.text()).toBe(200);

      const adminPut = await api.put(`/api/v1/teams/teams/${team.id}`, { data: { description: 'updated by admin' } });
      expect(adminPut.status(), await adminPut.text()).toBe(200);
      const adminRemove = await api.delete(`/api/v1/teams/teams/${team.id}/members/${psych.userId}`);
      expect(adminRemove.status(), await adminRemove.text()).toBe(200);
    } finally {
      await therapist.ctx.dispose();
      expect((await api.delete(`/api/v1/teams/teams/${team.id}`)).status()).toBe(200);
    }
  });
});

test.describe('role access: patient invite never hands out the set-password token', () => {
  requireApi();
  requireAuth();

  test('POST /patients/{id}/invite answers without a token', async ({ api }) => {
    const created = await api.post('/api/v1/patients/', { data: { first_name: uniq('Invite'), last_name: 'Patient' } });
    expect(created.status(), await created.text()).toBe(200);
    const patient = await created.json();
    const email = `${uniq('invite')}@example.com`.toLowerCase();
    try {
      const res = await api.post(`/api/v1/patients/${patient.id}/invite`, { data: { email, first_name: 'Invite', last_name: 'Patient' } });
      const text = await res.text();
      // the token travels only by email: no `token` field, nothing JWT-shaped anywhere in the body
      expect(text).not.toMatch(/"token"/i);
      expect(text).not.toMatch(/eyJ[\w-]+\.[\w-]+\.[\w-]+/);
      // 200 when SMTP is configured, 503 when it is not (the UI must not claim "sent"); both bodies are exact
      if (res.status() === 200) {
        expect(JSON.parse(text)).toEqual({ message: 'Invitation sent', email });
      } else {
        expect(res.status(), text).toBe(503);
        expect(JSON.parse(text).message ?? JSON.parse(text).detail).toBe('Invitation email could not be sent');
      }
    } finally {
      await api.delete(`/api/v1/patients/${patient.id}`);
    }
  });
});

test.describe('role access: tenant comes from the JWT only', () => {
  requireApi();
  requireAuth();

  const foreign: Row[] = [
    { method: 'get', path: `/api/v1/tenants/${RANDOM_UUID}`, expected: 403 },
    { method: 'get', path: `/api/v1/tenants/${RANDOM_UUID}/users`, expected: 403 },
    { method: 'get', path: `/api/v1/tenants/${RANDOM_UUID}/features`, expected: 403 },
    { method: 'get', path: `/api/v1/tenants/${RANDOM_UUID}/branding`, expected: 403 },
    { method: 'put', path: `/api/v1/tenants/${RANDOM_UUID}/settings`, data: { settings: {} }, expected: 403 },
  ];
  for (const row of foreign) {
    test(`ADMIN ${row.method.toUpperCase()} ${row.path} (foreign tenant) → 403`, async ({ api }) => {
      const res = await send(api, row);
      expect(res.status(), await res.text()).toBe(row.expected);
    });
  }

  test('X-Tenant-ID cannot override the JWT tenant', async ({ auth, api }) => {
    const spoofed = await pwRequest.newContext({
      baseURL: env.API_URL,
      extraHTTPHeaders: { Authorization: `Bearer ${auth.token}`, 'X-Tenant-ID': RANDOM_UUID },
    });
    try {
      // the header does not unlock the tenant it names…
      const foreignRes = await spoofed.get(`/api/v1/tenants/${RANDOM_UUID}`);
      expect(foreignRes.status(), await foreignRes.text()).toBe(403);
      // …the caller still acts in their own tenant…
      const own = await spoofed.get(`/api/v1/tenants/${auth.tenantId}`);
      expect(own.status(), await own.text()).toBe(200);
      expect((await own.json()).id).toBe(auth.tenantId);
      // …and data written with a spoofed header lands in the JWT tenant
      const created = await spoofed.post('/api/v1/patients/', { data: { first_name: uniq('Spoof'), last_name: 'Patient' } });
      expect(created.status(), await created.text()).toBe(200);
      const patient = await created.json();
      try {
        const read = await api.get(`/api/v1/patients/${patient.id}`);
        expect(read.status(), await read.text()).toBe(200);
      } finally {
        await api.delete(`/api/v1/patients/${patient.id}`);
      }
    } finally {
      await spoofed.dispose();
    }
  });
});

test.describe('role access: clinicians see only patients assigned to them', () => {
  requireApi();
  requireAuth();

  test('unassigned → 403 and not listed; once assigned → 200 and listed; a colleague still → 403', async ({ api }) => {
    const created = await api.post('/api/v1/patients/', { data: { first_name: uniq('Scope'), last_name: 'Patient' } });
    expect(created.status(), await created.text()).toBe(200);
    const patient = await created.json();
    const therapist = await loginAs(DEMO_THERAPIST);
    const psychologist = await loginAs(DEMO_PSYCHOLOGIST);
    const listedIds = async (s: Session) =>
      ((await (await s.ctx.get('/api/v1/patients/?limit=1000')).json()).patients as { id: string }[]).map((p) => p.id);
    try {
      expect((await therapist.ctx.get(`/api/v1/patients/${patient.id}`)).status()).toBe(403);
      expect(await listedIds(therapist)).not.toContain(patient.id);

      const assigned = await api.put(`/api/v1/patients/${patient.id}`, { data: { assigned_therapist_id: therapist.userId } });
      expect(assigned.status(), await assigned.text()).toBe(200);

      expect((await therapist.ctx.get(`/api/v1/patients/${patient.id}`)).status()).toBe(200);
      expect(await listedIds(therapist)).toContain(patient.id);
      expect((await psychologist.ctx.get(`/api/v1/patients/${patient.id}`)).status()).toBe(403);
      expect(await listedIds(psychologist)).not.toContain(patient.id);
    } finally {
      await therapist.ctx.dispose();
      await psychologist.ctx.dispose();
      await api.delete(`/api/v1/patients/${patient.id}`);
    }
  });
});
