import { test, expect, requireAuth, requireWeb } from '../src/fixtures';

/** Phone width (iPhone 12-15). Nothing in the app shell may scroll sideways at this size. */
const PHONE = { width: 390, height: 844 };

const pageWidth = (page: import('@playwright/test').Page) =>
  page.evaluate(() => document.documentElement.scrollWidth);

test.describe('app shell at 390 px', () => {
  requireWeb();
  requireAuth();
  test.use({ viewport: PHONE });

  test('the dashboard does not scroll sideways', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByTestId('notification-bell')).toBeVisible();
    await expect(page.getByTestId('user-menu')).toBeVisible();
    expect(await pageWidth(page)).toBeLessThanOrEqual(PHONE.width);
  });

  test('the notifications panel lies fully inside the viewport', async ({ page }) => {
    await page.goto('/dashboard');
    await page.getByTestId('notification-bell').click();
    const panel = page.getByTestId('notification-panel');
    await expect(panel).toBeVisible();
    const box = (await panel.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width);
    expect(await pageWidth(page)).toBeLessThanOrEqual(PHONE.width);
  });

  test('Settings → Payments does not scroll sideways', async ({ page }) => {
    await page.goto('/dashboard/settings');
    await page.getByRole('tab', { name: 'Payments' }).click();
    await expect(page.getByTestId('payments-status')).toBeVisible();
    expect(await pageWidth(page)).toBeLessThanOrEqual(PHONE.width);
  });
});
