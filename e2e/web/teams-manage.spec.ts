import { test, expect, expectNoCrash, requireWeb, requireAuth } from '../src/fixtures';
import { uniq, DEMO_THERAPIST, DEMO_PATIENT } from '../src/env';

/**
 * Remove member and delete team open a ConfirmDialog on top of the team detail dialog. They used to
 * do nothing: the click in the confirm dialog closed the detail dialog first, which cleared the
 * selected team the confirm handlers needed.
 */
test.describe('teams UI: remove member, delete team', () => {
  requireWeb();
  requireAuth();

  test('removing a member and deleting the team take effect', async ({ page, api }) => {
    const users: { id: string; email: string }[] = (await (await api.get('/api/v1/teams/users')).json()).users;
    const therapist = users.find((u) => u.email === DEMO_THERAPIST.email);
    expect(therapist, 'demo therapist is seeded').toBeTruthy();

    const name = uniq('UI Manage Team');
    const teamRes = await api.post('/api/v1/teams/teams', { data: { name, team_type: 'CLINICAL', color: '#3B82F6' } });
    expect(teamRes.status(), await teamRes.text()).toBe(200);
    const team = await teamRes.json();
    const memberIds = async (): Promise<string[]> =>
      ((await (await api.get(`/api/v1/teams/teams/${team.id}`)).json()).members ?? []).map((m: { user_id: string }) => m.user_id);
    try {
      const add = await api.post(`/api/v1/teams/teams/${team.id}/members`, { data: { user_id: therapist!.id, role: 'MEMBER' } });
      expect(add.status(), await add.text()).toBe(200);

      await page.goto('/dashboard/teams');
      await page.getByTestId(`team-card-${team.id}`).press('Enter'); // the dev Auth Debug panel can cover the card
      const detail = page.getByRole('dialog', { name });
      await expect(detail.getByTestId('team-delete')).toBeVisible();

      // the member picker never offers patients
      await detail.getByRole('button', { name: 'Manage Members' }).click();
      await expect(detail.getByRole('option', { name: /Patient/ })).toHaveCount(0);
      await expect(detail.locator('option', { hasText: DEMO_PATIENT.email })).toHaveCount(0);

      await detail.getByTestId(`team-member-remove-${therapist!.id}`).click();
      await page.getByTestId('team-remove-member-confirm').click();
      await expect(page.getByText('Member removed successfully')).toBeVisible();
      await expect.poll(memberIds).not.toContain(therapist!.id);
      await expect(detail.getByTestId(`team-member-remove-${therapist!.id}`)).toHaveCount(0);

      // no open tasks → straight to the confirm dialog, then the team is soft-deleted
      await detail.getByTestId('team-delete').click();
      await page.getByTestId('team-delete-dialog-confirm').click();
      await expect(page.getByText('Team deleted successfully')).toBeVisible();
      await expect.poll(async () => (await (await api.get(`/api/v1/teams/teams/${team.id}`)).json()).is_active).toBe(false);
      await expectNoCrash(page);
    } finally {
      await api.delete(`/api/v1/teams/teams/${team.id}`);
    }
  });

  test('a team with an open task opens the reassign dialog instead of deleting', async ({ page, api }) => {
    const board = await (await api.post('/api/v1/kanban/boards', { data: { name: uniq('UI Reassign Board') } })).json();
    const name = uniq('UI Busy Team');
    const team = await (await api.post('/api/v1/teams/teams', { data: { name, team_type: 'CLINICAL', color: '#3B82F6' } })).json();
    const title = uniq('Open team task');
    const taskIds: string[] = [];
    try {
      for (const [t, status] of [[title, 'todo'], [uniq('Done team task'), 'done']]) {
        const res = await api.post('/api/v1/kanban/tasks', { data: { board_id: board.id, title: t, status, assigned_to_team: team.id } });
        expect(res.status(), await res.text()).toBe(200);
        taskIds.push((await res.json()).id);
      }
      await page.goto('/dashboard/teams');
      await page.getByTestId(`team-card-${team.id}`).press('Enter'); // the dev Auth Debug panel can cover the card
      await page.getByRole('dialog', { name }).getByTestId('team-delete').click();
      const reassign = page.getByTestId('team-reassign-dialog');
      await expect(reassign).toBeVisible();
      await expect(reassign.getByTestId('team-reassign-task')).toHaveCount(1); // the done task is not "active"
      await expect(reassign.getByRole('heading', { name: title })).toBeVisible();
      expect((await (await api.get(`/api/v1/teams/teams/${team.id}`)).json()).is_active).toBe(true);
    } finally {
      for (const id of taskIds) await api.delete(`/api/v1/kanban/tasks/${id}`);
      await api.delete(`/api/v1/kanban/boards/${board.id}`);
      await api.delete(`/api/v1/teams/teams/${team.id}`);
    }
  });

  test('the task assignee picker shows role labels and no patients', async ({ page }) => {
    await page.goto('/dashboard/tasks');
    await page.getByRole('button', { name: 'New Task' }).click();
    const picker = page.getByLabel('Assign to User (Optional)');
    await expect(picker.locator('option', { hasText: '(Therapist)' }).first()).toBeAttached();
    const labels = await picker.locator('option').allTextContents();
    expect(labels.filter((l) => /\((ADMIN|THERAPIST|PSYCHOLOGIST|CLINICAL_DIRECTOR|INTERN|SUPPORT_STAFF|PATIENT|Patient)\)/.test(l))).toEqual([]);
  });
});
