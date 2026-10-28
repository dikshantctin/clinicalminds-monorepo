import { test, expect, expectNoCrash, requireWeb } from '../src/fixtures';
import { LoginPage } from '../src/pages/login.page';

test.use({ storageState: { cookies: [], origins: [] } });

test.describe('patient portal', () => {
  requireWeb();

  test('/portal/login reuses the login form', async ({ page }) => {
    const login = new LoginPage(page, '/portal/login');
    await login.goto();
    await expect(login.heading).toBeVisible();
    await expect(login.email).toBeVisible();
    await expect(login.submit).toBeVisible();
  });

  test('/portal/set-password renders the invite form', async ({ page }) => {
    await page.goto('/portal/set-password?token=bogus');
    await expect(page.getByRole('heading', { name: 'Set Your Password' })).toBeVisible();
    await expect(page.locator('input[type="password"]').first()).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toBeVisible();
  });

  test('/portal content is protected', async ({ page }) => {
    await page.goto('/portal');
    await expect(page).toHaveURL(/\/auth\/login$/);
  });
});

test.describe('organisation onboarding wizard', () => {
  requireWeb();

  test('register link opens the wizard without crashing', async ({ page }) => {
    const login = new LoginPage(page);
    await login.goto();
    await login.registerLink.click();
    await expect(page).toHaveURL(/\/auth\/register$/);
    await expectNoCrash(page);
    await expect(page.locator('input').first()).toBeVisible();
  });

  test('wizard loads directly', async ({ page }) => {
    await page.goto('/auth/register');
    await expect(page).toHaveURL(/\/auth\/register$/);
    await expect(page.locator('button').first()).toBeVisible();
  });
});
