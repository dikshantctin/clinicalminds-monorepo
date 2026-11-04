import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { test, expect, requireWeb, requireAuth } from '../src/fixtures';
import { uniq } from '../src/env';

/**
 * Drag and drop on the task board. The board is filled with enough cards that one cell is far taller
 * than the viewport: that is the shape (the Follow-up queue) on which drops used to land in the wrong
 * column or nowhere.
 */
const FILLER = 25;

const cell = (page: Page, teamId: string, status: string) => page.getByTestId(`kanban-cell-${teamId}-${status}`);
const card = (scope: Page | Locator, title: string) => scope.getByTestId('task-card').filter({ hasText: title });

/** Press on the card body (not the handle) and release over `target`. */
const drag = async (page: Page, source: Locator, target: Locator) => {
  await source.scrollIntoViewIfNeeded();
  const from = (await source.boundingBox())!;
  // Measured before the drag: once it starts, sortable neighbours slide out of the way
  const to = (await target.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + 20);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + 32, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + Math.min(to.height / 2, 60), { steps: 20 });
  await page.mouse.up();
};

const getTask = async (api: APIRequestContext, id: string) => (await api.get(`/api/v1/kanban/tasks/${id}`)).json();

test.describe('task board drag and drop', () => {
  requireWeb();
  requireAuth();
  // Tall enough that the Unassigned row and the next team row fit without dnd-kit edge auto-scroll
  test.use({ viewport: { width: 1440, height: 1600 } });

  let board: { id: string };
  let titles: string[];
  let ids: string[];

  test.beforeEach(async ({ api, page }) => {
    board = await (await api.post('/api/v1/kanban/boards', { data: { name: uniq('DnD Board') } })).json();
    titles = Array.from({ length: FILLER }, (_, i) => uniq(`DnD ${i}`));
    ids = [];
    for (const title of titles) {
      const res = await api.post('/api/v1/kanban/tasks', { data: { board_id: board.id, title, status: 'todo' } });
      expect(res.status(), await res.text()).toBe(200);
      ids.push((await res.json()).id);
    }
    await page.goto('/dashboard/tasks');
    await page.getByRole('combobox', { name: 'Board' }).selectOption(board.id);
    await expect(card(page, titles[0])).toBeVisible({ timeout: 15_000 });
  });

  test.afterEach(async ({ api }) => {
    await api.delete(`/api/v1/kanban/boards/${board.id}`);
  });

  test('a card dragged by its body into an empty column moves there', async ({ page, api }) => {
    await drag(page, card(page, titles[0]), cell(page, 'unassigned', 'review'));

    await expect(card(cell(page, 'unassigned', 'review'), titles[0])).toBeVisible();
    await expect.poll(async () => (await getTask(api, ids[0])).status).toBe('review');
  });

  test('a card dropped on another card in its column takes that place, and the board is not reloaded', async ({ page, api }) => {
    const first = await getTask(api, ids[0]);
    // Listening from before the drag: a reload fired from the move's onSuccess cannot slip past
    const reloads: string[] = [];
    page.on('request', (req) => {
      if (req.method() === 'GET' && /\/api\/v1\/kanban\/tasks(\?|$)/.test(req.url())) reloads.push(req.url());
    });
    const moved = page.waitForResponse('**/api/v1/kanban/tasks/*/move');
    await drag(page, card(page, titles[3]), card(page, titles[0]));
    expect((await moved).status()).toBe(200);

    await expect(cell(page, 'unassigned', 'todo').getByTestId('task-card').first()).toContainText(titles[3]);
    const after = await getTask(api, ids[3]);
    expect(after.status).toBe('todo');
    expect(after.position).toBeLessThan(first.position);
    // The card it landed on was not rewritten
    expect((await getTask(api, ids[0])).updated_at).toBe(first.updated_at);
    // onSuccess (where a reload would be started) has run once its toast shows. A request the page sends after
    // that is seen after any reload it started, since a page's requests are reported in the order sent.
    await expect(page.getByText('Task moved successfully')).toBeVisible();
    const sentinel = page.waitForRequest((req) => req.url().includes('e2e-sentinel'));
    await page.evaluate(() => fetch('/favicon.ico?e2e-sentinel').catch(() => undefined));
    await sentinel;
    expect(reloads).toEqual([]);
  });

  test("a drop next to cards that moved behind the page's back reloads the board", async ({ page, api }) => {
    const move = (id: string, before_id: string, after_id: string) =>
      api.post(`/api/v1/kanban/tasks/${id}/move`, { data: { status: 'todo', before_id, after_id } });
    // Elsewhere: card 2 moves up within its gap, so the page's cached position for it is stale (same order)
    expect((await move(ids[4], ids[1], ids[2])).status()).toBe(200);
    expect((await move(ids[2], ids[1], ids[4])).status()).toBe(200);
    expect((await move(ids[4], ids[3], ids[5])).status()).toBe(200);

    // Card 3 dropped on card 2 lands between 1 and 2; the server's position is not the page's guess
    const moved = page.waitForResponse('**/api/v1/kanban/tasks/*/move');
    const reload = page.waitForRequest((req) => req.method() === 'GET' && /\/api\/v1\/kanban\/tasks(\?|$)/.test(req.url()));
    await drag(page, card(page, titles[3]), card(page, titles[2]));
    expect((await moved).status()).toBe(200);
    await reload;

    const order = (await Promise.all(ids.slice(0, 5).map((id) => getTask(api, id))))
      .sort((m, n) => m.position - n.position)
      .map((t) => t.id);
    expect(order).toEqual([ids[0], ids[1], ids[3], ids[2], ids[4]]);
  });

  test('a card dropped in another team row is assigned to that team', async ({ page, api }) => {
    const team = await (
      await api.post('/api/v1/teams/teams', { data: { name: uniq('DnD Team'), team_type: 'CLINICAL', color: '#2563EB' } })
    ).json();
    try {
      await page.reload();
      await page.getByRole('combobox', { name: 'Board' }).selectOption(board.id);
      await drag(page, card(page, titles[0]), cell(page, team.id, 'in_progress'));

      await expect(card(cell(page, team.id, 'in_progress'), titles[0])).toBeVisible();
      await expect
        .poll(async () => {
          const task = await getTask(api, ids[0]);
          return [task.status, task.assigned_to_team];
        })
        .toEqual(['in_progress', team.id]);
    } finally {
      // The board and its cards first (hard: a soft-deleted board keeps them), since a team with active
      // tasks cannot be deleted
      await api.delete(`/api/v1/kanban/boards/${board.id}`, { params: { hard_delete: true } });
      expect((await api.delete(`/api/v1/teams/teams/${team.id}`)).status()).toBe(200);
    }
  });

  test('a move the server refuses puts the card back', async ({ page, api }) => {
    await page.route('**/api/v1/kanban/tasks/*/move', (route) =>
      route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ detail: 'Forbidden' }) }),
    );
    await drag(page, card(page, titles[0]), cell(page, 'unassigned', 'done'));

    await expect(card(cell(page, 'unassigned', 'todo'), titles[0])).toBeVisible();
    await expect(card(cell(page, 'unassigned', 'done'), titles[0])).toHaveCount(0);
    expect((await getTask(api, ids[0])).status).toBe('todo');
  });
});
