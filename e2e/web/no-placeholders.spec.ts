import { test, expect, requireWeb, requireAuth } from '../src/fixtures';
import { uniq } from '../src/env';

/**
 * Nothing on screen promises a feature that does not exist: no "AI Insights", no "Coming soon" badges or
 * disabled stand-in controls, no settings tabs whose every control is disabled, and no dev Auth Debug panel.
 */
test.describe('no placeholders', () => {
  requireWeb();
  requireAuth();

  test('the dashboard shell has no Auth Debug panel', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: /Welcome back,/ }).first()).toBeVisible();
    await expect(page.getByText('Auth Debug')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Clear Auth' })).toHaveCount(0);
  });

  test('settings: no Data Export or Security tabs; Billing shows the plan without "Coming soon"', async ({ page }) => {
    await page.goto('/dashboard/settings');
    const tabs = page.getByRole('tab');
    await expect(tabs.first()).toBeVisible();
    await expect(page.getByRole('tab', { name: /Data Export/ })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: /Security/ })).toHaveCount(0);
    await page.getByRole('tab', { name: /Billing/ }).click();
    await expect(page.getByText('Current Subscription')).toBeVisible();
    await expect(page.getByText(/coming soon/i)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Manage Subscription' })).toHaveCount(0);
  });

  test('a session detail page has no AI Insights card', async ({ page, api }) => {
    const patient = await (await api.post('/api/v1/patients/', { data: { first_name: uniq('NoAI'), last_name: 'Patient' } })).json();
    try {
      const session = await (
        await api.post('/api/v1/sessions/', { data: { patient_id: patient.id, scheduled_at: new Date(Date.now() + 3 * 3_600_000).toISOString() } })
      ).json();
      await page.goto(`/dashboard/sessions/${session.id}`);
      await expect(page.getByTestId('session-risk-flag')).toBeVisible();
      await expect(page.getByText('AI Insights')).toHaveCount(0);
      await expect(page.getByText(/coming soon/i)).toHaveCount(0);
    } finally {
      await api.delete(`/api/v1/patients/${patient.id}`);
    }
  });
});
