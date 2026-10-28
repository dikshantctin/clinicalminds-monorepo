import { test, expect, expectNoCrash, requireWeb, requireAuth } from '../src/fixtures';
import { uniq } from '../src/env';

test.describe('tasks (kanban) UI', () => {
  requireWeb();
  requireAuth();

  test('board page renders', async ({ page }) => {
    await page.goto('/dashboard/tasks');
    await expect(page.getByRole('heading', { name: 'Task Management' })).toBeVisible();
    await expectNoCrash(page);
  });

  test('an API-created task appears on the board', async ({ page, api }) => {
    const boardRes = await api.post('/api/v1/kanban/boards', { data: { name: uniq('UI Board') } });
    expect(boardRes.status(), await boardRes.text()).toBe(200);
    const board = await boardRes.json();
    const title = uniq('UI Task');
    try {
      const taskRes = await api.post('/api/v1/kanban/tasks', { data: { board_id: board.id, title, status: 'todo' } });
      expect(taskRes.status(), await taskRes.text()).toBe(200);
      await page.goto('/dashboard/tasks');
      await expect(page.getByText(title)).toBeVisible({ timeout: 15_000 });
    } finally {
      await api.delete(`/api/v1/kanban/boards/${board.id}`);
    }
  });
});

test.describe('teams UI', () => {
  requireWeb();
  requireAuth();

  test('teams page renders', async ({ page }) => {
    await page.goto('/dashboard/teams');
    await expect(page.getByRole('heading', { name: 'Team Management' })).toBeVisible();
  });

  test('an API-created team is listed', async ({ page, api }) => {
    const name = uniq('UI Team');
    const team = await (await api.post('/api/v1/teams/teams', { data: { name, team_type: 'CLINICAL', color: '#3B82F6' } })).json();
    try {
      await page.goto('/dashboard/teams');
      await expect(page.getByText(name)).toBeVisible({ timeout: 15_000 });
    } finally {
      await api.delete(`/api/v1/teams/teams/${team.id}`);
    }
  });
});
