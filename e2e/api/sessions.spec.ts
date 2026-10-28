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
});
