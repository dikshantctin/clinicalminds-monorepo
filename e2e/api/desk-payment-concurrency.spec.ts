import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { uniq } from '../src/env';

/**
 * A session is paid once. Two desk payments sent at the same moment (double click, two receptionists)
 * must not both be stored: the database holds at most one `paid` row per session, and the loser gets
 * the same 409 a sequential second payment gets.
 */
test.describe('/api/v1/sessions/{id}/payments — concurrent desk payments', () => {
  requireApi();
  requireAuth();

  test('of several simultaneous payments exactly one is stored; the rest are 409', async ({ api }) => {
    const patient = await (await api.post('/api/v1/patients/', { data: { first_name: uniq('Race'), last_name: 'Patient' } })).json();
    try {
      for (let round = 0; round < 5; round++) {
        const created = await api.post('/api/v1/sessions/', {
          data: { patient_id: patient.id, scheduled_at: new Date(Date.now() + (2 + round) * 86_400_000).toISOString() },
        });
        expect(created.status(), await created.text()).toBe(200);
        const session = await created.json();
        const results = await Promise.all(
          Array.from({ length: 4 }, (_, i) =>
            api.post(`/api/v1/sessions/${session.id}/payments`, { data: { amount_paise: 10000 + i, method: 'cash' } }),
          ),
        );
        const statuses = results.map((r) => r.status()).sort();
        expect(statuses, `round ${round}`).toEqual([200, 409, 409, 409]);
        for (const r of results.filter((r) => r.status() === 409)) {
          expect((await r.json()).message).toBe('This session is already paid');
        }
        const rows = await (await api.get(`/api/v1/sessions/${session.id}/payments`)).json();
        expect(rows.filter((p: { status: string }) => p.status === 'paid')).toHaveLength(1);
      }
    } finally {
      await api.delete(`/api/v1/patients/${patient.id}`);
    }
  });
});
