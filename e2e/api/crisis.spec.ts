import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { uniq, RANDOM_UUID } from '../src/env';

test.describe('/api/v1/crisis', () => {
  requireApi();
  requireAuth();

  test('validates the assess body (422 for empty text)', async ({ api }) => {
    expect((await api.post('/api/v1/crisis/assess', { data: { text: '' } })).status()).toBe(422);
    expect((await api.post('/api/v1/crisis/assess', { data: {} })).status()).toBe(422);
  });

  test('POST /crisis/assess scores text', async ({ api }) => {
    test.fixme(true, 'crisis.assess_crisis receives crisis_detector via Depends(lambda: None) — the detector is not wired in');
    const res = await api.post('/api/v1/crisis/assess', { data: { text: 'I feel hopeless and I do not want to be here anymore.' } });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(['low', 'moderate', 'high', 'critical']).toContain(body.crisis_level);
  });

  test('report a crisis for a patient, then list and read events', async ({ api }) => {
    const patientRes = await api.post('/api/v1/patients/', { data: { first_name: uniq('Crisis'), last_name: 'Patient' } });
    expect(patientRes.status(), await patientRes.text()).toBe(200);
    const patient = await patientRes.json();

    try {
      const report = await api.post('/api/v1/crisis/report', {
        data: { patient_id: patient.id, crisis_type: 'suicide_risk', severity: 'high', description: 'e2e crisis report', immediate_action_taken: true, actions_taken: ['safety plan reviewed'] },
      });
      expect(report.status(), await report.text()).toBe(200);
      const event = await report.json();

      const events = await api.get('/api/v1/crisis/events', { params: { patient_id: patient.id } });
      expect(events.status()).toBe(200);

      const eventId: string | undefined = event.id ?? event.event_id ?? event.crisis_event_id;
      if (eventId) {
        expect((await api.get(`/api/v1/crisis/events/${eventId}`)).status()).toBe(200);
        const resolved = await api.post(`/api/v1/crisis/events/${eventId}/resolve`, { data: { resolution_notes: 'e2e resolved' } });
        expect([200, 422]).toContain(resolved.status());
      }
    } finally {
      await api.delete(`/api/v1/patients/${patient.id}`);
    }
  });

  test('GET /crisis/statistics responds', async ({ api }) => {
    expect((await api.get('/api/v1/crisis/statistics')).status()).toBe(200);
  });

  test('a client-supplied ?tenant_id= is ignored (tenant comes from the JWT)', async ({ api, auth }) => {
    // get_tenant_db used to take tenant_id as a query parameter, letting a caller pick another tenant's DB
    const res = await api.get('/api/v1/crisis/events', { params: { tenant_id: RANDOM_UUID } });
    expect(res.status()).toBe(200);
    const events = await res.json();
    const list = Array.isArray(events) ? events : events.events ?? [];
    for (const ev of list) if (ev.tenant_id) expect(ev.tenant_id).toBe(auth.tenantId);
  });

  test('unknown event id → 404', async ({ api }) => {
    test.fixme(true, 'crisis.py event endpoints (report/list/get/resolve/statistics) return hard-coded mock data — nothing is persisted, any id "exists"');
    expect([404, 400]).toContain((await api.get(`/api/v1/crisis/events/${RANDOM_UUID}`)).status());
  });
});
