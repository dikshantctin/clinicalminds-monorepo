import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { uniq } from '../src/env';

/** The clinical follow-up queue: cards generated from sessions / risk flags on the "Follow-up queue" board. */
test.describe('/api/v1/kanban/followups', () => {
  requireApi();
  requireAuth();

  test('a missed session becomes one follow-up card; syncing again does not duplicate it; closing it keeps it closed', async ({ api }) => {
    const patient = await (await api.post('/api/v1/patients/', { data: { first_name: uniq('Missed'), last_name: 'Patient' } })).json();
    const created = await api.post('/api/v1/sessions/', {
      data: { patient_id: patient.id, scheduled_at: new Date(Date.now() + 86_400_000).toISOString(), duration_minutes: 50 },
    });
    expect(created.status(), await created.text()).toBe(200);
    const session = await created.json();
    // move it into the past (the create endpoint refuses past times; the update endpoint does not)
    const moved = await api.put(`/api/v1/sessions/${session.id}`, { data: { scheduled_at: new Date(Date.now() - 3 * 3_600_000).toISOString() } });
    expect(moved.status(), await moved.text()).toBe(200);

    try {
      const first = await api.post('/api/v1/kanban/followups/sync');
      expect(first.status(), await first.text()).toBe(200);
      const summary = await first.json();
      expect(summary.board_id).toEqual(expect.any(String));
      // `created` may be 0 here: another worker (Tasks page, journey) can sync first — the card below is the proof
      expect(summary.created).toBeGreaterThanOrEqual(0);

      const queue = await (await api.get('/api/v1/kanban/followups')).json();
      const card = queue.items.find((t: { related_session_id: string | null }) => t.related_session_id === session.id);
      expect(card, 'a card for the missed session').toBeTruthy();
      expect(card).toEqual(expect.objectContaining({ reason: 'missed_session', priority: 'high', status: 'todo', related_patient_id: patient.id }));
      expect(card.title).toContain(patient.first_name);

      // idempotent
      await api.post('/api/v1/kanban/followups/sync'); // other specs may create their own cards concurrently
      const again = await (await api.get('/api/v1/kanban/followups')).json();
      expect(again.items.filter((t: { related_session_id: string | null }) => t.related_session_id === session.id)).toHaveLength(1);

      // the card lives on the Follow-up queue board, visible through the normal kanban API
      const boards = await (await api.get('/api/v1/kanban/boards')).json();
      const boardList = Array.isArray(boards) ? boards : boards.boards ?? boards.items ?? [];
      expect(boardList.map((b: { name: string }) => b.name)).toContain('Follow-up queue');

      // closing it = action taken; a later sync must not resurrect a session-keyed card
      const done = await api.post(`/api/v1/kanban/tasks/${card.id}/move`, { data: { status: 'done', position: 0 } });
      expect(done.status(), await done.text()).toBe(200);
      await api.post('/api/v1/kanban/followups/sync');
      const after = await (await api.get('/api/v1/kanban/followups')).json();
      expect(after.items.filter((t: { related_session_id: string | null }) => t.related_session_id === session.id)).toHaveLength(0);
    } finally {
      await api.put(`/api/v1/sessions/${session.id}`, { data: { status: 'cancelled', cancellation_reason: 'e2e cleanup' } });
      await api.delete(`/api/v1/patients/${patient.id}`);
    }
  });

  test('a card is archived once its trigger is resolved (session rebooked)', async ({ api }) => {
    const patient = await (await api.post('/api/v1/patients/', { data: { first_name: uniq('Rebook'), last_name: 'Patient' } })).json();
    const session = await (
      await api.post('/api/v1/sessions/', { data: { patient_id: patient.id, scheduled_at: new Date(Date.now() + 86_400_000).toISOString() } })
    ).json();
    await api.put(`/api/v1/sessions/${session.id}`, { data: { scheduled_at: new Date(Date.now() - 3 * 3_600_000).toISOString() } });
    try {
      await api.post('/api/v1/kanban/followups/sync');
      let queue = await (await api.get('/api/v1/kanban/followups')).json();
      expect(queue.items.some((t: { related_session_id: string | null }) => t.related_session_id === session.id)).toBe(true);
      // the therapist rebooks it for next week → the reminder is no longer justified
      await api.put(`/api/v1/sessions/${session.id}`, { data: { scheduled_at: new Date(Date.now() + 7 * 86_400_000).toISOString() } });
      const synced = await (await api.post('/api/v1/kanban/followups/sync')).json();
      expect(synced.archived).toBeGreaterThanOrEqual(1);
      queue = await (await api.get('/api/v1/kanban/followups')).json();
      expect(queue.items.some((t: { related_session_id: string | null }) => t.related_session_id === session.id)).toBe(false);
    } finally {
      await api.put(`/api/v1/sessions/${session.id}`, { data: { status: 'cancelled', cancellation_reason: 'e2e cleanup' } });
      await api.delete(`/api/v1/patients/${patient.id}`);
    }
  });

  test('the queue endpoints need a token', async ({ anon }) => {
    expect((await anon.get('/api/v1/kanban/followups')).status()).toBe(401);
    expect((await anon.post('/api/v1/kanban/followups/sync')).status()).toBe(401);
  });
});
