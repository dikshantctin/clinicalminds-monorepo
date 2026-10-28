import { test, expect, expectNoCrash, requireWeb, requireAuth } from '../src/fixtures';

test.describe('crisis, analytics, AI assistant, settings', () => {
  requireWeb();
  requireAuth();

  test('crisis management page renders', async ({ page }) => {
    await page.goto('/dashboard/crisis');
    await expect(page.getByRole('heading', { name: 'Crisis Management' })).toBeVisible();
  });

  test('analytics page renders', async ({ page }) => {
    await page.goto('/dashboard/analytics');
    await expect(page.getByRole('heading', { name: 'Analytics' })).toBeVisible();
  });

  test('AI assistant page renders', async ({ page }) => {
    await page.goto('/dashboard/ai-assistant');
    await expect(page).toHaveURL(/\/dashboard\/ai-assistant$/);
    await expect(page.getByRole('heading').first()).toBeVisible();
    await expectNoCrash(page);
  });

  test('settings page renders', async ({ page }) => {
    await page.goto('/dashboard/settings');
    await expect(page).toHaveURL(/\/dashboard\/settings$/);
    await expectNoCrash(page);
  });

  test('admin catalog pages render for an admin', async ({ page }) => {
    for (const path of ['/admin/services', '/admin/locations']) {
      await page.goto(path);
      await expect(page, path).toHaveURL(new RegExp(`${path}$`));
      await expectNoCrash(page);
    }
  });
});
