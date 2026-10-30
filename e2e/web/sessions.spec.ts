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

  test('mark a session no-show from the list, then record a cash payment on it', async ({ page, api }) => {
    test.slow(); // the list fetches and renders every session of the clinic, three times over
    const patient = await (await api.post('/api/v1/patients/', { data: { first_name: uniq('NoShowUI'), last_name: 'Patient' } })).json();
    try {
      const session = await (
        await api.post('/api/v1/sessions/', { data: { patient_id: patient.id, scheduled_at: new Date(Date.now() + 2 * 3_600_000).toISOString() } })
      ).json();
      await page.goto('/dashboard/sessions');
      // the list renders every session of the clinic (hundreds after a few runs) → give it time
      const row = page.locator('tr', { hasText: patient.first_name });
      await expect(row).toBeVisible({ timeout: 20_000 });
      await row.getByTestId('session-no-show').click();
      await page.getByTestId('session-no-show-dialog-confirm').click(); // optional-reason dialog replaced window.prompt
      await expect.poll(async () => (await (await api.get(`/api/v1/sessions/${session.id}`)).json()).status, { timeout: 15_000 }).toBe('no_show');
      await expect(row).toContainText(/no.show/i, { timeout: 20_000 }); // the list re-fetches every session

      await row.getByTestId('session-record-payment').click();
      const dialog = page.getByTestId('record-payment-dialog');
      await dialog.getByTestId('record-payment-amount').fill('500');
      await dialog.getByTestId('record-payment-method').selectOption('cash');
      await dialog.getByTestId('record-payment-save').click();
      await expect(row.getByTestId('payment-status')).toHaveText(/Paid ₹500/, { timeout: 20_000 });
      const rows = await (await api.get(`/api/v1/sessions/${session.id}/payments`)).json();
      expect(rows).toEqual([expect.objectContaining({ provider: 'manual', method: 'cash', amount_paise: 50000, status: 'paid' })]);
    } finally {
      await api.delete(`/api/v1/patients/${patient.id}`);
    }
  });

  test('the session detail page saves a risk flag', async ({ page, api }) => {
    const patient = await (await api.post('/api/v1/patients/', { data: { first_name: uniq('RiskUI'), last_name: 'Patient' } })).json();
    try {
      const session = await (
        await api.post('/api/v1/sessions/', { data: { patient_id: patient.id, scheduled_at: new Date(Date.now() + 3 * 3_600_000).toISOString() } })
      ).json();
      await page.goto(`/dashboard/sessions/${session.id}`);
      await page.getByTestId('session-risk-flag').check();
      await page.getByTestId('session-risk-level').selectOption('high');
      await page.getByTestId('session-risk-notes').fill('e2e: safety plan reviewed');
      await page.getByTestId('session-risk-save').click();
      await expect.poll(async () => (await (await api.get(`/api/v1/sessions/${session.id}`)).json()).crisis_level).toBe('high');
      await page.goto('/dashboard/sessions');
      await expect(page.locator('tr', { hasText: patient.first_name }).getByTestId('session-risk-badge')).toHaveText(/Risk: high/, { timeout: 20_000 });
    } finally {
      await api.delete(`/api/v1/patients/${patient.id}`);
    }
  });
});
