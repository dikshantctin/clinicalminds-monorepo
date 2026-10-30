import { request as pwRequest, APIRequestContext } from '@playwright/test';
import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { env, uniq, DEMO_THERAPIST, DEMO_PSYCHOLOGIST, DEMO_PATIENT } from '../src/env';

/**
 * GET /sessions/{id}/payments shows amounts, so it follows the dashboard's money rule
 * (ADMIN / CLINICAL_DIRECTOR see every session's payments) and the session scope rule
 * (a clinician sees the payments of their OWN sessions only). Patients never see it.
 */

type Session = { ctx: APIRequestContext; userId: string };

async function loginAs(creds: { email: string; password: string }, audience: 'staff' | 'patient' = 'staff'): Promise<Session> {
  const anon = await pwRequest.newContext({ baseURL: env.API_URL });
  const res = await anon.post('/api/v1/auth/login', { data: { ...creds, audience } });
  const text = await res.text();
  await anon.dispose();
  expect(res.status(), `login as ${creds.email}: ${text}`).toBe(200);
  const body = JSON.parse(text);
  const ctx = await pwRequest.newContext({
    baseURL: env.API_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${body.access_token}`, 'X-Tenant-ID': body.tenant.id },
  });
  return { ctx, userId: body.user.id };
}

const soon = () => new Date(Date.now() + 2 * 86_400_000).toISOString();

test.describe('/api/v1/sessions/{id}/payments — who may see the money', () => {
  requireApi();
  requireAuth();

  test('admin sees any session; a clinician only their own; a colleague, a patient and no token are refused', async ({ api, anon }) => {
    const therapist = await loginAs(DEMO_THERAPIST);
    const psychologist = await loginAs(DEMO_PSYCHOLOGIST);
    const patientUser = await loginAs(DEMO_PATIENT, 'patient');
    const created = await api.post('/api/v1/patients/', { data: { first_name: uniq('PayScope'), last_name: 'Patient' } });
    expect(created.status(), await created.text()).toBe(200);
    const patient = await created.json();
    try {
      // a session owned by the therapist, paid at the desk by the admin
      const assigned = await api.put(`/api/v1/patients/${patient.id}`, { data: { assigned_therapist_id: therapist.userId } });
      expect(assigned.status(), await assigned.text()).toBe(200);
      const own = await therapist.ctx.post('/api/v1/sessions/', { data: { patient_id: patient.id, scheduled_at: soon() } });
      expect(own.status(), await own.text()).toBe(200);
      const ownSession = await own.json();
      expect(ownSession.therapist_id).toBe(therapist.userId);
      const rec = await api.post(`/api/v1/sessions/${ownSession.id}/payments`, { data: { amount_paise: 70000, method: 'cash' } });
      expect(rec.status(), await rec.text()).toBe(200);

      // a session owned by the admin
      const other = await api.post('/api/v1/sessions/', { data: { patient_id: patient.id, scheduled_at: soon() } });
      expect(other.status(), await other.text()).toBe(200);
      const adminSession = await other.json();

      const adminView = await api.get(`/api/v1/sessions/${ownSession.id}/payments`);
      expect(adminView.status()).toBe(200);
      expect(await adminView.json()).toEqual([expect.objectContaining({ amount_paise: 70000, method: 'cash', status: 'paid' })]);
      expect((await api.get(`/api/v1/sessions/${adminSession.id}/payments`)).status()).toBe(200);

      const ownView = await therapist.ctx.get(`/api/v1/sessions/${ownSession.id}/payments`);
      expect(ownView.status(), await ownView.text()).toBe(200);
      expect(await ownView.json()).toEqual([expect.objectContaining({ amount_paise: 70000 })]);

      const notTheirs = await therapist.ctx.get(`/api/v1/sessions/${adminSession.id}/payments`);
      expect(notTheirs.status()).toBe(403);
      expect((await notTheirs.json()).message).toBe('Not allowed to view these payments');
      const colleague = await psychologist.ctx.get(`/api/v1/sessions/${ownSession.id}/payments`);
      expect(colleague.status()).toBe(403);
      expect(JSON.stringify(await colleague.json())).not.toContain('70000');

      expect((await patientUser.ctx.get(`/api/v1/sessions/${ownSession.id}/payments`)).status()).toBe(403);
      expect((await anon.get(`/api/v1/sessions/${ownSession.id}/payments`)).status()).toBe(401);
    } finally {
      await therapist.ctx.dispose();
      await psychologist.ctx.dispose();
      await patientUser.ctx.dispose();
      await api.delete(`/api/v1/patients/${patient.id}`);
    }
  });
});
