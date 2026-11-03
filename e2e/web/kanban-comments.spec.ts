import { request as pwRequest } from '@playwright/test';
import { test, expect, expectNoCrash, requireWeb, requireAuth } from '../src/fixtures';
import { env, uniq, DEMO_THERAPIST } from '../src/env';
import { LoginPage } from '../src/pages/login.page';

/**
 * Task comments and history in the task dialog: the admin comments on a card and @mentions the demo
 * therapist (Jane Doe) from a staff picker; the comment and a history row show at once. Jane gets the
 * mention in her notification bell, and the notification opens the task with the comment on it.
 */
test.describe('task dialog: comments with mentions, and history', () => {
  requireWeb();
  requireAuth();

  test('admin comments mentioning the therapist; the therapist opens it from the bell', async ({ page, api, browser }) => {
    const anon = await pwRequest.newContext({ baseURL: env.API_URL });
    const login = await anon.post('/api/v1/auth/login', { data: { ...DEMO_THERAPIST, audience: 'staff' } });
    expect(login.status(), await login.text()).toBe(200);
    const janeLogin = await login.json();
    await anon.dispose();
    const jane = await pwRequest.newContext({
      baseURL: env.API_URL,
      extraHTTPHeaders: { Authorization: `Bearer ${janeLogin.access_token}`, 'X-Tenant-ID': janeLogin.tenant.id },
    });

    const boardRes = await api.post('/api/v1/kanban/boards', { data: { name: uniq('Comment Board') } });
    expect(boardRes.status(), await boardRes.text()).toBe(200);
    const board = await boardRes.json();
    const title = uniq('Comment Task');
    const text = uniq('Please call the patient back');
    const janeContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    try {
      const taskRes = await api.post('/api/v1/kanban/tasks', { data: { board_id: board.id, title, status: 'todo' } });
      expect(taskRes.status(), await taskRes.text()).toBe(200);
      const task = await taskRes.json();
      expect((await api.put(`/api/v1/kanban/tasks/${task.id}`, { data: { status: 'in_progress' } })).status()).toBe(200);

      await page.goto('/dashboard/tasks');
      await page.getByRole('combobox', { name: 'Board' }).selectOption(board.id);
      await page.getByTestId('task-card').filter({ hasText: title }).getByRole('button', { name: title }).click();
      const dialog = page.getByRole('dialog', { name: title });
      await expect(dialog.getByTestId('task-history')).toContainText('Demo Admin moved to In progress');
      await expect(dialog.getByTestId('task-comments')).toContainText('No comments yet');

      // blank comments cannot be sent
      const submit = dialog.getByTestId('task-comment-submit');
      await expect(submit).toBeDisabled();
      await dialog.getByTestId('task-comment-input').fill('   ');
      await expect(submit).toBeDisabled();

      await dialog.getByTestId('task-comment-input').fill(text);
      await dialog.getByTestId('task-comment-mentions').getByLabel('Jane Doe').check();
      await submit.click();

      await expect.poll(async () => (await (await api.get(`/api/v1/kanban/tasks/${task.id}/comments`)).json()).length).toBe(1);
      const [comment] = await (await api.get(`/api/v1/kanban/tasks/${task.id}/comments`)).json();
      expect(comment).toEqual(expect.objectContaining({ content: text, mentions: [janeLogin.user.id], author_name: 'Demo Admin' }));
      await expect(dialog.getByTestId(`task-comment-${comment.id}`)).toContainText(text);
      await expect(dialog.getByTestId(`task-comment-${comment.id}`)).toContainText('Demo Admin');
      await expect(dialog.getByTestId('task-comment-input')).toHaveValue('');
      await expect(dialog.getByTestId('task-comment-mentions').getByLabel('Jane Doe')).not.toBeChecked();

      const detail = await (await api.get(`/api/v1/kanban/tasks/${task.id}`)).json();
      const commented = detail.recent_activities[0];
      expect(commented.action).toBe('commented');
      await expect(dialog.getByTestId(`task-activity-${commented.id}`)).toHaveText(/^Demo Admin commented/);
      await expectNoCrash(page);

      // Jane sees the mention in her bell; it opens the task with the comment
      const notifications: { id: string; task_id: string; type: string }[] = await (
        await jane.get('/api/v1/kanban/notifications')
      ).json();
      const mention = notifications.filter((n) => n.task_id === task.id && n.type === 'mentioned');
      expect(mention).toHaveLength(1);

      const janePage = await janeContext.newPage();
      const loginPage = new LoginPage(janePage);
      await loginPage.goto();
      await loginPage.login(DEMO_THERAPIST.email, DEMO_THERAPIST.password);
      await janePage.getByTestId('notification-bell').click();
      const row = janePage.getByTestId(`notification-${mention[0].id}`);
      await expect(row).toContainText(`Demo Admin mentioned you in a comment on task: ${title}`);
      await row.click();
      const janeDialog = janePage.getByRole('dialog', { name: title });
      await expect(janeDialog.getByTestId(`task-comment-${comment.id}`)).toContainText(text);
      await expectNoCrash(janePage);
    } finally {
      await janeContext.close();
      await api.delete(`/api/v1/kanban/boards/${board.id}?hard_delete=true`);
      await jane.dispose();
    }
  });
});
