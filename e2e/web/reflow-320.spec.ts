import { test, expect, requireApi, requireAuth, requireWeb } from '../src/fixtures';
import { LoginPage } from '../src/pages/login.page';
import { DEMO_PATIENT } from '../src/env';
import type { Locator, Page } from '@playwright/test';

/**
 * WCAG 2.1 SC 1.4.10 Reflow: at 320 CSS px (1280 px at 400% zoom) nothing scrolls sideways and every
 * header control stays on screen and usable.
 */
const NARROW = { width: 320, height: 640 };

const pageWidth = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth);

async function expectOnScreen(control: Locator) {
  await expect(control).toBeVisible();
  const box = (await control.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(NARROW.width);
}

test.describe('staff header at 320 px', () => {
  requireWeb();
  requireAuth();
  test.use({ viewport: NARROW });

  test('the dashboard does not scroll sideways and every header control is on screen and works', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByTestId('user-menu')).toBeVisible();
    expect(await pageWidth(page)).toBeLessThanOrEqual(NARROW.width);

    const menuButton = page.getByRole('button', { name: 'Open menu' });
    const bell = page.getByTestId('notification-bell');
    const userMenu = page.getByTestId('user-menu');
    for (const control of [menuButton, bell, userMenu]) await expectOnScreen(control);

    await userMenu.click();
    await expectOnScreen(page.getByRole('menuitem', { name: 'Logout' }));
    await expectOnScreen(page.getByRole('menuitem', { name: 'Settings' }));
    await page.keyboard.press('Escape');

    await bell.click();
    await expectOnScreen(page.getByTestId('notification-panel'));
    expect(await pageWidth(page)).toBeLessThanOrEqual(NARROW.width);
    await page.keyboard.press('Escape');

    await menuButton.click();
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Patients' })).toBeVisible();
  });

  test('the user menu keeps its accessible name although the visible name is hidden', async ({ page }) => {
    await page.goto('/dashboard');
    const name = await page.getByTestId('user-menu').evaluate((el) => (el.textContent || '').trim());
    expect(name.length).toBeGreaterThan(0);
  });
});

test.describe('patient portal header at 320 px', () => {
  requireWeb();
  requireApi();
  test.use({ viewport: NARROW, storageState: { cookies: [], origins: [] } });

  test('the portal does not scroll sideways and Logout is on screen', async ({ page }) => {
    const login = new LoginPage(page, '/portal/login');
    await login.goto();
    expect(await pageWidth(page)).toBeLessThanOrEqual(NARROW.width);
    await login.login(DEMO_PATIENT.email, DEMO_PATIENT.password);
    await expect(page).toHaveURL(/\/portal$/);
    await expectOnScreen(page.getByRole('button', { name: 'Logout' }));
    await expectOnScreen(page.getByRole('link', { name: 'Patient Portal' }));
    expect(await pageWidth(page)).toBeLessThanOrEqual(NARROW.width);
  });
});
