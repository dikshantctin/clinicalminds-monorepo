import { request as pwRequest, type APIRequestContext, type Page } from '@playwright/test';
import { test, expect, requireWeb, requireAuth } from '../src/fixtures';
import { env, uniq } from '../src/env';

/**
 * A busy board (the Follow-up queue of a large clinic holds thousands of cards) must stay draggable.
 * Rendering every card made each drag re-render all of them: on 4,500 cards one drag froze the page
 * for ~30 s, which users saw as "drag and drop does not work".
 */
const CARDS = 1000;
const SHOWN_PER_CELL = 50;
/**
 * Press to "card shown in the new column", as a loose upper bound only: wall-clock time flakes when CI or the
 * machine is busy (2.06 s was seen under load against a 2 s budget). Uncapped, 1,000 cards took 3.9-4.0 s on a dev
 * box; capped, well under 1 s. What made drags slow was every card being mounted (each a dnd-kit sortable that
 * re-renders on every drag move), so the tests assert that structurally: only SHOWN_PER_CELL cards are mounted.
 */
const DRAG_BUDGET_MS = 6_000;

const cell = (page: Page, status: string) => page.getByTestId(`kanban-cell-unassigned-${status}`);
const cardIn = (page: Page, status: string, title: string) =>
  cell(page, status).getByTestId('task-card').filter({ hasText: title });

/** Press on `from`, move to (x, y), release: a pointer drag past the 8px activation distance. */
const drag = async (page: Page, from: { x: number; y: number; width: number }, x: number, y: number) => {
  await page.mouse.move(from.x + from.width / 2, from.y + 20);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 10 });
  await page.mouse.up();
};

test.describe('task board with many cards', () => {
  requireWeb();
  requireAuth();
  test.describe.configure({ mode: 'serial' }); // one 1,000-card board shared by the tests, in order
  test.use({ viewport: { width: 1440, height: 1600 } });
  test.setTimeout(120_000);

  let api: APIRequestContext;
  let board: { id: string };
  const titles = Array.from({ length: CARDS }, (_, i) => uniq(`Scale ${String(i).padStart(4, '0')}`));

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    api = await pwRequest.newContext({
      baseURL: env.API_URL,
      extraHTTPHeaders: { Authorization: `Bearer ${process.env.E2E_TOKEN ?? ''}`, 'X-Tenant-ID': process.env.E2E_TENANT_ID ?? '' },
    });
    board = await (await api.post('/api/v1/kanban/boards', { data: { name: uniq('Scale Board') } })).json();
    for (let i = 0; i < CARDS; i += 25) {
      await Promise.all(
        titles.slice(i, i + 25).map(async (title, j) => {
          const res = await api.post('/api/v1/kanban/tasks', {
            data: { board_id: board.id, title, status: 'todo', position: i + j },
          });
          expect(res.status(), await res.text()).toBe(200);
        }),
      );
    }
  });

  const inProgress = async (): Promise<{ title: string }[]> =>
    (await (await api.get('/api/v1/kanban/tasks', { params: { board_id: board.id, status: 'in_progress' } })).json()).tasks;

  test.afterAll(async () => {
    await api.delete(`/api/v1/kanban/boards/${board.id}`);
    await api.dispose();
  });

  test.beforeEach(async ({ page }) => {
    await page.goto('/dashboard/tasks');
    await page.getByRole('combobox', { name: 'Board' }).selectOption(board.id);
    await expect(page.getByTestId('kanban-count-todo')).not.toHaveText('0', { timeout: 30_000 });
  });

  test('a busy cell shows its first cards and reveals the rest on request', async ({ page }) => {
    await expect(page.getByTestId('kanban-count-todo')).toHaveText(String(CARDS));
    const todo = cell(page, 'todo');
    await expect(todo.getByTestId('task-card')).toHaveCount(SHOWN_PER_CELL);
    const more = todo.getByTestId('kanban-show-more');
    await expect(more).toHaveText(`Show ${CARDS - SHOWN_PER_CELL} more`);

    await more.click();
    await expect(todo.getByTestId('task-card')).toHaveCount(SHOWN_PER_CELL * 2);
    await expect(more).toHaveText(`Show ${CARDS - SHOWN_PER_CELL * 2} more`);
  });

  test('a card on a busy board moves, with only one page of cards mounted', async ({ page }) => {
    // 1,000 cards on the board, 50 in the DOM: the drag's re-renders stay bounded by the cap, not the board size
    await expect(page.getByTestId('task-card')).toHaveCount(SHOWN_PER_CELL);
    const from = (await cardIn(page, 'todo', titles[0]).boundingBox())!;
    const to = (await cell(page, 'in_progress').boundingBox())!;

    const started = Date.now();
    await page.mouse.move(from.x + from.width / 2, from.y + 20);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + 60, { steps: 10 });
    // mid-drag nothing else mounts (the drag overlay is the one extra card)
    await expect(page.getByTestId('task-card')).toHaveCount(SHOWN_PER_CELL + 1);
    await page.mouse.up();
    await expect(cardIn(page, 'in_progress', titles[0])).toBeVisible({ timeout: DRAG_BUDGET_MS });
    expect(Date.now() - started).toBeLessThan(DRAG_BUDGET_MS);

    // The card shows before its move request lands (optimistic update); wait for the server
    await expect.poll(async () => (await inProgress()).map((t) => t.title)).toEqual([titles[0]]);
  });

  test('a card dropped on the empty space of a busy cell stays in sight', async ({ page }) => {
    // The previous test left titles[0] alone in In progress; drop it below the To do cell's cards.
    await expect(cardIn(page, 'in_progress', titles[0])).toBeVisible();
    const from = (await cardIn(page, 'in_progress', titles[0]).boundingBox())!;
    const todo = (await cell(page, 'todo').boundingBox())!;

    await drag(page, from, todo.x + todo.width / 2, todo.y + todo.height - 6); // the cell footer, not a card
    await expect(cardIn(page, 'todo', titles[0])).toBeVisible({ timeout: DRAG_BUDGET_MS });
    await expect(cell(page, 'todo').getByTestId('task-card')).toHaveCount(SHOWN_PER_CELL);

    await expect.poll(async () => (await inProgress()).length).toBe(0);
  });

  test('opening the board runs no follow-up sync; Refresh follow-ups reloads it', async ({ page }) => {
    const syncs: string[] = [];
    const boardLoads: string[] = [];
    page.on('request', (req) => {
      const url = new URL(req.url());
      if (url.pathname === '/api/v1/kanban/followups/sync') syncs.push(req.url());
      if (url.pathname !== '/api/v1/kanban/tasks' || url.searchParams.get('board_id') !== board.id) return;
      if ((url.searchParams.get('page') ?? '1') === '1') boardLoads.push(req.url());
    });

    // The background worker keeps the queue current: a page view writes nothing
    await page.reload();
    await page.getByRole('combobox', { name: 'Board' }).selectOption(board.id);
    await expect(page.getByTestId('kanban-count-todo')).toHaveText(String(CARDS));
    await page.waitForTimeout(1_500);
    expect(syncs).toEqual([]);
    expect(boardLoads).toHaveLength(1);

    // The button syncs on demand and reloads the board, which may be older than the worker's last run
    const synced = page.waitForResponse((r) => r.url().endsWith('/api/v1/kanban/followups/sync'));
    await page.getByTestId('followup-refresh').click();
    expect((await synced).status()).toBe(200);
    await expect(page.getByTestId('followup-summary')).toBeVisible();
    await expect.poll(() => boardLoads.length).toBe(2);
  });
});
