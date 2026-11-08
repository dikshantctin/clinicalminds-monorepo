import { test, expect, expectNoCrash, requireWeb, requireAuth } from '../src/fixtures';
import { deleteClinic, onboardOwnClinic } from '../src/clinics';

test.describe('settings and admin pages', () => {
  requireWeb();
  requireAuth();

  test('settings page renders', async ({ page }) => {
    await page.goto('/dashboard/settings');
    await expect(page).toHaveURL(/\/dashboard\/settings$/);
    await expectNoCrash(page);
  });

  test('removed facade pages no longer exist (they fall through to the overview)', async ({ page }) => {
    test.slow(); // several full page loads on the dev server
    for (const path of ['/dashboard/ai-assistant', '/dashboard/crisis', '/dashboard/analytics']) {
      await page.goto(path);
      await expect(page, path).toHaveURL(/\/dashboard$/);
    }
  });

  test('branding colour saves and survives a reload', async ({ page, api, auth }) => {
    test.slow(); // several full page loads on the dev server
    // The stored value, not the input's: an unset colour shows the default, and saving that back would
    // store it (a pale default once stuck on the demo clinic this way)
    const branding = `/api/v1/tenants/${auth.tenantId}/branding`;
    const original: string | null = (await (await api.get(branding)).json()).primary_color ?? null;
    await page.goto('/dashboard/settings');
    await page.getByRole('tab', { name: /Branding/ }).click();
    const colour = page.getByTestId('branding-primary-color');
    try {
      await colour.fill('#336699');
      await page.getByTestId('branding-save').click();
      await expect(page.getByText('Branding Updated')).toBeVisible();
      await page.reload();
      await page.getByRole('tab', { name: /Branding/ }).click();
      await expect(page.getByTestId('branding-primary-color')).toHaveValue('#336699');
    } finally {
      expect((await api.put(branding, { data: { primary_color: original } })).status()).toBe(200);
    }
  });

  test('a colour typed before the clinic finishes loading is kept, saved and shown after a reload', async ({ browser }) => {
    test.slow(); // onboarding + several page loads
    // Own clinic: the demo clinic's colour is shared with the test above, which runs in parallel
    const clinic = await onboardOwnClinic('brandrace');
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    try {
      await context.addInitScript(
        ([t, u, id]) => {
          localStorage.setItem('auth_token', t);
          localStorage.setItem('auth_user', u);
          localStorage.setItem('tenant_id', id);
        },
        [clinic.token, JSON.stringify(clinic.user), clinic.tenantId],
      );
      const page = await context.newPage();
      // Hold the clinic (GET /tenants/my-tenants) until the user has typed: the late answer used to reset the form
      let release!: () => void;
      const released = new Promise<void>((r) => (release = r));
      let asked!: () => void;
      const requested = new Promise<void>((r) => (asked = r));
      await page.route('**/api/v1/tenants/my-tenants', async (route) => {
        asked();
        await released;
        await route.continue();
      });
      await page.goto('/dashboard/settings');
      await page.getByRole('tab', { name: /Branding/ }).click();
      await requested;
      await page.getByTestId('branding-primary-color').fill('#336699');
      await page.getByTestId('branding-organization-name').fill('Race Clinic');
      const loaded = page.waitForResponse('**/api/v1/tenants/my-tenants');
      release();
      await loaded;
      await expect(page.getByTestId('branding-primary-color')).toHaveValue('#336699');
      await expect(page.getByTestId('branding-organization-name')).toHaveValue('Race Clinic');

      await page.getByTestId('branding-save').click();
      await expect(page.getByText('Branding Updated')).toBeVisible();
      const stored = await (await clinic.api.get(`/api/v1/tenants/${clinic.tenantId}/branding`)).json();
      expect(stored.primary_color).toBe('#336699');
      await page.unroute('**/api/v1/tenants/my-tenants');
      await page.reload();
      await page.getByRole('tab', { name: /Branding/ }).click();
      await expect(page.getByTestId('branding-primary-color')).toHaveValue('#336699');
      await expect(page.getByTestId('branding-organization-name')).toHaveValue('Race Clinic');
    } finally {
      await context.close();
      await clinic.api.dispose();
      await deleteClinic(clinic.adminEmail);
    }
  });

  test('admin catalog pages render for an admin', async ({ page }) => {
    for (const path of ['/admin/services', '/admin/locations']) {
      await page.goto(path);
      await expect(page, path).toHaveURL(new RegExp(`${path}$`));
      await expectNoCrash(page);
    }
  });
});
