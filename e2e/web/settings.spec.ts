import { test, expect, expectNoCrash, requireWeb, requireAuth } from '../src/fixtures';
import { LoginPage } from '../src/pages/login.page';
import { uniq, DEMO_THERAPIST } from '../src/env';

const SETTINGS = '/dashboard/settings';
const ALL_FEATURES = ['analytics', 'patient_management', 'session_management'];

test.describe('settings page (admin)', () => {
  requireWeb();
  requireAuth();

  test('profile save survives a reload', async ({ page, api }) => {
    const before = await (await api.get('/api/v1/users/me')).json();
    const license = uniq('LIC');
    try {
      await page.goto(SETTINGS);
      await expect(page.getByTestId('profile-first-name')).toHaveValue(before.first_name);
      await page.getByTestId('profile-license-number').fill(license);
      await page.getByTestId('profile-specializations').fill('CBT, Trauma');
      await page.getByTestId('profile-save').click();
      await expect(page.getByText('Profile Updated.')).toBeVisible();

      await page.reload();
      await expect(page.getByTestId('profile-license-number')).toHaveValue(license);
      await expect(page.getByTestId('profile-specializations')).toHaveValue('CBT, Trauma');
      await expect(page.getByTestId('profile-first-name')).toHaveValue(before.first_name);
      await expectNoCrash(page);
    } finally {
      await api.put('/api/v1/users/me', {
        data: { license_number: before.license_number ?? '', specializations: before.specializations ?? [] },
      });
    }
  });

  test('organization form shows the real clinic, not a placeholder', async ({ page, api, auth }) => {
    await page.goto(SETTINGS);
    await page.getByRole('tab', { name: 'Organization' }).click();
    await expect(page.getByTestId('organization-name')).not.toHaveValue('');
    // polled: api/settings.spec.ts renames the clinic briefly while it runs in parallel
    await expect
      .poll(async () => {
        const tenant = await (await api.get(`/api/v1/tenants/${auth.tenantId}`)).json();
        if ((await page.getByTestId('organization-name').inputValue()) !== tenant.organization_name) await page.reload();
        await page.getByRole('tab', { name: 'Organization' }).click();
        return (await page.getByTestId('organization-name').inputValue()) === tenant.organization_name;
      })
      .toBe(true);
    await expect(page.getByText('Multi-Tenant Management')).toHaveCount(0);
  });

  test('a saved feature switch is still off after a reload', async ({ page, api, auth }) => {
    try {
      await page.goto(SETTINGS);
      await page.getByRole('tab', { name: 'Features & Integrations' }).click();
      const analytics = page.getByRole('switch', { name: 'Analytics' });
      await expect(analytics).toHaveAttribute('aria-checked', 'true');
      await analytics.click();
      // press, not click: the dev-only AuthDebug overlay sits over this bottom-right button
      await page.getByTestId('features-save').press('Enter');
      await expect(page.getByText('Features Updated.')).toBeVisible();

      await page.reload();
      await page.getByRole('tab', { name: 'Features & Integrations' }).click();
      await expect(page.getByRole('switch', { name: 'Analytics' })).toHaveAttribute('aria-checked', 'false');
    } finally {
      await api.put(`/api/v1/tenants/${auth.tenantId}/settings`, { data: { features: ALL_FEATURES } });
    }
  });

  test('branding reaches the app shell', async ({ page, api, auth }) => {
    const branding = await (await api.get(`/api/v1/tenants/${auth.tenantId}/branding`)).json();
    test.skip(!branding.primary_color, 'clinic has no saved brand colour');
    const hex: string = branding.primary_color.replace('#', '');
    const rgb = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(' ');

    await page.goto('/dashboard');
    await expect
      .poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--cm-brand').trim()))
      .toBe(rgb);
    if (branding.organization_name) {
      await expect(page.getByTestId('shell-clinic-name')).toHaveText(branding.organization_name);
    }
  });
});

test.describe('settings page (therapist)', () => {
  requireWeb();
  requireAuth();
  test.use({ storageState: { cookies: [], origins: [] } });

  test('a therapist sees and can open their Profile, but no organization tabs', async ({ page }) => {
    const login = new LoginPage(page);
    await login.goto();
    await login.login(DEMO_THERAPIST.email, DEMO_THERAPIST.password);
    await expect(page).toHaveURL(/\/dashboard/);

    await page.goto(SETTINGS);
    await expect(page.getByRole('tab', { name: 'Profile' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Organization' })).toHaveCount(0);
    await expect(page.getByTestId('profile-first-name')).toHaveValue('Jane');
    // and after a reload (permissions now come from /auth/me)
    await page.reload();
    await expect(page.getByRole('tab', { name: 'Profile' })).toBeVisible();
    await expect(page.getByTestId('profile-first-name')).toHaveValue('Jane');
  });
});
