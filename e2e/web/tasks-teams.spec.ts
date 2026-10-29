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

test.describe('clinical follow-up queue (UI)', () => {
  requireWeb();
  requireAuth();

  test('a missed session shows up as a follow-up card on the Follow-up queue board', async ({ page, api }) => {
    const patient = await (await api.post('/api/v1/patients/', { data: { first_name: uniq('Queue'), last_name: 'Patient' } })).json();
    const session = await (
      await api.post('/api/v1/sessions/', { data: { patient_id: patient.id, scheduled_at: new Date(Date.now() + 86_400_000).toISOString() } })
    ).json();
    await api.put(`/api/v1/sessions/${session.id}`, { data: { scheduled_at: new Date(Date.now() - 3 * 3_600_000).toISOString() } });
    try {
      await page.goto('/dashboard/tasks');
      await expect(page.getByTestId('followup-summary')).toBeVisible({ timeout: 15_000 });
      await page.getByRole('combobox').first().selectOption({ label: 'Follow-up queue' });
      const card = page.getByText(`Missed session: ${patient.first_name} Patient`);
      await expect(card).toHaveCount(1, { timeout: 15_000 }); // exactly one: concurrent syncs must not duplicate
      // card markup: div.relative > [div.flex > h4.title, span.priority] + span[data-testid=followup-reason]
      await expect(card.locator('..').locator('..').getByTestId('followup-reason')).toHaveText('Missed session');
    } finally {
      await api.post(`/api/v1/sessions/${session.id}/cancel`, { data: { reason: 'e2e cleanup' } });
      await api.delete(`/api/v1/patients/${patient.id}`);
    }
  });
});
