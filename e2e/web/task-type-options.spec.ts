import { test, expect, requireWeb, requireAuth } from '../src/fixtures';

/** Follow-up cards come only from the follow-up sync (the API refuses task_type patient_followup with 422),
 * so the New Task dialog doesn't offer that type. */
test.describe('New Task dialog types', () => {
  requireWeb();
  requireAuth();

  test('offers every type except Patient follow-up', async ({ page }) => {
    await page.goto('/dashboard/tasks');
    await page.getByRole('button', { name: 'New Task' }).click();
    const types = page.getByLabel('Task Type');
    await expect(types).toBeVisible();
    expect(await types.locator('option').allTextContents()).toEqual([
      'Clinical', 'Administrative', 'Technical', 'Documentation', 'Training', 'Other',
    ]);
  });
});
