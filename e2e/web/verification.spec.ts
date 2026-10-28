import { test, expect, requireWeb, requireApi, requireAuth } from '../src/fixtures';
import { UNVERIFIED_USER } from '../src/env';

test.describe('verification gate (web)', () => {
  requireWeb();
  requireApi();
  test.use({ storageState: { cookies: [], origins: [] } });

  test('an unverified user is sent to /auth/verify, which renders both phone.email widgets', async ({ page, anon }) => {
    const body = await (await anon.post('/api/v1/auth/login', { data: UNVERIFIED_USER })).json();
    await page.goto('/auth/login'); // same origin, so localStorage can be seeded
    await page.evaluate(
      ({ token, user, tenant }) => {
        localStorage.setItem('auth_token', token);
        localStorage.setItem('auth_user', JSON.stringify(user));
        localStorage.setItem('tenant_id', tenant);
      },
      { token: body.access_token, user: body.user, tenant: body.tenant.id },
    );
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/auth\/verify$/, { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'Verify your contact details' })).toBeVisible();
    // the vendor script fills these hosts; only their presence is ours to assert
    await expect(page.getByTestId('phone-email-email')).toBeAttached();
    await expect(page.getByTestId('phone-email-phone')).toBeAttached();
  });
});

test.describe('verification state in Settings', () => {
  requireWeb();
  requireAuth();

  test('the demo admin shows both channels as Verified', async ({ page }) => {
    await page.goto('/dashboard/settings');
    await expect(page.getByTestId('verified-email')).toBeVisible();
    await expect(page.getByTestId('verified-phone')).toBeVisible();
  });

  test('/auth/verify sends an already-verified user on to the dashboard', async ({ page }) => {
    await page.goto('/auth/verify');
    await expect(page).toHaveURL(/\/dashboard$/);
  });
});
