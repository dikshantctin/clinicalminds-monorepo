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
});
