import { test, expect, requireAuth, requireWeb } from '../src/fixtures';
import { AA_TEXT, contrastWithWhite } from '../src/contrast';

const brandToken = (page: import('@playwright/test').Page) =>
  page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--cm-brand').trim());

test.describe('app shell: sidebar navigation', () => {
  requireWeb();
  requireAuth();

  test('at desktop width the main navigation is a left sidebar', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/dashboard');
    const sidebar = page.getByTestId('app-sidebar');
    await expect(sidebar).toBeVisible();
    const nav = sidebar.getByRole('navigation', { name: 'Main' });
    for (const name of ['Overview', 'Patients', 'Sessions', 'Tasks', 'Settings']) {
      await expect(nav.getByRole('link', { name })).toBeVisible();
    }
    const box = (await sidebar.boundingBox())!;
    expect([box.x, box.width]).toEqual([0, 256]);
    await expect(page.getByRole('button', { name: 'Open menu' })).toBeHidden();
  });

  test('below 1024 px the sidebar is hidden and the menu button opens the links', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    await page.goto('/dashboard');
    await expect(page.getByTestId('app-sidebar')).toBeHidden();
    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.getByRole('dialog').getByRole('link', { name: 'Patients' }).click();
    await expect(page).toHaveURL(/\/dashboard\/patients$/);
  });
});

test.describe('brand colour', () => {
  requireWeb();
  requireAuth();

  test('the brand colour on the shell is readable under white text (WCAG AA)', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByTestId('app-sidebar')).toBeVisible();
    expect(contrastWithWhite(await brandToken(page))).toBeGreaterThanOrEqual(AA_TEXT);
  });

  test('Settings → Branding refuses a colour too light for white button text', async ({ page }) => {
    await page.goto('/dashboard/settings');
    await page.getByRole('tab', { name: 'Branding & Appearance' }).click();
    const color = page.getByTestId('branding-primary-color');
    const save = page.getByTestId('branding-save');

    await color.fill('#a5b4fc');
    await expect(page.getByText(/Too light for white button text \(2\.0:1, needs 4\.5:1\)/)).toBeVisible();
    await expect(save).toBeDisabled();

    await color.fill('#1d4ed8');
    await expect(page.getByText(/Too light for white button text/)).toHaveCount(0);
    await expect(save).toBeEnabled();
  });
});

test.describe('settings tabs', () => {
  requireWeb();
  requireAuth();

  test('every Settings tab is on screen without sideways scrolling', async ({ page }) => {
    await page.goto('/dashboard/settings');
    const tabs = page.getByRole('tablist').first().getByRole('tab');
    await expect(tabs.first()).toBeVisible();
    const width = page.viewportSize()!.width;
    const offscreen = await tabs.evaluateAll(
      (els, w) => els.filter((el) => el.getBoundingClientRect().right > w).map((el) => el.textContent),
      width,
    );
    expect(offscreen).toEqual([]);
  });
});

test.describe('form controls', () => {
  requireWeb();
  requireAuth();

  test('small selects are tall enough for their text (task filters)', async ({ page }) => {
    await page.goto('/dashboard/tasks');
    await expect(page.getByRole('heading', { name: 'Task Management' })).toBeVisible({ timeout: 20_000 });
    const fits = await page.locator('select.h-8').evaluateAll((selects) =>
      selects.map((el) => {
        const cs = getComputedStyle(el);
        const needed = ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth'].reduce(
          (sum, key) => sum + parseFloat(cs[key as keyof CSSStyleDeclaration] as string),
          parseFloat(cs.lineHeight),
        );
        return needed <= el.getBoundingClientRect().height;
      }),
    );
    expect(fits).toEqual([true, true]);
  });
});
