import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { uniq } from '../src/env';

/**
 * The lazy no-show sweep (run by GET /sessions/ and the overview) marks a session still "scheduled"
 * 24 h after its end as no_show. It must never overwrite a concurrent cancel: a cancel that
 * answered 200 leaves the session cancelled, however the requests interleave.
 */
test.describe('no-show sweep vs a concurrent cancel', () => {
  requireApi();
  requireAuth();

  test('a cancel that answered 200 stays cancelled while sweeps run', async ({ api }) => {
    test.setTimeout(180_000);
    const patient = await (await api.post('/api/v1/patients/', { data: { first_name: uniq('Sweep'), last_name: 'Race' } })).json();
    try {
      for (let round = 0; round < 15; round++) {
        const created = await api.post('/api/v1/sessions/', {
          data: { patient_id: patient.id, scheduled_at: new Date(Date.now() + 86_400_000).toISOString(), duration_minutes: 50 },
        });
        expect(created.status(), await created.text()).toBe(200);
        const session = await created.json();
        // three days ago: stale enough for the sweep (create refuses past times; update does not)
        const moved = await api.put(`/api/v1/sessions/${session.id}`, { data: { scheduled_at: new Date(Date.now() - 3 * 86_400_000).toISOString() } });
        expect(moved.status(), await moved.text()).toBe(200);

        const [cancel] = await Promise.all([
          api.post(`/api/v1/sessions/${session.id}/cancel`, { data: { reason: 'e2e sweep race' } }),
          ...Array.from({ length: 4 }, () => api.get('/api/v1/analytics/overview')),
        ]);
        const after = await (await api.get(`/api/v1/sessions/${session.id}`)).json();
        if (cancel.status() === 200) {
          expect(after.status, `round ${round}: cancel answered 200`).toBe('cancelled');
        } else {
          expect(cancel.status(), await cancel.text()).toBe(409); // the sweep got there first
          expect(after.status).toBe('no_show');
        }
      }
    } finally {
      await api.delete(`/api/v1/patients/${patient.id}`);
    }
  });
});
