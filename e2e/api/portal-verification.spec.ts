import { request as pwRequest, APIRequestContext } from '@playwright/test';
import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { env, uniq, UNVERIFIED_USER } from '../src/env';
import { inviteTokenFor } from '../src/outbox';

/**
 * The phone.email gate (403 verification_required) and portal patients. An invited PATIENT proved
 * their email through the set-password link; they are not asked for a phone. Staff still need both.
 */

const PASSWORD = 'Password123!';

async function loginContext(email: string, password: string, audience?: 'patient') {
  const anon = await pwRequest.newContext({ baseURL: env.API_URL });
  const res = await anon.post('/api/v1/auth/login', { data: audience ? { email, password, audience } : { email, password } });
  expect(res.status(), await res.text()).toBe(200);
  const body = await res.json();
  await anon.dispose();
  const ctx = await pwRequest.newContext({
    baseURL: env.API_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${body.access_token}`, 'X-Tenant-ID': body.tenant.id },
  });
  return { ctx, body };
}

async function createPatient(api: APIRequestContext): Promise<string> {
  const res = await api.post('/api/v1/patients/', { data: { first_name: uniq('Gate'), last_name: 'Patient' } });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).id;
}

test.describe('verification gate: portal patients', () => {
  requireApi();
  requireAuth();

  test('an invited patient with no verified phone can use the portal', async ({ api }) => {
    const patientId = await createPatient(api);
    const email = `${uniq('gate')}@example.com`.toLowerCase();
    try {
      const inv = await api.post(`/api/v1/patients/${patientId}/invite`, { data: { email, first_name: 'Gate', last_name: 'Patient' } });
      expect(inv.status(), await inv.text()).toBe(200);
      const set = await api.post('/api/v1/patients/set-password', { data: { token: inviteTokenFor(email), password: PASSWORD } });
      expect(set.status(), await set.text()).toBe(200);

      const { ctx, body } = await loginContext(email, PASSWORD, 'patient');
      try {
        expect(body.user.role).toBe('PATIENT');
        const me = await (await ctx.get('/api/v1/auth/me')).json();
        // the claims stay truthful: email proven by the link, phone never verified
        expect(me).toEqual(expect.objectContaining({ role: 'PATIENT', email_verified: true, phone_verified: false }));

        const sessions = await ctx.get('/api/v1/sessions/');
        expect(sessions.status(), await sessions.text()).toBe(200);
        expect(await sessions.json()).toEqual(expect.objectContaining({ sessions: [], total: 0 }));

        // the exemption is from the phone gate only, not from the staff-only routers
        const boards = await ctx.get('/api/v1/kanban/boards');
        expect(boards.status()).toBe(403);
        expect((await boards.json()).message).toMatch(/^Access denied\. Required roles: /);
      } finally {
        await ctx.dispose();
      }
    } finally {
      await api.delete(`/api/v1/patients/${patientId}`);
    }
  });

  test('a staff member with an unverified phone is still blocked', async () => {
    const { ctx, body } = await loginContext(UNVERIFIED_USER.email, UNVERIFIED_USER.password);
    try {
      expect(body.user.role).not.toBe('PATIENT');
      expect(body.user.phone_verified).toBe(false);
      const res = await ctx.get('/api/v1/sessions/');
      expect(res.status()).toBe(403);
      expect(await res.json()).toEqual({ detail: 'verification_required' });
    } finally {
      await ctx.dispose();
    }
  });
});
