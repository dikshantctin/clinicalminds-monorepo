import { request as pwRequest, APIRequestContext } from '@playwright/test';
import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { env, uniq, RANDOM_UUID, DEMO_THERAPIST } from '../src/env';

/**
 * Session outcome: one fixed tag per session (capacity MVP §3), recorded with who set it and when.
 * The tag drives the status, so the dashboard and the follow-up queue keep reading status as before.
 * A session nobody marked becomes "needs confirmation" 24 h after its end, never a guessed no-show.
 */

const STATUS_OF: Record<string, string> = {
  attended: 'completed',
  no_show: 'no_show',
  late_cancel_patient: 'cancelled',
  cancel_patient: 'cancelled',
  cancel_clinic: 'cancelled',
  rescheduled: 'cancelled',
};

async function newPatient(api: APIRequestContext): Promise<string> {
  const res = await api.post('/api/v1/patients/', { data: { first_name: uniq('Outcome'), last_name: 'Patient' } });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).id;
}

async function newSession(api: APIRequestContext, patientId: string): Promise<string> {
  const res = await api.post('/api/v1/sessions/', {
    data: { patient_id: patientId, scheduled_at: new Date(Date.now() + 3 * 86_400_000).toISOString(), duration_minutes: 50 },
  });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).id;
}

/** Move a session into the past (create refuses past times; update does not). */
async function backdate(api: APIRequestContext, sessionId: string, hoursAgo: number) {
  const res = await api.put(`/api/v1/sessions/${sessionId}`, { data: { scheduled_at: new Date(Date.now() - hoursAgo * 3_600_000).toISOString() } });
  expect(res.status(), await res.text()).toBe(200);
}

const detail = async (api: APIRequestContext, id: string) => (await api.get(`/api/v1/sessions/${id}`)).json();

test.describe('PUT /api/v1/sessions/{id}/outcome', () => {
  requireApi();
  requireAuth();

  test('each outcome sets its status and records who set it and when', async ({ api, auth }) => {
    const patientId = await newPatient(api);
    try {
      const id = await newSession(api, patientId);
      for (const [outcome, status] of Object.entries(STATUS_OF)) {
        const res = await api.put(`/api/v1/sessions/${id}/outcome`, { data: { outcome } });
        expect(res.status(), `${outcome}: ${await res.text()}`).toBe(200);
        expect(await res.json()).toEqual(expect.objectContaining({ session_id: id, outcome, status }));
        const d = await detail(api, id);
        expect(d).toEqual(expect.objectContaining({ outcome, status, outcome_set_by: auth.user!.id }));
        expect(Date.now() - new Date(d.outcome_set_at).getTime()).toBeLessThan(60_000);
      }
      // a reason is kept in the session notes
      const why = await api.put(`/api/v1/sessions/${id}/outcome`, { data: { outcome: 'cancel_clinic', reason: 'clinician unwell' } });
      expect(why.status()).toBe(200);
      expect((await detail(api, id)).session_notes).toContain('Outcome: Cancelled by clinic (clinician unwell)');
    } finally {
      await api.delete(`/api/v1/patients/${patientId}`);
    }
  });

  test('an unknown outcome or "needs_confirmation" by hand → 422; no token → 401; unknown session → 404', async ({ api, anon }) => {
    const patientId = await newPatient(api);
    try {
      const id = await newSession(api, patientId);
      for (const outcome of ['maybe', 'needs_confirmation', '']) {
        expect((await api.put(`/api/v1/sessions/${id}/outcome`, { data: { outcome } })).status(), outcome).toBe(422);
      }
      expect((await anon.put(`/api/v1/sessions/${id}/outcome`, { data: { outcome: 'attended' } })).status()).toBe(401);
      expect((await api.put(`/api/v1/sessions/${RANDOM_UUID}/outcome`, { data: { outcome: 'attended' } })).status()).toBe(404);
      const d = await detail(api, id);
      expect(d).toEqual(expect.objectContaining({ status: 'scheduled', outcome: null, outcome_set_by: null, outcome_set_at: null }));
    } finally {
      await api.delete(`/api/v1/patients/${patientId}`);
    }
  });

  test("a clinician cannot tag a colleague's session (403)", async ({ api }) => {
    const anon = await pwRequest.newContext({ baseURL: env.API_URL });
    const login = await anon.post('/api/v1/auth/login', { data: { ...DEMO_THERAPIST, audience: 'staff' } });
    expect(login.status()).toBe(200);
    const body = await login.json();
    await anon.dispose();
    const jane = await pwRequest.newContext({
      baseURL: env.API_URL,
      extraHTTPHeaders: { Authorization: `Bearer ${body.access_token}`, 'X-Tenant-ID': body.tenant.id },
    });
    const patientId = await newPatient(api);
    try {
      const id = await newSession(api, patientId); // the admin's own session
      expect((await jane.put(`/api/v1/sessions/${id}/outcome`, { data: { outcome: 'attended' } })).status()).toBe(403);
      expect((await detail(api, id)).outcome).toBeNull();
    } finally {
      await jane.dispose();
      await api.delete(`/api/v1/patients/${patientId}`);
    }
  });

  test('complete → attended and no-show → no_show; a plain cancel leaves the outcome untagged', async ({ api }) => {
    const patientId = await newPatient(api);
    try {
      const done = await newSession(api, patientId);
      expect((await api.post(`/api/v1/sessions/${done}/complete`)).status()).toBe(200);
      expect(await detail(api, done)).toEqual(expect.objectContaining({ status: 'completed', outcome: 'attended' }));

      const missed = await newSession(api, patientId);
      expect((await api.post(`/api/v1/sessions/${missed}/no-show`)).status()).toBe(200);
      expect(await detail(api, missed)).toEqual(expect.objectContaining({ status: 'no_show', outcome: 'no_show' }));

      const cancelled = await newSession(api, patientId);
      expect((await api.post(`/api/v1/sessions/${cancelled}/cancel`, { data: { reason: 'e2e' } })).status()).toBe(200);
      expect(await detail(api, cancelled)).toEqual(expect.objectContaining({ status: 'cancelled', outcome: null }));
    } finally {
      await api.delete(`/api/v1/patients/${patientId}`);
    }
  });
});

test.describe('the 24 h sweep flags "needs confirmation"', () => {
  requireApi();
  requireAuth();

  test('a session still scheduled 24 h after its end needs confirmation (once), stays scheduled, then takes a tag', async ({ api }) => {
    const patientId = await newPatient(api);
    try {
      const id = await newSession(api, patientId);
      await backdate(api, id, 26);
      expect((await api.get('/api/v1/analytics/overview')).status()).toBe(200);
      expect((await api.get('/api/v1/analytics/overview')).status()).toBe(200); // a second sweep changes nothing
      const flagged = await detail(api, id);
      expect(flagged).toEqual(expect.objectContaining({ status: 'scheduled', outcome: 'needs_confirmation', outcome_set_by: null }));
      expect(flagged.session_notes.split('Needs confirmation').length - 1).toBe(1);

      // the clinician is reminded through the follow-up queue's "Missed session" card
      await api.post('/api/v1/kanban/followups/sync');
      const queue = await (await api.get('/api/v1/kanban/followups')).json();
      const card = queue.items.find((t: { related_session_id: string | null }) => t.related_session_id === id);
      expect(card).toEqual(expect.objectContaining({ reason: 'missed_session' }));

      const tagged = await api.put(`/api/v1/sessions/${id}/outcome`, { data: { outcome: 'attended' } });
      expect(tagged.status()).toBe(200);
      expect(await detail(api, id)).toEqual(expect.objectContaining({ status: 'completed', outcome: 'attended' }));
    } finally {
      await api.delete(`/api/v1/patients/${patientId}`);
    }
  });

  test('a plain cancel of a flagged session clears "needs confirmation" (still untagged)', async ({ api }) => {
    const patientId = await newPatient(api);
    try {
      const id = await newSession(api, patientId);
      await backdate(api, id, 26);
      expect((await api.get('/api/v1/analytics/overview')).status()).toBe(200);
      expect((await detail(api, id)).outcome).toBe('needs_confirmation');
      expect((await api.post(`/api/v1/sessions/${id}/cancel`, { data: { reason: 'e2e' } })).status()).toBe(200);
      expect(await detail(api, id)).toEqual(expect.objectContaining({ status: 'cancelled', outcome: null, outcome_set_at: null }));
    } finally {
      await api.delete(`/api/v1/patients/${patientId}`);
    }
  });

  test('an unconfirmed session older than the 90-day follow-up window keeps its "Missed session" card', async ({ api }) => {
    const patientId = await newPatient(api);
    try {
      const id = await newSession(api, patientId);
      await backdate(api, id, 100 * 24);
      expect((await api.get('/api/v1/analytics/overview')).status()).toBe(200);
      expect((await detail(api, id)).outcome).toBe('needs_confirmation');
      await api.post('/api/v1/kanban/followups/sync');
      const queue = await (await api.get('/api/v1/kanban/followups')).json();
      const card = queue.items.find((t: { related_session_id: string | null }) => t.related_session_id === id);
      expect(card).toEqual(expect.objectContaining({ reason: 'missed_session' }));
    } finally {
      await api.delete(`/api/v1/patients/${patientId}`);
    }
  });
});
