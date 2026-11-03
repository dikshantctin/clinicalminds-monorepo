import { request as pwRequest, type APIRequestContext } from '@playwright/test';
import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { env, uniq, DEMO_PATIENT, RANDOM_UUID } from '../src/env';

/**
 * GET /kanban/boards/{id}/view: the board as cells (team × status), at most `per_cell` cards each
 * with the cell's real total, so the page never downloads the whole board. Done shows the current
 * month in clinic time unless completed_from/completed_to say otherwise; a due range filters the
 * open columns by due date and counts the cards it hides for having no due date.
 */

type Card = { id: string; position: number; overdue: boolean; completed_at: string | null };
type Cell = { team_id: string | null; status: string; total: number; tasks: Card[] };
type View = { cells: Cell[]; done_this_month: number; done_last_month: number; no_due_date: number };

const cell = (view: View, status: string, team: string | null = null): Cell | undefined =>
  view.cells.find((c) => c.status === status && c.team_id === team);

/** UTC instant of 00:00 today in `timeZone`. */
const startOfToday = (timeZone: string, now = new Date()): Date => {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone }).format(now);
  const wall = (d: Date) => {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      }).formatToParts(d).map((x) => [x.type, x.value]),
    );
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  };
  const naive = new Date(`${day}T00:00:00Z`);
  return new Date(naive.getTime() - (wall(naive) - naive.getTime()));
};

test.describe('/api/v1/kanban/boards/{id}/view', () => {
  requireApi();
  requireAuth();

  let board: { id: string };

  test.beforeEach(async ({ api }) => {
    const res = await api.post('/api/v1/kanban/boards', { data: { name: uniq('View Board') } });
    expect(res.status(), await res.text()).toBe(200);
    board = await res.json();
  });

  test.afterEach(async ({ api }) => {
    expect((await api.delete(`/api/v1/kanban/boards/${board.id}`, { params: { hard_delete: true } })).status()).toBe(200);
  });

  const mk = async (api: APIRequestContext, data: Record<string, unknown>): Promise<Card> => {
    const res = await api.post('/api/v1/kanban/tasks', { data: { board_id: board.id, title: uniq('View card'), ...data } });
    expect(res.status(), await res.text()).toBe(200);
    return res.json();
  };

  const view = async (api: APIRequestContext, params: Record<string, string | number | boolean> = {}): Promise<View> => {
    const res = await api.get(`/api/v1/kanban/boards/${board.id}/view`, { params });
    expect(res.status(), await res.text()).toBe(200);
    return res.json();
  };

  test('a cell returns per_cell cards and its real total; offset pages the rest with no overlap', async ({ api }) => {
    for (let i = 0; i < 120; i += 20) {
      await Promise.all(Array.from({ length: 20 }, () => mk(api, { status: 'todo' })));
    }
    await mk(api, { status: 'review' });

    const first = await view(api);
    expect(cell(first, 'todo')!.total).toBe(120);
    expect(cell(first, 'todo')!.tasks).toHaveLength(50);
    expect(cell(first, 'review')!.total).toBe(1);
    expect(cell(first, 'review')!.tasks).toHaveLength(1);

    const more = { status: 'todo', unassigned_team: true, per_cell: 50 };
    const second = await view(api, { ...more, offset: 50 });
    const third = await view(api, { ...more, offset: 100 });
    expect(second.cells).toHaveLength(1);
    expect(cell(second, 'todo')!.tasks).toHaveLength(50);
    expect(cell(third, 'todo')!.tasks).toHaveLength(20);

    const ids = [first, second, third].flatMap((v) => cell(v, 'todo')!.tasks.map((t) => t.id));
    expect(new Set(ids).size).toBe(120);
    const positions = [first, second, third].flatMap((v) => cell(v, 'todo')!.tasks.map((t) => t.position));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  test('Done shows this month by default and filters by completion date', async ({ api }) => {
    const done = await mk(api, { status: 'done' });
    expect(done.completed_at).not.toBeNull(); // created straight into Done

    const now = await view(api);
    expect(cell(now, 'done')!.tasks.map((t) => t.id)).toEqual([done.id]);
    expect(now.done_this_month).toBe(1);
    expect(now.done_last_month).toBe(0);

    const hour = 3_600_000;
    const around = await view(api, {
      completed_from: new Date(Date.now() - hour).toISOString(),
      completed_to: new Date(Date.now() + hour).toISOString(),
    });
    expect(cell(around, 'done')!.total).toBe(1);

    const before = await view(api, {
      completed_from: new Date(Date.now() - 48 * hour).toISOString(),
      completed_to: new Date(Date.now() - hour).toISOString(),
    });
    expect(cell(before, 'done')).toBeUndefined();
    expect(before.done_this_month).toBe(1); // the header counts don't follow the range
  });

  test('a due range filters open columns by due date and counts the hidden no-due-date cards', async ({ api }) => {
    const day = 86_400_000;
    const inside = await mk(api, { status: 'todo', due_date: new Date(Date.now() + 2 * day).toISOString() });
    await mk(api, { status: 'todo', due_date: new Date(Date.now() + 20 * day).toISOString() });
    const undated = await mk(api, { status: 'in_progress' });

    const all = await view(api);
    expect(cell(all, 'todo')!.total).toBe(2);
    expect(cell(all, 'in_progress')!.tasks.map((t) => t.id)).toEqual([undated.id]);

    const ranged = await view(api, {
      due_date_from: new Date(Date.now()).toISOString(),
      due_date_to: new Date(Date.now() + 7 * day).toISOString(),
    });
    expect(cell(ranged, 'todo')!.tasks.map((t) => t.id)).toEqual([inside.id]);
    expect(cell(ranged, 'in_progress')).toBeUndefined();
    expect(ranged.no_due_date).toBe(1);
  });

  test('overdue: due before today in clinic time and still open', async ({ api }) => {
    const me = await (await api.get('/api/v1/auth/me')).json();
    const today = startOfToday(me.timezone);
    const yesterday = new Date(today.getTime() - 60 * 60_000).toISOString();
    const laterToday = new Date(today.getTime() + 60_000).toISOString();

    const late = await mk(api, { status: 'todo', due_date: yesterday });
    const dueToday = await mk(api, { status: 'todo', due_date: laterToday });
    const closed = await mk(api, { status: 'done', due_date: yesterday });

    const all = await view(api);
    const flag = (id: string) => all.cells.flatMap((c) => c.tasks).find((t) => t.id === id)!.overdue;
    expect(flag(late.id)).toBe(true);
    expect(flag(dueToday.id)).toBe(false);
    expect(flag(closed.id)).toBe(false);

    const only = await view(api, { overdue: true });
    expect(only.cells.flatMap((c) => c.tasks.map((t) => t.id))).toEqual([late.id]);
  });

  test('search is applied on the server', async ({ api }) => {
    const word = uniq('needle');
    const hit = await mk(api, { status: 'todo', title: `Call about ${word}` });
    await mk(api, { status: 'todo' });
    const found = await view(api, { search: word });
    expect(found.cells.flatMap((c) => c.tasks.map((t) => t.id))).toEqual([hit.id]);
  });

  test('reopening a card through PUT clears completed_at', async ({ api }) => {
    const card = await mk(api, { status: 'todo' });
    const closed = await api.put(`/api/v1/kanban/tasks/${card.id}`, { data: { status: 'done' } });
    expect(closed.status(), await closed.text()).toBe(200);
    expect((await closed.json()).completed_at).not.toBeNull();

    const reopened = await api.put(`/api/v1/kanban/tasks/${card.id}`, { data: { status: 'todo' } });
    expect(reopened.status(), await reopened.text()).toBe(200);
    expect((await reopened.json()).completed_at).toBeNull();
  });

  test('rejects a foreign board, a bad per_cell, no token and a patient', async ({ api, anon }) => {
    expect((await api.get(`/api/v1/kanban/boards/${RANDOM_UUID}/view`)).status()).toBe(404);
    expect((await api.get(`/api/v1/kanban/boards/${board.id}/view`, { params: { per_cell: 101 } })).status()).toBe(422);
    expect((await anon.get(`/api/v1/kanban/boards/${board.id}/view`)).status()).toBe(401);

    const login = await anon.post('/api/v1/auth/login', { data: { ...DEMO_PATIENT, audience: 'patient' } });
    expect(login.status(), await login.text()).toBe(200);
    const body = await login.json();
    const patient = await pwRequest.newContext({
      baseURL: env.API_URL,
      extraHTTPHeaders: { Authorization: `Bearer ${body.access_token}`, 'X-Tenant-ID': body.tenant.id },
    });
    expect((await patient.get(`/api/v1/kanban/boards/${board.id}/view`)).status()).toBe(403);
    await patient.dispose();
  });
});
