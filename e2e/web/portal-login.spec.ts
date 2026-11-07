import { test, expect, requireWeb, requireApi, requireAuth } from '../src/fixtures';
import { LoginPage } from '../src/pages/login.page';
import { env, DEMO_PATIENT } from '../src/env';

// The login address picks the role: /portal/login logs in as PATIENT, /auth/login as staff.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe('portal vs staff login', () => {
  requireWeb();
  requireApi();
  requireAuth();

  test('a patient signs in at /portal/login and lands on the portal', async ({ page }) => {
    const login = new LoginPage(page, '/portal/login');
    await login.goto();
    await login.login(DEMO_PATIENT.email, DEMO_PATIENT.password);
    await expect(page).toHaveURL(/\/portal$/);
  });

  test('a patient-only account is refused at the staff login', async ({ page }) => {
    const login = new LoginPage(page, '/auth/login');
    await login.goto();
    await login.login(DEMO_PATIENT.email, DEMO_PATIENT.password);
    await expect(page.getByText('No staff access for this account')).toBeVisible();
    await expect(page).toHaveURL(/\/auth\/login$/);
  });

  test('a staff account with no patient role is refused at the portal login', async ({ page }) => {
    const login = new LoginPage(page, '/portal/login');
    await login.goto();
    await login.login(env.EMAIL, env.PASSWORD);
    await expect(page.getByText('No patient portal access for this account')).toBeVisible();
    await expect(page).toHaveURL(/\/portal\/login$/);
  });

  test('staff still sign in at /auth/login and land on the dashboard', async ({ page }) => {
    const login = new LoginPage(page, '/auth/login');
    await login.goto();
    await login.login(env.EMAIL, env.PASSWORD);
    await expect(page).toHaveURL(/\/dashboard$/);
  });

  test('a patient who logs out lands on the patient sign-in, and / opens it again', async ({ page }) => {
    const login = new LoginPage(page, '/portal/login');
    await login.goto();
    await login.login(DEMO_PATIENT.email, DEMO_PATIENT.password);
    await expect(page).toHaveURL(/\/portal$/);
    await page.getByRole('button', { name: 'Logout' }).click();
    await expect(page).toHaveURL(/\/portal\/login$/);
    await page.goto('/');
    await expect(page).toHaveURL(/\/portal\/login$/);
  });

  test('staff who log out land on the staff sign-in, and / opens it again', async ({ page }) => {
    const login = new LoginPage(page, '/auth/login');
    await login.goto();
    await login.login(env.EMAIL, env.PASSWORD);
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.getByTestId('user-menu').click();
    await page.getByRole('menuitem', { name: 'Logout' }).click();
    await expect(page).toHaveURL(/\/auth\/login$/);
    await page.goto('/');
    await expect(page).toHaveURL(/\/auth\/login$/);
  });

  test('a signed-in patient opening /dashboard or / is taken to the portal', async ({ page }) => {
    const login = new LoginPage(page, '/portal/login');
    await login.goto();
    await login.login(DEMO_PATIENT.email, DEMO_PATIENT.password);
    await expect(page).toHaveURL(/\/portal$/);
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/portal$/);
    await page.goto('/');
    await expect(page).toHaveURL(/\/portal$/);
  });

  test('signed-in staff opening / are taken to the dashboard', async ({ page }) => {
    const login = new LoginPage(page, '/auth/login');
    await login.goto();
    await login.login(env.EMAIL, env.PASSWORD);
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.goto('/');
    await expect(page).toHaveURL(/\/dashboard$/);
  });

  test('a patient whose token is no longer accepted on /portal is sent to the patient sign-in', async ({ page }) => {
    const login = new LoginPage(page, '/portal/login');
    await login.goto();
    await login.login(DEMO_PATIENT.email, DEMO_PATIENT.password);
    await expect(page).toHaveURL(/\/portal$/);
    // A token the API refuses (401), and no refresh key to renew it with; set in the new page only
    await page.addInitScript(() => {
      if (sessionStorage.getItem('e2e_bad_token')) return;
      sessionStorage.setItem('e2e_bad_token', '1');
      localStorage.setItem('auth_token', 'not-a-valid-token');
      localStorage.removeItem('refresh_token');
    });
    await page.reload();
    await expect(page).toHaveURL(/\/portal\/login$/);
    expect(await page.evaluate(() => localStorage.getItem('auth_token'))).toBeNull();
  });
});
