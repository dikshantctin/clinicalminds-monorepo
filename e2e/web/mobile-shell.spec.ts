import { test, expect, requireApi, requireAuth, requireWeb } from '../src/fixtures';
import { LoginPage } from '../src/pages/login.page';
import { DEMO_PATIENT, uniq } from '../src/env';
import { assignDemoClinicians, cleanupServices, createService } from '../src/catalog';
import { openDay } from '../src/days';

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
  const created: string[] = [];
  test.afterEach(async ({ api }) => cleanupServices(api, created));

  test('the booking page does not scroll sideways while choosing a service, clinician, day and slot', async ({
    page,
    api,
    auth,
  }) => {
    // Its own free service with the demo clinicians (CI starts from an empty catalog)
    const service = await createService(api, created, { name: uniq('Phone width consult'), price: 0 });
    await assignDemoClinicians(api, service.id);

    await page.goto(`/book/${auth.firmCode}`);
    await expect(page.getByTestId('booking-page')).toBeVisible();
    expect(await pageWidth(page)).toBeLessThanOrEqual(PHONE.width);

    await page.getByTestId(`service-${service.id}`).click();
    await page.getByRole('radio', { name: /Jane Doe/ }).click();
    await page.getByTestId('booking-date').fill(openDay(5)); // clinic-local open day (closed on Sunday)
    await expect(page.getByTestId('booking-slots').getByRole('radio').first()).toBeVisible({ timeout: 15_000 });
    expect(await pageWidth(page)).toBeLessThanOrEqual(PHONE.width);
  });
});

test.describe('staff pages at 390 px', () => {
  requireWeb();
  requireAuth();
  test.use({ viewport: PHONE });

  test('the patients list does not scroll sideways, even when its table is wider than the screen', async ({ page }) => {
    // Layout input under control: the real list plus one patient with a long unbroken name, which makes the table
    // wider than the phone so it scrolls inside its card. Nothing in it may widen the page (its screen-reader-only
    // "Actions" header used to, by 3 px with CI's data).
    const first = 'Averyveryverylongunbrokenfirstname';
    await page.route(/\/api\/v1\/patients\/?\?/, async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      body.patients = [{ ...body.patients[0], id: '00000000-0000-4000-8000-0000000000aa', first_name: first }, ...body.patients];
      await route.fulfill({ response: res, json: body });
    });
    await page.goto('/dashboard/patients');
    await expect(page.getByRole('table').getByText(first)).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(await page.getByRole('table').evaluate((t) => t.getBoundingClientRect().width)).toBeGreaterThan(PHONE.width);
    expect(await pageWidth(page)).toBeLessThanOrEqual(PHONE.width);
  });

  test('/dashboard/patients does not scroll sideways', async ({ page }) => {
    await page.goto('/dashboard/patients');
    await expect(page.getByTestId('user-menu')).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(await pageWidth(page)).toBeLessThanOrEqual(PHONE.width);
  });

  for (const path of ['/dashboard/sessions', '/dashboard/tasks', '/dashboard/follow-ups']) {
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

