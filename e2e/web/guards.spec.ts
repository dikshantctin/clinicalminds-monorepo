import { test, expect, expectNoCrash, requireWeb } from '../src/fixtures';

/** ProtectedRoute / RoleGuard / redirect rules from frontend/src/App.tsx — no backend needed. */
test.use({ storageState: { cookies: [], origins: [] } });

test.describe('route guards (logged out)', () => {
  requireWeb();

  for (const path of ['/dashboard', '/dashboard/patients', '/dashboard/tasks', '/dashboard/crisis', '/dashboard/analytics', '/dashboard/settings']) {
    test(`${path} redirects to /auth/login`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(/\/auth\/login$/);
    });
  }

  test('/ → /portal → login', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/auth\/login$/);
  });

  test('unknown paths fall through to /dashboard → login', async ({ page }) => {
    await page.goto('/this/does/not/exist');
    await expect(page).toHaveURL(/\/auth\/login$/);
  });

  test('/admin/services requires a role', async ({ page }) => {
    await page.goto('/admin/services');
    await expect(page).toHaveURL(/\/auth\/login$/);
  });

  test('public pages render without auth', async ({ page }) => {
    await page.goto('/auth/forgot-password');
    await expect(page.getByRole('heading', { name: 'Forgot Password' })).toBeVisible();

    await page.goto('/portal/set-password?token=bogus');
    await expect(page.getByRole('heading', { name: 'Set Your Password' })).toBeVisible();
    await expect(page.locator('input[type="password"]').first()).toBeVisible();

    await page.goto('/booking');
    await expectNoCrash(page);
  });
});
