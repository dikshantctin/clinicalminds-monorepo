import { test, expect, expectNoCrash, requireWeb, requireAuth } from '../src/fixtures';

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

  test('admin catalog pages render for an admin', async ({ page }) => {
    for (const path of ['/admin/services', '/admin/locations']) {
      await page.goto(path);
      await expect(page, path).toHaveURL(new RegExp(`${path}$`));
      await expectNoCrash(page);
    }
  });
});
