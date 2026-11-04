import type { Page } from '@playwright/test';
import { test, expect, expectNoCrash, requireWeb, requireAuth } from '../src/fixtures';
import { uniq, DEMO_THERAPIST, DEMO_PSYCHOLOGIST } from '../src/env';

/**
 * Tasks → Assignee filter: besides "My Tasks" and the teams, it lists every active staff member
 * (GET /teams/users), so a director can see one person's cards. Exact counts over a board this spec owns.
 */
const cards = (page: Page) => page.getByTestId('task-card');

test.describe('task board: filter by any staff member', () => {
  requireWeb();
  requireAuth();

  test('picking a person shows only their cards; a person with none shows the no-match state', async ({ page, api }) => {
    const users: { id: string; email: string }[] = (await (await api.get('/api/v1/teams/users')).json()).users;
    const idOf = (email: string) => {
      const user = users.find((u) => u.email === email);
      expect(user, `${email} is seeded staff`).toBeTruthy();
      return user!.id;
    };
    const jane = idOf(DEMO_THERAPIST.email);
    const john = idOf(DEMO_PSYCHOLOGIST.email);

    const board = await (await api.post('/api/v1/kanban/boards', { data: { name: uniq('Assignee Board') } })).json();
    const mk = async (title: string, status: string, assignee?: string) => {
      const res = await api.post('/api/v1/kanban/tasks', {
        data: { board_id: board.id, title, status, ...(assignee ? { assigned_to_user: assignee } : {}) },
      });
      expect(res.status(), await res.text()).toBe(200);
    };
    const janeTitles = [uniq('Jane todo'), uniq('Jane review')];
    const johnTitle = uniq('John todo');
    const nobodyTitle = uniq('Unassigned');
    try {
      await mk(janeTitles[0], 'todo', jane);
      await mk(janeTitles[1], 'review', jane);
      await mk(johnTitle, 'in_progress', john);
      await mk(nobodyTitle, 'todo');

      await page.goto('/dashboard/tasks');
      await page.getByRole('combobox', { name: 'Board' }).selectOption(board.id);
      await expect(cards(page)).toHaveCount(4);
      await expect(page.getByTestId('tasks-no-match')).toHaveCount(0);

      const filter = page.getByTestId('filter-assignee');
      await filter.selectOption({ label: 'Jane Doe' });
      await expect(cards(page)).toHaveCount(2);
      for (const title of janeTitles) await expect(cards(page).filter({ hasText: title })).toHaveCount(1);
      await expect(page.getByTestId('kanban-count-todo')).toHaveText('1');
      await expect(page.getByTestId('kanban-count-review')).toHaveText('1');

      await filter.selectOption({ label: 'John Smith' });
      await expect(cards(page)).toHaveCount(1);
      await expect(cards(page).filter({ hasText: johnTitle })).toHaveCount(1);

      // the admin has no cards on this board
      await filter.selectOption({ label: 'Demo Admin' });
      await expect(cards(page)).toHaveCount(0);
      await expect(page.getByTestId('tasks-no-match')).toHaveText('No tasks match these filters');

      await filter.selectOption({ label: 'All Assignees' });
      await expect(cards(page)).toHaveCount(4);
      await expectNoCrash(page);
    } finally {
      await api.delete(`/api/v1/kanban/boards/${board.id}?hard_delete=true`);
    }
  });
});
