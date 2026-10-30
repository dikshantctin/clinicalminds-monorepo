import { request as pwRequest } from '@playwright/test';
import { test, expect, expectNoCrash, requireWeb, requireAuth } from '../src/fixtures';
import { env, uniq, RANDOM_UUID, DEMO_THERAPIST } from '../src/env';

/**
 * Clicking a notification in the bell panel marked it read and did nothing else. Every notification row
 * carries the task it is about (task_id), so the click now opens that task on the kanban
 * (/dashboard/tasks?task=<id> → its board + the task dialog).
 */
test.describe('notification bell: a notification opens its task', () => {
  requireWeb();
  requireAuth();

  test('clicking a task-assigned notification opens the task and marks it read', async ({ page, api, auth }) => {
    // The therapist assigns a task to the E2E user: the backend notifies the assignee (not self-assignments)
    const anon = await pwRequest.newContext({ baseURL: env.API_URL });
    const login = await anon.post('/api/v1/auth/login', { data: DEMO_THERAPIST });
    expect(login.status(), await login.text()).toBe(200);
    const body = await login.json();
    await anon.dispose();
    const therapist = await pwRequest.newContext({
      baseURL: env.API_URL,
      extraHTTPHeaders: { Authorization: `Bearer ${body.access_token}`, 'X-Tenant-ID': body.tenant.id },
    });

    const boardRes = await therapist.post('/api/v1/kanban/boards', { data: { name: uniq('Notify Board') } });
    expect(boardRes.status(), await boardRes.text()).toBe(200);
    const board = await boardRes.json();
    const title = uniq('Notify Task');
    try {
      const taskRes = await therapist.post('/api/v1/kanban/tasks', {
        data: { board_id: board.id, title, status: 'todo', assigned_to_user: auth.user!.id },
      });
      expect(taskRes.status(), await taskRes.text()).toBe(200);
      const task = await taskRes.json();

      const notifications: { id: string; task_id: string; is_read: boolean }[] =
        await (await api.get('/api/v1/kanban/notifications')).json();
      const notification = notifications.find((n) => n.task_id === task.id);
      expect(notification, 'assignee was notified').toBeTruthy();
      expect(notification!.is_read).toBe(false);

      await page.goto('/dashboard');
      await page.getByTestId('notification-bell').click();
      await page.getByTestId(`notification-${notification!.id}`).click();

      await expect(page).toHaveURL(/\/dashboard\/tasks$/); // ?task= is dropped once the task is open
      // the Headless UI dialog root is a zero-height wrapper, so check its title instead of the root
      await expect(page.getByRole('dialog', { name: title }).getByRole('heading', { name: title })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('combobox').first()).toHaveValue(board.id); // the task's board is selected
      await expect(page.getByText(title)).toBeVisible(); // and its card is on the board
      await expect
        .poll(async () => {
          const rows: { id: string; is_read: boolean }[] = await (await api.get('/api/v1/kanban/notifications')).json();
          return rows.find((n) => n.id === notification!.id)?.is_read;
        })
        .toBe(true);
      await expectNoCrash(page);
    } finally {
      await therapist.delete(`/api/v1/kanban/boards/${board.id}`);
      await therapist.dispose();
    }
  });

  test('a link to a task that does not exist says so and opens nothing', async ({ page }) => {
    await page.goto(`/dashboard/tasks?task=${RANDOM_UUID}`);
    await expect(page.getByText('That task is no longer available')).toBeVisible();
    await expect(page).toHaveURL(/\/dashboard\/tasks$/);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expectNoCrash(page);
  });
});
