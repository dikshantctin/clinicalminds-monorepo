import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { uniq } from '../src/env';

test.describe('/api/v1/sessions', () => {
  requireApi();
  requireAuth();

  test('validates the create body (422 without patient_id / scheduled_at)', async ({ api }) => {
    expect((await api.post('/api/v1/sessions/', { data: {} })).status()).toBe(422);
    expect((await api.post('/api/v1/sessions/', { data: { patient_id: 'x', scheduled_at: new Date().toISOString(), duration_minutes: 5 } })).status()).toBe(422);
  });

  test('schedule a session for a patient, then read, list, start and complete it', async ({ api }) => {
    const patientRes = await api.post('/api/v1/patients/', { data: { first_name: uniq('Sess'), last_name: 'Patient' } });
    expect(patientRes.status(), await patientRes.text()).toBe(200);
    const patient = await patientRes.json();

    try {
      const scheduledAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
      const created = await api.post('/api/v1/sessions/', {
        data: { patient_id: patient.id, scheduled_at: scheduledAt, session_type: 'individual', treatment_modality: 'CBT', duration_minutes: 50 },
      });
      expect(created.status(), await created.text()).toBe(200);
      const session = await created.json();
      expect(session.id).toEqual(expect.any(String));

      const read = await api.get(`/api/v1/sessions/${session.id}`);
      expect(read.status()).toBe(200);
      expect(await read.json()).toEqual(expect.objectContaining({ id: session.id, patient_id: patient.id, status: 'scheduled', duration_minutes: 50 }));

      const list = await api.get('/api/v1/sessions/');
      expect(list.status()).toBe(200);
      const body = await list.json();
      expect(Array.isArray(body.sessions)).toBe(true);
      expect(typeof body.total).toBe('number');

      const started = await api.post(`/api/v1/sessions/${session.id}/start`);
      expect(started.status(), await started.text()).toBe(200);
      expect((await (await api.get(`/api/v1/sessions/${session.id}`)).json()).status).toBe('in_progress');
      expect((await api.post(`/api/v1/sessions/${session.id}/start`)).status(), 'cannot start twice').toBe(409);

      const notes = await api.put(`/api/v1/sessions/${session.id}/patient-notes`, { data: { notes: 'e2e note' } });
      expect([200, 422]).toContain(notes.status());

      const completed = await api.post(`/api/v1/sessions/${session.id}/complete`);
      expect(completed.status(), await completed.text()).toBe(200);
      expect((await (await api.get(`/api/v1/sessions/${session.id}`)).json()).status).toBe('completed');
      expect((await api.post(`/api/v1/sessions/${session.id}/complete`)).status(), 'cannot complete twice').toBe(409);
    } finally {
      await api.delete(`/api/v1/patients/${patient.id}`);
    }
  });

  test('cancel: scheduled or in-progress only; no-show: scheduled only; both staff-only', async ({ api, anon }) => {
    const patient = await (await api.post('/api/v1/patients/', { data: { first_name: uniq('Trans'), last_name: 'Patient' } })).json();
    const mk = async () =>
      (await (await api.post('/api/v1/sessions/', { data: { patient_id: patient.id, scheduled_at: new Date(Date.now() + 3_600_000).toISOString() } })).json()).id;
    try {
      const a = await mk();
      expect((await anon.post(`/api/v1/sessions/${a}/cancel`)).status(), 'no token').toBe(401);
      expect((await api.post(`/api/v1/sessions/${a}/start`)).status()).toBe(200);
      expect((await api.post(`/api/v1/sessions/${a}/no-show`)).status(), 'no-show from in_progress').toBe(409);
      const cancelled = await api.post(`/api/v1/sessions/${a}/cancel`, { data: { reason: 'patient called' } });
      expect(cancelled.status(), await cancelled.text()).toBe(200);
      expect((await (await api.get(`/api/v1/sessions/${a}`)).json())).toEqual(expect.objectContaining({ status: 'cancelled' }));
      expect((await api.post(`/api/v1/sessions/${a}/cancel`)).status(), 'cancel twice').toBe(409);
      expect((await api.post(`/api/v1/sessions/${a}/start`)).status(), 'start a cancelled session').toBe(409);

      const b = await mk();
      expect((await api.post(`/api/v1/sessions/${b}/complete`)).status()).toBe(200);
      expect((await api.post(`/api/v1/sessions/${b}/no-show`)).status(), 'no-show a completed session').toBe(409);
      expect((await api.post(`/api/v1/sessions/${b}/cancel`)).status(), 'cancel a completed session').toBe(409);
      expect((await api.post(`/api/v1/sessions/00000000-0000-4000-8000-000000000000/cancel`)).status()).toBe(404);
    } finally {
      await api.delete(`/api/v1/patients/${patient.id}`);
    }
  });

  test('a clinician-set risk flag puts the patient on the follow-up queue; clearing it archives the card', async ({ api }) => {
    const patient = await (await api.post('/api/v1/patients/', { data: { first_name: uniq('Risk'), last_name: 'Patient' } })).json();
    try {
      const session = await (
        await api.post('/api/v1/sessions/', { data: { patient_id: patient.id, scheduled_at: new Date(Date.now() + 3_600_000).toISOString() } })
      ).json();
      expect((await api.put(`/api/v1/sessions/${session.id}`, { data: { risk_level: 'severe' } })).status()).toBe(422);

      const flagged = await api.put(`/api/v1/sessions/${session.id}`, { data: { risk_flag: true, risk_level: 'high', risk_notes: 'safety plan reviewed' } });
      expect(flagged.status(), await flagged.text()).toBe(200);
      const detail = await (await api.get(`/api/v1/sessions/${session.id}`)).json();
      expect(detail).toEqual(expect.objectContaining({ crisis_detected: true, crisis_level: 'high', crisis_notes: 'safety plan reviewed' }));
      const row = (await (await api.get('/api/v1/sessions/', { params: { patient_id: patient.id } })).json()).sessions.find((s: { id: string }) => s.id === session.id);
      expect(row.crisis_detected).toBe(true);

      await api.post('/api/v1/kanban/followups/sync');
      let queue = await (await api.get('/api/v1/kanban/followups')).json();
      const card = queue.items.find((t: { related_patient_id: string | null; reason: string }) => t.related_patient_id === patient.id && t.reason === 'risk_flag');
      expect(card, 'an urgent risk-flag card').toEqual(expect.objectContaining({ priority: 'urgent' }));

      expect((await api.put(`/api/v1/sessions/${session.id}`, { data: { risk_flag: false } })).status()).toBe(200);
      expect((await (await api.get(`/api/v1/sessions/${session.id}`)).json()).crisis_detected).toBe(false);
      await api.post('/api/v1/kanban/followups/sync');
      queue = await (await api.get('/api/v1/kanban/followups')).json();
      expect(queue.items.some((t: { related_patient_id: string | null; reason: string }) => t.related_patient_id === patient.id && t.reason === 'risk_flag')).toBe(false);
    } finally {
      await api.delete(`/api/v1/patients/${patient.id}`);
    }
  });
});
