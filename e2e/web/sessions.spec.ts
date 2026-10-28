import { test, expect, expectNoCrash, requireWeb, requireAuth } from '../src/fixtures';
import { uniq } from '../src/env';

test.describe('sessions UI', () => {
  requireWeb();
  requireAuth();

  test('list page renders', async ({ page }) => {
    await page.goto('/dashboard/sessions');
    await expect(page.getByRole('heading', { name: 'Session Management' })).toBeVisible();
  });

  test('new-session page renders without crashing', async ({ page }) => {
    await page.goto('/dashboard/sessions/new');
    await expect(page).toHaveURL(/\/dashboard\/sessions\/new$/);
    await expectNoCrash(page);
    await expect(page.locator('form, button[type="submit"]').first()).toBeVisible();
  });

  test('session detail page opens for an API-created session', async ({ page, api }) => {
    const patient = await (await api.post('/api/v1/patients/', { data: { first_name: uniq('SessUI'), last_name: 'Patient' } })).json();
    try {
      const session = await (
        await api.post('/api/v1/sessions/', {
          data: { patient_id: patient.id, scheduled_at: new Date(Date.now() + 86_400_000).toISOString() },
        })
      ).json();
      await page.goto(`/dashboard/sessions/${session.id}`);
      await expect(page).toHaveURL(new RegExp(`/dashboard/sessions/${session.id}$`));
      await expectNoCrash(page);
    } finally {
      await api.delete(`/api/v1/patients/${patient.id}`);
    }
  });
});
