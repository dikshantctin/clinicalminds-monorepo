import { request as pwRequest } from '@playwright/test';
import { test, expect, requireWeb, requireAuth } from '../src/fixtures';
import { env, DEMO_THERAPIST } from '../src/env';
import { OwnClinic, deleteClinic, onboardOwnClinic } from '../src/clinics';

/** Settings → Clinic hours (capacity slice b). A fresh clinic, so the demo clinic's hours never change. */
test.describe('Settings → Clinic hours', () => {
  requireWeb();
  requireAuth();
  test.describe.configure({ mode: 'serial' });

  let clinic: OwnClinic;
  test.beforeAll(async () => {
    clinic = await onboardOwnClinic('hoursui');
  });
  test.afterAll(async () => {
    await clinic?.api.dispose();
    if (clinic) await deleteClinic(clinic.adminEmail);
  });

  const signedIn = async (browser: import('@playwright/test').Browser, token: string, user: unknown, tenantId: string) => {
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    await context.addInitScript(
      ([t, u, id]) => {
        localStorage.setItem('auth_token', t);
        localStorage.setItem('auth_user', u);
        localStorage.setItem('tenant_id', id);
      },
      [token, JSON.stringify(user), tenantId],
    );
    return context;
  };

  test('an admin sets days, hours, a break, the buffer and a holiday; they are saved and shown again', async ({ browser }) => {
    const context = await signedIn(browser, clinic.token, clinic.user, clinic.tenantId);
    try {
      const page = await context.newPage();
      await page.goto('/dashboard/settings');
      await page.getByRole('tab', { name: 'Clinic hours' }).click();

      await expect(page.getByTestId('clinic-hours-day-7')).not.toBeChecked(); // Sunday closed by default
      await expect(page.getByTestId('clinic-hours-open')).toHaveValue('10:00');
      await page.getByTestId('clinic-hours-day-6').uncheck(); // close Saturday
      await page.getByTestId('clinic-hours-open').fill('09:00');
      await page.getByTestId('clinic-hours-close').fill('17:00');
      await page.getByTestId('clinic-hours-break-add').click();
      await page.getByTestId('clinic-hours-break-start-0').fill('13:00');
      await page.getByTestId('clinic-hours-break-end-0').fill('14:00');
      await page.getByTestId('clinic-hours-buffer').fill('15');
      await page.getByTestId('clinic-hours-holiday-date').fill('2027-01-26');
      await page.getByTestId('clinic-hours-holiday-name').fill('Republic Day');
      await page.getByTestId('clinic-hours-holiday-add').click();
      await expect(page.getByTestId('clinic-hours-holiday-0')).toContainText('Republic Day');
      await page.getByTestId('clinic-hours-save').click();
      await expect(page.getByText('Clinic hours saved')).toBeVisible();

      expect(await (await clinic.api.get('/api/v1/clinic-hours')).json()).toEqual({
        open_days: [1, 2, 3, 4, 5],
        open: '09:00',
        close: '17:00',
        breaks: [{ start: '13:00', end: '14:00' }],
        buffer_minutes: 15,
        holidays: [{ date: '2027-01-26', name: 'Republic Day' }],
      });

      await page.reload();
      await page.getByRole('tab', { name: 'Clinic hours' }).click();
      await expect(page.getByTestId('clinic-hours-open')).toHaveValue('09:00');
      await expect(page.getByTestId('clinic-hours-day-6')).not.toBeChecked();
      await expect(page.getByTestId('clinic-hours-break-end-0')).toHaveValue('14:00');
      await expect(page.getByTestId('clinic-hours-holiday-0')).toContainText('Republic Day');
    } finally {
      await context.close();
    }
  });

  test('a break outside the hours is refused with a message and nothing is saved', async ({ browser }) => {
    const before = await (await clinic.api.get('/api/v1/clinic-hours')).json();
    const context = await signedIn(browser, clinic.token, clinic.user, clinic.tenantId);
    try {
      const page = await context.newPage();
      await page.goto('/dashboard/settings');
      await page.getByRole('tab', { name: 'Clinic hours' }).click();
      await expect(page.getByTestId('clinic-hours-open')).toHaveValue('09:00');
      await page.getByTestId('clinic-hours-break-add').click();
      await page.getByTestId('clinic-hours-break-start-1').fill('07:00');
      await page.getByTestId('clinic-hours-break-end-1').fill('08:00');
      await page.getByTestId('clinic-hours-save').click();
      await expect(page.getByTestId('clinic-hours-error')).toHaveText('Each break must be inside the opening hours');
      expect(await (await clinic.api.get('/api/v1/clinic-hours')).json()).toEqual(before);
    } finally {
      await context.close();
    }
  });

  test('a therapist has no Clinic hours tab', async ({ browser }) => {
    const anon = await pwRequest.newContext({ baseURL: env.API_URL });
    const login = await (await anon.post('/api/v1/auth/login', { data: { ...DEMO_THERAPIST, audience: 'staff' } })).json();
    await anon.dispose();
    const context = await signedIn(browser, login.access_token, login.user, login.tenant.id);
    try {
      const page = await context.newPage();
      await page.goto('/dashboard/settings');
      await expect(page.getByRole('tab', { name: 'Profile' })).toBeVisible();
      await expect(page.getByRole('tab', { name: 'Clinic hours' })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
