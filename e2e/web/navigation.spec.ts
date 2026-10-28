import { test, expect, expectNoCrash, requireWeb, requireAuth } from '../src/fixtures';
import { DashboardPage, NAV, PAGE_HEADING, NavName } from '../src/pages/dashboard.page';

/** Uses the storage state written by global-setup (logged in as the E2E admin). */
test.describe('dashboard navigation (admin)', () => {
  requireWeb();
  requireAuth();

  test('storage state logs the user in and shows the overview', async ({ page }) => {
    const dash = new DashboardPage(page);
    await dash.goto();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(dash.heading(/Welcome back,/)).toBeVisible();
  });

  test('sidebar lists every admin section', async ({ page }) => {
    const dash = new DashboardPage(page);
    await dash.goto();
    for (const name of Object.keys(NAV) as NavName[]) {
      await expect(dash.navLink(name), name).toBeVisible();
    }
  });

  for (const [name, heading] of Object.entries(PAGE_HEADING) as Array<[NavName, string | RegExp]>) {
    test(`sidebar → ${name} renders its page`, async ({ page }) => {
      const dash = new DashboardPage(page);
      await dash.goto();
      await dash.navLink(name).click();
      await expect(page).toHaveURL(new RegExp(`${NAV[name].replace(/\//g, '\\/')}$`));
      await expect(dash.heading(heading)).toBeVisible();
      await expectNoCrash(page);
    });
  }

  test('direct navigation to a dashboard page works when logged in', async ({ page }) => {
    await page.goto(NAV.Patients);
    await expect(page.getByRole('heading', { name: 'Patient Management' })).toBeVisible();
  });

  test('a 401 from the API clears the session and returns to login', async ({ page, context }) => {
    // Invalidate the token the frontend holds, then hit a page that calls the API.
    await page.goto(NAV.Overview);
    await page.evaluate(() => localStorage.setItem('auth_token', 'expired.invalid.token'));
    // the interceptor does window.location.assign('/auth/login') while the page is still loading,
    // which aborts this navigation — that abort is the behaviour under test
    await page.goto(NAV.Patients).catch(() => undefined);
    await expect(page).toHaveURL(/\/auth\/login$/, { timeout: 15_000 });
    await expect.poll(() => page.evaluate(() => localStorage.getItem('auth_token'))).toBeNull();
    await context.clearCookies();
  });
});
