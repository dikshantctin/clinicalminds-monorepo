import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { uniq } from '../src/env';

/** GET /analytics/overview — the dashboard's four numbers, counted from real rows (overview_service.py). */
test.describe('/api/v1/analytics/overview', () => {
  requireApi();
  requireAuth();

  test('returns the four counters with their periods', async ({ api }) => {
    const res = await api.get('/api/v1/analytics/overview');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toEqual(
      expect.objectContaining({
        sessions_this_week: expect.any(Number),
        no_shows_this_week: expect.any(Number),
        revenue_collected_paise: expect.any(Number), // the demo user is an ADMIN, who sees money
        patients_needing_followup: expect.any(Number),
        week_start: expect.any(String),
        month_start: expect.any(String),
        scope: 'clinic',
      }),
    );
    expect(new Date(body.week_start).getTime()).toBeLessThanOrEqual(Date.now());
  });

  test('marking a session no-show moves it into no_shows_this_week (and cancelling it takes it out)', async ({ api }) => {
    // Other specs create and cancel sessions in parallel, so sessions_this_week is noisy; nothing else
    // marks a session no_show, so that counter is stable enough to assert exact deltas on.
    const patientRes = await api.post('/api/v1/patients/', { data: { first_name: uniq('Overview'), last_name: 'Patient' } });
    expect(patientRes.status(), await patientRes.text()).toBe(200);
    const patient = await patientRes.json();
    const overview = async () => (await api.get('/api/v1/analytics/overview')).json();
    try {
      const before = await overview();
      const created = await api.post('/api/v1/sessions/', {
        data: { patient_id: patient.id, scheduled_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(), duration_minutes: 50 },
      });
      expect(created.status(), await created.text()).toBe(200);
      const session = await created.json();

      expect((await api.put(`/api/v1/sessions/${session.id}`, { data: { status: 'no_show' } })).status()).toBe(200);
      await expect.poll(async () => (await overview()).no_shows_this_week).toBe(before.no_shows_this_week + 1);

      expect((await api.put(`/api/v1/sessions/${session.id}`, { data: { status: 'cancelled' } })).status()).toBe(200);
      await expect.poll(async () => (await overview()).no_shows_this_week).toBe(before.no_shows_this_week);
    } finally {
      await api.delete(`/api/v1/patients/${patient.id}`);
    }
  });
});
