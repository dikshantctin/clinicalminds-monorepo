import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { uniq } from '../src/env';
import { bookSession } from '../src/sessions';

/**
 * GET /kanban/followups is the Follow-ups page's list: paged, filtered by reason / status / assignee /
 * search, sorted urgent first, with per-reason counts for the tabs. Exact numbers come from rows this spec
 * owns (filtered to its own patient); the demo clinic's queue changes under parallel workers.
 */
type Item = { id: string; reason: string; priority: string; status: string; related_patient_id: string };
const HOUR = 3_600_000;

test.describe('follow-ups list', () => {
  requireApi();
  requireAuth();

  let patient: { id: string; first_name: string };
  let sessions: string[];

  test.beforeEach(async ({ api }) => {
    patient = await (await api.post('/api/v1/patients/', { data: { first_name: uniq('Fulist'), last_name: 'Patient' } })).json();
    sessions = [];
    // one session flagged at risk (urgent card) and one missed (high card)
    for (let i = 0; i < 2; i += 1) {
      const res = await bookSession(api, {
        patient_id: patient.id, scheduled_at: new Date(Date.now() + (i + 1) * 24 * HOUR).toISOString(), duration_minutes: 50,
      });
      expect(res.status(), await res.text()).toBe(200);
      sessions.push((await res.json()).id);
    }
    const flagged = await api.put(`/api/v1/sessions/${sessions[0]}`, { data: { risk_flag: true, risk_level: 'high' } });
    expect(flagged.status(), await flagged.text()).toBe(200);
    const missed = await api.put(`/api/v1/sessions/${sessions[1]}`, { data: { scheduled_at: new Date(Date.now() - 3 * HOUR).toISOString() } });
    expect(missed.status(), await missed.text()).toBe(200);
    expect((await api.post('/api/v1/kanban/followups/sync')).status()).toBe(200);
  });

  test.afterEach(async ({ api }) => {
    for (const id of sessions) await api.post(`/api/v1/sessions/${id}/cancel`, { data: { reason: 'e2e cleanup' } });
    await api.delete(`/api/v1/patients/${patient.id}`);
  });

  const list = async (api: import('@playwright/test').APIRequestContext, params: Record<string, string | number | string[]>) => {
    // lists go as repeated keys (reason=a&reason=b), as FastAPI reads them
    const query = new URLSearchParams({ related_patient_id: patient.id });
    for (const [key, value] of Object.entries(params)) {
      for (const one of Array.isArray(value) ? value : [value]) query.append(key, String(one));
    }
    const res = await api.get(`/api/v1/kanban/followups?${query}`);
    expect(res.status(), await res.text()).toBe(200);
    return res.json();
  };

  test('pages are exact and sorted urgent first', async ({ api }) => {
    const all = await list(api, {});
    expect(all).toEqual(expect.objectContaining({ total: 2, page: 1, per_page: 25, total_pages: 1 }));
    expect(all.items.map((i: Item) => [i.reason, i.priority])).toEqual([
      ['risk_flag', 'urgent'],
      ['missed_session', 'high'],
    ]);

    const first = await list(api, { per_page: 1, page: 1 });
    const second = await list(api, { per_page: 1, page: 2 });
    expect([first.total, first.total_pages, first.items.length]).toEqual([2, 2, 1]);
    expect(second.items.map((i: Item) => i.id)).toEqual([all.items[1].id]);
    expect(first.items.map((i: Item) => i.id)).toEqual([all.items[0].id]);
  });

  test('reason filter narrows the rows; tab counts ignore it', async ({ api }) => {
    const risk = await list(api, { reason: 'risk_flag' });
    expect(risk.items.map((i: Item) => i.reason)).toEqual(['risk_flag']);
    expect(risk.total).toBe(1);
    expect(risk.by_reason).toEqual({ risk_flag: 1, missed_session: 1, no_first_session: 0, inactive_patient: 0 });

    const both = await list(api, { reason: ['risk_flag', 'missed_session'] });
    expect(both.total).toBe(2);
  });

  test('search matches the patient name in the card title', async ({ api }) => {
    const hit = await list(api, { search: patient.first_name.toUpperCase() });
    expect(hit.total).toBe(2);
    // % and _ are literal characters, not wildcards
    expect((await list(api, { search: '%' })).total).toBe(0);
    expect((await list(api, { search: '_' })).total).toBe(0);
    const miss = await list(api, { search: uniq('nobody') });
    expect(miss.total).toBe(0);
    expect(miss.items).toEqual([]);
  });

  test('status filter: a closed card leaves the open list and shows under done', async ({ api }) => {
    const missed = (await list(api, { reason: 'missed_session' })).items[0] as Item;
    const closed = await api.put(`/api/v1/kanban/tasks/${missed.id}`, { data: { status: 'done' } });
    expect(closed.status(), await closed.text()).toBe(200);
    try {
      expect((await list(api, {})).items.map((i: Item) => i.reason)).toEqual(['risk_flag']);
      const done = await list(api, { status: 'done' });
      expect(done.items.map((i: Item) => i.id)).toEqual([missed.id]);
    } finally {
      await api.put(`/api/v1/kanban/tasks/${missed.id}`, { data: { status: 'todo' } });
    }
  });

  test('assignee filter narrows to that user', async ({ api }) => {
    const me = await (await api.get('/api/v1/auth/me')).json();
    const risk = (await list(api, { reason: 'risk_flag' })).items[0] as Item;
    const assigned = await api.put(`/api/v1/kanban/tasks/${risk.id}`, { data: { assigned_to_user: me.id } });
    expect(assigned.status(), await assigned.text()).toBe(200);
    const mine = await list(api, { assigned_to_user: me.id });
    expect(mine.items.map((i: Item) => i.id)).toContain(risk.id);
    expect(mine.items.every((i: Item & { assigned_to_user: string }) => i.assigned_to_user === me.id)).toBe(true);
  });

  test('bad paging or reason → 422', async ({ api }) => {
    expect((await api.get('/api/v1/kanban/followups', { params: { per_page: 101 } })).status()).toBe(422);
    expect((await api.get('/api/v1/kanban/followups', { params: { page: 0 } })).status()).toBe(422);
    expect((await api.get('/api/v1/kanban/followups', { params: { reason: 'bogus' } })).status()).toBe(422);
  });

  test('the board list hides the auto Follow-up queue unless asked for it', async ({ api }) => {
    const names = async (params: Record<string, string>) =>
      ((await (await api.get('/api/v1/kanban/boards', { params })).json()).boards as { name: string }[]).map((b) => b.name);
    expect(await names({})).not.toContain('Follow-up queue');
    expect(await names({ include_auto: 'true' })).toContain('Follow-up queue');
  });
});
