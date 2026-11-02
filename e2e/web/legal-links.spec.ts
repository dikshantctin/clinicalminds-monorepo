import { test, expect, requireWeb } from '../src/fixtures';

/**
 * Login linked "Terms of Service" → /terms and "Privacy Policy" → /privacy, neither of which is a route
 * (they fell through to /dashboard). There is no legal text yet, so the line is shown only when
 * VITE_TERMS_URL and VITE_PRIVACY_URL are set; CI and dev builds leave them empty.
 */
test.use({ storageState: { cookies: [], origins: [] } });

test.describe('legal links', () => {
  requireWeb();

  for (const path of ['/auth/login', '/portal/login', '/auth/register']) {
    test(`${path} has no dead Terms / Privacy links`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole('heading').first()).toBeVisible();
      await expect(page.getByRole('link', { name: 'Terms of Service' })).toHaveCount(0);
      await expect(page.getByRole('link', { name: 'Privacy Policy' })).toHaveCount(0);
      await expect(page.locator('a[href="/terms"], a[href="/privacy"]')).toHaveCount(0);
      await expect(page.getByTestId('login-legal')).toHaveCount(0);
    });
  }
});
