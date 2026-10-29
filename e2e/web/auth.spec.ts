import { test, expect, requireWeb, requireApi, requireAuth } from '../src/fixtures';
import { LoginPage } from '../src/pages/login.page';
import { env } from '../src/env';

// Login specs start logged-out regardless of the shared storage state.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe('login page', () => {
  requireWeb();

  test('renders the form, demo credentials and links', async ({ page }) => {
    const login = new LoginPage(page);
    await login.goto();
    await expect(login.heading).toBeVisible();
    await expect(page.getByText('Sign in to your PsyClinicalMind account')).toBeVisible();
    await expect(login.email).toBeVisible();
    await expect(login.password).toHaveAttribute('type', 'password');
    await expect(login.submit).toBeEnabled();
    await expect(login.registerLink).toHaveAttribute('href', '/auth/register');
    await expect(login.forgotLink).toHaveAttribute('href', '/auth/forgot-password');
    await expect(page.getByText('DPDP Act 2023 Compliant')).toBeVisible();
  });

  test('client-side validation blocks empty / short input', async ({ page }) => {
    const login = new LoginPage(page);
    await login.goto();
    await login.submit.click();
    await expect(page.getByText('Email is required')).toBeVisible();
    await expect(page.getByText('Password must be at least 6 characters')).toBeVisible();

    await login.email.fill('not-an-email');
    await login.submit.click();
    await expect(page.getByText('Please enter a valid email')).toBeVisible();
    await expect(page).toHaveURL(/\/auth\/login$/);
  });

  test('toggles password visibility', async ({ page }) => {
    const login = new LoginPage(page);
    await login.goto();
    await login.password.fill('secret');
    await page.getByRole('button', { name: 'Show password' }).click();
    await expect(login.password).toHaveAttribute('type', 'text');
  });

  test('wrong credentials show an error toast and stay on the page', async ({ page }) => {
    requireApi();
    const login = new LoginPage(page);
    await login.goto();
    await login.login(env.EMAIL, 'definitely-wrong-password');
    // AuthContext toasts the backend's error envelope `message`
    await expect(page.getByText('Invalid email or password')).toBeVisible();
    await expect(page).toHaveURL(/\/auth\/login$/);
  });

  test('valid credentials land on the dashboard with a welcome', async ({ page }) => {
    requireAuth();
    const login = new LoginPage(page);
    await login.goto();
    await login.login(env.EMAIL, env.PASSWORD);
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole('heading', { name: /Welcome back,/ })).toBeVisible();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('auth_token'))).not.toBeNull();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('tenant_id'))).not.toBeNull();
  });
});
