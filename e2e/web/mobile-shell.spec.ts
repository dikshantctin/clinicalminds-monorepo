import { test, expect, requireApi, requireAuth, requireWeb } from '../src/fixtures';
import { LoginPage } from '../src/pages/login.page';
import { DEMO_PATIENT } from '../src/env';

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

/** PWA-5: the screens most likely to be opened from a home-screen icon. */
test.describe('patient screens at 390 px', () => {
  requireWeb();
  test.use({ viewport: PHONE, storageState: { cookies: [], origins: [] } });

  test('the patient sign-in does not scroll sideways', async ({ page }) => {
    await page.goto('/portal/login');
    await expect(page.locator('#email')).toBeVisible();
    expect(await pageWidth(page)).toBeLessThanOrEqual(PHONE.width);
  });

  test('set-password does not scroll sideways', async ({ page }) => {
    await page.goto('/portal/set-password?token=x');
    await expect(page.getByRole('heading', { name: 'Set Your Password' })).toBeVisible();
    expect(await pageWidth(page)).toBeLessThanOrEqual(PHONE.width);
  });

  test.describe('signed in', () => {
    requireApi();
    requireAuth();

    test('the patient portal does not scroll sideways', async ({ page }) => {
      const login = new LoginPage(page, '/portal/login');
      await login.goto();
      await login.login(DEMO_PATIENT.email, DEMO_PATIENT.password);
      await expect(page).toHaveURL(/\/portal$/);
      await expect(page.getByRole('button', { name: 'Logout' })).toBeVisible();
      await page.waitForLoadState('networkidle');
      expect(await pageWidth(page)).toBeLessThanOrEqual(PHONE.width);
    });
  });
});

test.describe('public booking at 390 px', () => {
  requireWeb();
  requireApi();
  requireAuth();
  test.use({ viewport: PHONE, storageState: { cookies: [], origins: [] } });

  test('the booking page does not scroll sideways while choosing a service, clinician, day and slot', async ({
    page,
    auth,
  }) => {
    await page.goto(`/book/${auth.firmCode}`);
    await expect(page.getByTestId('booking-page')).toBeVisible();
    expect(await pageWidth(page)).toBeLessThanOrEqual(PHONE.width);

    await page.locator('[data-testid^="service-"]').first().click();
    await page.getByRole('radio').first().click();
    await page.getByTestId('booking-date').fill(new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10));
    await expect(page.getByTestId('booking-slots')).toBeVisible();
    expect(await pageWidth(page)).toBeLessThanOrEqual(PHONE.width);
  });
});

test.describe('staff pages at 390 px', () => {
  requireWeb();
  requireAuth();
  test.use({ viewport: PHONE });

  for (const path of ['/dashboard/patients', '/dashboard/sessions', '/dashboard/tasks', '/dashboard/follow-ups']) {
    test(`${path} does not scroll sideways`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByTestId('user-menu')).toBeVisible();
      await page.waitForLoadState('networkidle');
      expect(await pageWidth(page)).toBeLessThanOrEqual(PHONE.width);
    });
  }

  test('a patient page does not scroll sideways', async ({ page, api }) => {
    const list = await (await api.get('/api/v1/patients/', { params: { limit: 1 } })).json();
    const id = list.patients[0].id;
    await page.goto(`/dashboard/patients/${id}`);
    await expect(page.getByTestId('user-menu')).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(await pageWidth(page)).toBeLessThanOrEqual(PHONE.width);
  });
});

