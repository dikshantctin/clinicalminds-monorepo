import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { uniq } from '../src/env';

/**
 * The lazy sweep (run by GET /sessions/ and the overview) flags a session still "scheduled" 24 h after
 * its end as needs_confirmation; it never changes the status. So a concurrent cancel always wins: it
 * answers 200 and leaves the session cancelled, however the requests interleave.
 */
test.describe('needs-confirmation sweep vs a concurrent cancel', () => {
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
        expect(cancel.status(), `round ${round}: ${await cancel.text()}`).toBe(200);
        expect(after.status, `round ${round}`).toBe('cancelled');
      }
    } finally {
      await api.delete(`/api/v1/patients/${patient.id}`);
    }
  });
});
