import { request as pwRequest, APIRequestContext } from '@playwright/test';
import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { env, uniq, DEMO_THERAPIST } from '../src/env';

/**
 * A move names the cards that will sit directly above (`before_id`) and below (`after_id`) the moved one.
 * The server writes that one row (a fractional position between the neighbours) and returns the task;
 * no other card is rewritten.
 */
type Task = { id: string; status: string; position: number; updated_at: string };

const newBoard = async (api: APIRequestContext) => (await api.post('/api/v1/kanban/boards', { data: { name: uniq('Move Board') } })).json();
const newTask = async (api: APIRequestContext, boardId: string, status = 'todo'): Promise<Task> => {
  const res = await api.post('/api/v1/kanban/tasks', { data: { board_id: boardId, title: uniq('Move'), status } });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
};
const getTask = async (api: APIRequestContext, id: string): Promise<Task> => (await api.get(`/api/v1/kanban/tasks/${id}`)).json();
const move = (api: APIRequestContext, id: string, data: Record<string, string | number>) =>
  api.post(`/api/v1/kanban/tasks/${id}/move`, { data });

test.describe('POST /kanban/tasks/{id}/move with neighbours', () => {
  requireApi();
  requireAuth();

  let boards: string[] = [];
  test.afterEach(async ({ api }) => {
    for (const id of boards.splice(0)) await api.delete(`/api/v1/kanban/boards/${id}`);
  });

  test('a card moved between two others lands strictly between them and no other card is rewritten', async ({ api }) => {
    const board = await newBoard(api);
    boards.push(board.id);
    const [a, b, c, d] = [await newTask(api, board.id), await newTask(api, board.id), await newTask(api, board.id), await newTask(api, board.id)];

    const res = await move(api, d.id, { status: 'todo', before_id: a.id, after_id: b.id });
    expect(res.status(), await res.text()).toBe(200);
    const moved: Task = await res.json();
    expect(moved.id).toBe(d.id);
    expect(moved.status).toBe('todo');
    expect(moved.position).toBeGreaterThan(a.position);
    expect(moved.position).toBeLessThan(b.position);

    for (const other of [a, b, c]) {
      const now = await getTask(api, other.id);
      expect([now.position, now.updated_at]).toEqual([other.position, other.updated_at]);
    }
  });

  test('into another column: between two cards there, at the top, at the bottom, and into an empty column', async ({ api }) => {
    const board = await newBoard(api);
    boards.push(board.id);
    const [p, q] = [await newTask(api, board.id, 'review'), await newTask(api, board.id, 'review')];
    const t = await newTask(api, board.id);

    const between: Task = await (await move(api, t.id, { status: 'review', before_id: p.id, after_id: q.id })).json();
    expect(between.status).toBe('review');
    expect(between.position).toBeGreaterThan(p.position);
    expect(between.position).toBeLessThan(q.position);

    const top: Task = await (await move(api, t.id, { status: 'review', after_id: p.id })).json();
    expect(top.position).toBeLessThan(p.position);

    const bottom: Task = await (await move(api, t.id, { status: 'review', before_id: q.id })).json();
    expect(bottom.position).toBeGreaterThan(q.position);

    const empty = await move(api, t.id, { status: 'done' });
    expect(empty.status(), await empty.text()).toBe(200);
    expect(await empty.json()).toEqual(expect.objectContaining({ status: 'done', position: expect.any(Number) }));
  });

  // `position` as an old client sends it: the neighbours decide, and a bad neighbour is refused
  test('a neighbour from another board, in another status, or unknown is 422 and moves nothing', async ({ api }) => {
    const board = await newBoard(api);
    const other = await newBoard(api);
    boards.push(board.id, other.id);
    const [a, b] = [await newTask(api, board.id), await newTask(api, board.id)];
    const foreign = await newTask(api, other.id);
    const inReview = await newTask(api, board.id, 'review');

    const fromOtherBoard = await move(api, b.id, { status: 'todo', before_id: foreign.id, position: 0 });
    expect(fromOtherBoard.status(), await fromOtherBoard.text()).toBe(422);

    const otherStatus = await move(api, b.id, { status: 'todo', after_id: inReview.id, position: 0 });
    expect(otherStatus.status(), await otherStatus.text()).toBe(422);

    const unknown = await move(api, b.id, { status: 'todo', before_id: '00000000-0000-4000-8000-000000000000', position: 0 });
    expect(unknown.status(), await unknown.text()).toBe(422);

    const itself = await move(api, b.id, { status: 'todo', before_id: b.id, position: 0 });
    expect(itself.status(), await itself.text()).toBe(422);

    const now = await getTask(api, b.id);
    expect([now.status, now.position, now.updated_at]).toEqual([b.status, b.position, b.updated_at]);
    expect((await getTask(api, a.id)).updated_at).toBe(a.updated_at);
  });

  test('deleting a card rewrites no other card in its column', async ({ api }) => {
    const board = await newBoard(api);
    boards.push(board.id);
    const [a, b, c] = [await newTask(api, board.id), await newTask(api, board.id), await newTask(api, board.id)];

    expect((await api.delete(`/api/v1/kanban/tasks/${a.id}`)).status()).toBe(200);
    for (const other of [b, c]) {
      const now = await getTask(api, other.id);
      expect([now.position, now.updated_at]).toEqual([other.position, other.updated_at]);
    }
  });

  test('without a token a move is 401', async ({ anon }) => {
    const res = await anon.post('/api/v1/kanban/tasks/00000000-0000-4000-8000-000000000000/move', { data: { status: 'todo' } });
    expect(res.status()).toBe(401);
  });

  test("a therapist moving a manager's card (not creator, not assignee) is 403 and moves nothing", async ({ api, anon }) => {
    const board = await newBoard(api);
    boards.push(board.id);
    const [a, b] = [await newTask(api, board.id), await newTask(api, board.id)];
    const login = await anon.post('/api/v1/auth/login', { data: DEMO_THERAPIST });
    expect(login.status(), `demo therapist (setup_demo_data.py): ${await login.text()}`).toBe(200);
    const therapist = await pwRequest.newContext({
      baseURL: env.API_URL,
      extraHTTPHeaders: { Authorization: `Bearer ${(await login.json()).access_token}` },
    });
    try {
      const res = await move(therapist, b.id, { status: 'todo', after_id: a.id });
      expect(res.status(), await res.text()).toBe(403);
      expect((await res.json()).message).toBe('Only managers, the creator or the assignee can change this task');
    } finally {
      await therapist.dispose();
    }
    const now = await getTask(api, b.id);
    expect([now.status, now.position, now.updated_at]).toEqual([b.status, b.position, b.updated_at]);
  });

  test('40 moves into the same shrinking gap keep the order (the column is renumbered when the gap runs out)', async ({ api }) => {
    test.setTimeout(60_000);
    const board = await newBoard(api);
    boards.push(board.id);
    const [a, b, x, y] = [await newTask(api, board.id), await newTask(api, board.id), await newTask(api, board.id), await newTask(api, board.id)];

    // Each move puts one card between `a` and the card moved last, halving the gap every time
    let below = b.id;
    for (let i = 0; i < 40; i++) {
      const card = i % 2 === 0 ? x : y;
      const res = await move(api, card.id, { status: 'todo', before_id: a.id, after_id: below });
      expect(res.status(), `move ${i}: ${await res.text()}`).toBe(200);
      below = card.id;
    }

    const order = (await Promise.all([a, b, x, y].map((t) => getTask(api, t.id))))
      .sort((m, n) => m.position - n.position)
      .map((t) => t.id);
    // The 40th move (i = 39) was y, placed just below a; x sits under it; b stays last
    expect(order).toEqual([a.id, y.id, x.id, b.id]);
  });
});
