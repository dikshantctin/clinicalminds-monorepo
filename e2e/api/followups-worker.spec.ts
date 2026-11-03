import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { uniq } from '../src/env';
import { bookSession } from '../src/sessions';

/**
 * The follow-up queue is kept current by the background worker (backend app/worker), not by page views:
 * a change to a session or patient queues a sync that lands within seconds, and reading the dashboard
 * writes nothing.
 */
type Card = { related_session_id: string | null; reason: string };
const WORKER_BUDGET_MS = 30_000;

test.describe('follow-up queue background sync', () => {
  requireApi();
  requireAuth();

  let patientId: string;
  let sessionId: string;

  test.beforeEach(async ({ api }) => {
    const patient = await (await api.post('/api/v1/patients/', { data: { first_name: uniq('Worker'), last_name: 'Patient' } })).json();
    patientId = patient.id;
    const created = await bookSession(api, {
      patient_id: patientId, scheduled_at: new Date(Date.now() + 86_400_000).toISOString(), duration_minutes: 50,
    });
    expect(created.status(), await created.text()).toBe(200);
    sessionId = (await created.json()).id;
  });

  test.afterEach(async ({ api }) => {
    await api.delete(`/api/v1/patients/${patientId}`);
  });

  const cardFor = async (api: import('@playwright/test').APIRequestContext) => {
    const queue = await (await api.get('/api/v1/kanban/followups')).json();
    return (queue.items as Card[]).find((t) => t.related_session_id === sessionId) ?? null;
  };

  test('a session marked no-show gets a missed-session card without anyone running the sync', async ({ api }) => {
    const marked = await api.post(`/api/v1/sessions/${sessionId}/no-show`, { data: { reason: 'did not turn up' } });
    expect(marked.status(), await marked.text()).toBe(200);

    await expect
      .poll(() => cardFor(api), { timeout: WORKER_BUDGET_MS, intervals: [1_000] })
      .toEqual(expect.objectContaining({ reason: 'missed_session' }));
  });

  test('reading the dashboard overview does not write follow-up cards', async ({ api }) => {
    // Past its end, still scheduled: the rules want a missed-session card. The change queues a worker
    // sync with a few seconds' delay; the overview read right after must not create the card itself.
    const moved = await api.put(`/api/v1/sessions/${sessionId}`, {
      data: { scheduled_at: new Date(Date.now() - 3 * 3_600_000).toISOString() },
    });
    expect(moved.status(), await moved.text()).toBe(200);

    expect((await api.get('/api/v1/analytics/overview')).status()).toBe(200);
    expect(await cardFor(api)).toBeNull();
  });

  test('the queue needs a token', async ({ anon }) => {
    expect((await anon.get('/api/v1/kanban/followups')).status()).toBe(401);
  });
});
