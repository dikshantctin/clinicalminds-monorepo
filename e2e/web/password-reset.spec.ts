import { test, expect, requireWeb, requireAuth } from '../src/fixtures';
import { lastEmailTo } from '../src/outbox';
import { portalAccount, loginStatus } from '../src/portal-account';

/** The forgot-password journey in a logged-out browser: login page link → email → reset page → log in. */
test.describe('password reset (browser)', () => {
  requireWeb();
  requireAuth();

  test('Forgot password? → reset link → new password → login works with it', async ({ api, browser }) => {
    const acct = await portalAccount(api, 'Password123!');
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    try {
      await page.goto('/auth/login');
      await page.getByRole('link', { name: 'Forgot password?' }).click();
      await expect(page).toHaveURL(/\/auth\/forgot-password$/);
      await page.getByTestId('forgot-password-email').fill(acct.email);
      await page.getByTestId('forgot-password-submit').click();
      await expect(page.getByTestId('forgot-password-sent')).toContainText(acct.email);

      const link = lastEmailTo(acct.email).html.match(/https?:\/\/[^"'\s<]+\/auth\/reset-password\?token=[\w.-]+/);
      expect(link, 'the reset email carries a link').not.toBeNull();
      const url = new URL(link![0]);
      await page.goto(url.pathname + url.search);

      // mismatched confirmation is caught before anything is sent
      await page.getByTestId('reset-password-new').fill('Changed456!');
      await page.getByTestId('reset-password-confirm').fill('Changed457!');
      await page.getByTestId('reset-password-submit').click();
      await expect(page.getByText('The two passwords do not match')).toBeVisible();
      expect(await loginStatus(acct.email, 'Password123!')).toBe(200);

      await page.getByTestId('reset-password-confirm').fill('Changed456!');
      await page.getByTestId('reset-password-submit').click();
      await expect(page.getByText('Password changed. Please log in.')).toBeVisible();
      await expect(page).toHaveURL(/\/auth\/login$/);
      expect(await loginStatus(acct.email, 'Changed456!')).toBe(200);

      // the same link is spent
      await page.goto(url.pathname + url.search);
      await page.getByTestId('reset-password-new').fill('Again789!x');
      await page.getByTestId('reset-password-confirm').fill('Again789!x');
      await page.getByTestId('reset-password-submit').click();
      await expect(page.getByText('Invalid or expired reset token')).toBeVisible();
    } finally {
      await context.close();
      await acct.cleanup();
    }
  });
});
