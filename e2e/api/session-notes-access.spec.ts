import { request as pwRequest, APIRequestContext } from '@playwright/test';
import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { env, uniq, RANDOM_UUID, DEMO_THERAPIST, DEMO_PSYCHOLOGIST } from '../src/env';
import { inviteTokenFor } from '../src/outbox';

/**
 * Clinical notes are the clinician's record: a portal patient reads only what is written for them
 * (patient_notes, feedback), never session/progress/risk notes; only the session's own clinician
 * (or clinic-wide staff) may change a session; every load is scoped to the caller's clinic.
 * Prerequisite for AI-drafted notes (AI plan, phase 0).
 */

type Creds = { email: string; password: string };
type Ctx = { ctx: APIRequestContext; userId: string };

async function login(creds: Creds, audience: 'staff' | 'patient'): Promise<Ctx> {
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

async function createPatient(api: APIRequestContext, assignedTo?: string): Promise<string> {
  const res = await api.post('/api/v1/patients/', {
    data: { first_name: uniq('Notes'), last_name: 'Patient', ...(assignedTo ? { assigned_therapist_id: assignedTo } : {}) },
  });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).id;
}

async function book(ctx: APIRequestContext, patientId: string, sessionNotes?: string): Promise<string> {
  const res = await ctx.post('/api/v1/sessions/', {
    data: {
      patient_id: patientId,
      scheduled_at: new Date(Date.now() + 2 * 86_400_000).toISOString(),
      duration_minutes: 50,
      ...(sessionNotes ? { session_notes: sessionNotes } : {}),
    },
  });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).id;
}

const CLINICIAN_ONLY = ['session_notes', 'progress_notes', 'next_session_plan', 'treatment_goals', 'crisis_detected', 'crisis_level', 'crisis_notes'];

test.describe('sessions: a portal patient never sees clinician notes', () => {
  requireApi();
  requireAuth();

  test('patient GET own session → 200 without clinician fields; start/complete → 403; staff still sees them', async ({ api }) => {
    const patientId = await createPatient(api);
    const email = `${uniq('notes')}@example.com`.toLowerCase();
    let patient: Ctx | undefined;
    try {
      const inv = await api.post(`/api/v1/patients/${patientId}/invite`, { data: { email, first_name: 'Notes', last_name: 'Patient' } });
      expect(inv.status(), await inv.text()).toBe(200);
      const set = await api.post('/api/v1/patients/set-password', { data: { token: inviteTokenFor(email), password: 'Password123!' } });
      expect(set.status(), await set.text()).toBe(200);
      patient = await login({ email, password: 'Password123!' }, 'patient');

      const sessionId = await book(api, patientId, 'private clinician note');
      const upd = await api.put(`/api/v1/sessions/${sessionId}`, {
        data: { progress_notes: 'private progress', risk_level: 'high', risk_notes: 'private risk observation' },
      });
      expect(upd.status(), await upd.text()).toBe(200);
      const pn = await api.put(`/api/v1/sessions/${sessionId}/patient-notes`, { data: { patient_notes: 'shared with patient' } });
      expect(pn.status(), await pn.text()).toBe(200);

      const read = await patient.ctx.get(`/api/v1/sessions/${sessionId}`);
      const text = await read.text();
      expect(read.status(), text).toBe(200);
      const body = JSON.parse(text);
      expect(body.id).toBe(sessionId);
      expect(body.patient_notes).toBe('shared with patient');
      for (const key of CLINICIAN_ONLY) expect(body, `patient must not get ${key}`).not.toHaveProperty(key);
      expect(text).not.toContain('private');

      expect((await patient.ctx.post(`/api/v1/sessions/${sessionId}/start`)).status()).toBe(403);
      expect((await patient.ctx.post(`/api/v1/sessions/${sessionId}/complete`)).status()).toBe(403);

      // an unknown session id is 404 for feedback (was loaded by id alone, without the clinic)
      const fb = await patient.ctx.put(`/api/v1/sessions/${RANDOM_UUID}/feedback`, { data: { rating: 5 } });
      expect(fb.status(), await fb.text()).toBe(404);

      const staff = await (await api.get(`/api/v1/sessions/${sessionId}`)).json();
      expect(staff.status).toBe('scheduled');
      expect(staff.session_notes).toBe('private clinician note');
      expect(staff.progress_notes).toBe('private progress');
      expect(staff.crisis_level).toBe('high');
      expect(staff.crisis_notes).toBe('private risk observation');
    } finally {
      await patient?.ctx.dispose();
      await api.delete(`/api/v1/patients/${patientId}`);
    }
  });
});

test.describe("sessions: a clinician cannot change a colleague's session", () => {
  requireApi();
  requireAuth();

  test('THERAPIST on a PSYCHOLOGIST session: edit, patient notes, start, complete, cancel, no-show → 403; owner and admin → 200', async ({ api }) => {
    const therapist = await login(DEMO_THERAPIST, 'staff');
    const psych = await login(DEMO_PSYCHOLOGIST, 'staff');
    const patientId = await createPatient(api, psych.userId);
    try {
      const sessionId = await book(psych.ctx, patientId);
      const base = `/api/v1/sessions/${sessionId}`;

      const attempts: Array<[string, () => ReturnType<APIRequestContext['get']>]> = [
        ['PUT session', () => therapist.ctx.put(base, { data: { session_notes: 'not mine' } })],
        ['PUT patient-notes', () => therapist.ctx.put(`${base}/patient-notes`, { data: { patient_notes: 'not mine' } })],
        ['POST start', () => therapist.ctx.post(`${base}/start`)],
        ['POST complete', () => therapist.ctx.post(`${base}/complete`)],
        ['POST cancel', () => therapist.ctx.post(`${base}/cancel`, { data: {} })],
        ['POST no-show', () => therapist.ctx.post(`${base}/no-show`, { data: {} })],
      ];
      for (const [label, call] of attempts) {
        const res = await call();
        expect(res.status(), `${label}: ${await res.text()}`).toBe(403);
      }
      const after = await (await api.get(base)).json();
      expect(after.status).toBe('scheduled');
      expect(after.session_notes).toBeNull();
      expect(after.patient_notes).toBeNull();

      // an unknown session id is 404 (patient-notes loaded by id alone, without the clinic)
      const unknown = await psych.ctx.put(`/api/v1/sessions/${RANDOM_UUID}/patient-notes`, { data: { patient_notes: 'x' } });
      expect(unknown.status(), await unknown.text()).toBe(404);

      expect((await psych.ctx.put(`${base}/patient-notes`, { data: { patient_notes: 'mine' } })).status()).toBe(200);
      expect((await psych.ctx.post(`${base}/start`)).status()).toBe(200);
      expect((await api.post(`${base}/complete`)).status()).toBe(200);
    } finally {
      await therapist.ctx.dispose();
      await psych.ctx.dispose();
      await api.delete(`/api/v1/patients/${patientId}`);
    }
  });
});
