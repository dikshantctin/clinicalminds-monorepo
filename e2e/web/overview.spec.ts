import { test, expect, requireWeb, requireAuth } from '../src/fixtures';

test.describe('dashboard overview', () => {
  requireWeb();
  requireAuth();

  test('shows the four live numbers from /analytics/overview', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByTestId('clinic-overview')).toBeVisible();
    for (const key of ['sessions_this_week', 'no_shows_this_week', 'patients_needing_followup']) {
      await expect(page.getByTestId(`overview-${key}`).getByTestId('stat-tile-value'), key).toHaveText(/^\d+$/);
    }
    await expect(page.getByTestId('overview-revenue_collected').getByTestId('stat-tile-value')).toHaveText(/^₹[\d,]+$/);
    await expect(page.getByText('System Uptime')).toHaveCount(0);
  });
});
