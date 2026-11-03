import { request as pwRequest, type APIRequestContext } from '@playwright/test';
import { test, expect, requireWeb, requireAuth } from '../src/fixtures';
import { env, uniq } from '../src/env';

/**
 * A director scanning the board sees which cards are overdue (due before today, clinic time, still
 * open) and can narrow the board to just those.
 */
test.describe('overdue cards on the task board', () => {
  requireWeb();
  requireAuth();

  let api: APIRequestContext;
  let board: { id: string };
  const late = uniq('Late report');
  const later = uniq('Next week plan');
  const closed = uniq('Closed late');
  const DAY = 86_400_000;

  test.beforeEach(async () => {
    api = await pwRequest.newContext({
      baseURL: env.API_URL,
      extraHTTPHeaders: { Authorization: `Bearer ${process.env.E2E_TOKEN ?? ''}`, 'X-Tenant-ID': process.env.E2E_TENANT_ID ?? '' },
    });
    board = await (await api.post('/api/v1/kanban/boards', { data: { name: uniq('Overdue UI Board') } })).json();
    const mk = async (title: string, status: string, dueInMs: number) => {
      const res = await api.post('/api/v1/kanban/tasks', {
        data: { board_id: board.id, title, status, due_date: new Date(Date.now() + dueInMs).toISOString() },
      });
      expect(res.status(), await res.text()).toBe(200);
    };
    await mk(late, 'todo', -3 * DAY);
    await mk(later, 'todo', 7 * DAY);
    await mk(closed, 'done', -3 * DAY);
  });

  test.afterEach(async () => {
    await api.delete(`/api/v1/kanban/boards/${board.id}`);
    await api.dispose();
  });

  test('only the open card past its due day carries the badge, and "Overdue only" narrows the board to it', async ({ page }) => {
    await page.goto('/dashboard/tasks');
    await page.getByRole('combobox', { name: 'Board' }).selectOption(board.id);
    const cards = page.getByTestId('task-card');
    await expect(cards).toHaveCount(3);

    await expect(page.getByTestId('task-overdue')).toHaveCount(1);
    await expect(cards.filter({ hasText: late }).getByTestId('task-overdue')).toHaveText('Overdue');
    await expect(cards.filter({ hasText: later }).getByTestId('task-overdue')).toHaveCount(0);
    await expect(cards.filter({ hasText: closed }).getByTestId('task-overdue')).toHaveCount(0);

    const toggle = page.getByRole('switch', { name: 'Overdue only' });
    await toggle.click();
    await expect(toggle).toBeChecked();
    await expect(cards).toHaveCount(1);
    await expect(cards).toContainText(late);

    await toggle.click();
    await expect(cards).toHaveCount(3);
  });
});
