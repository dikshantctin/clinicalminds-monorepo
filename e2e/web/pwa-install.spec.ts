import { test, expect, requireWeb, requireApi, requireAuth } from '../src/fixtures';
import { LoginPage } from '../src/pages/login.page';
import { DEMO_PATIENT } from '../src/env';
import type { Page } from '@playwright/test';

/**
 * PWA-4: the "Install app" card. Chrome/Edge/Android fire `beforeinstallprompt`, which the test fakes with a
 * stub prompt(); iPhone has no install API, so it gets the "Share → Add to Home Screen" hint instead.
 */
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

/** What Chrome does when the app is installable: an event the page keeps and later calls prompt() on. */
const offerInstall = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __promptCalls: number };
    w.__promptCalls = 0;
    const event = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
      prompt: () => Promise<void>;
      userChoice: Promise<{ outcome: string }>;
    };
    event.prompt = async () => {
      w.__promptCalls += 1;
    };
    event.userChoice = Promise.resolve({ outcome: 'accepted' });
    window.dispatchEvent(event);
  });

async function patientPortal(page: Page) {
  const login = new LoginPage(page, '/portal/login');
  await login.goto();
  await login.login(DEMO_PATIENT.email, DEMO_PATIENT.password);
  await expect(page).toHaveURL(/\/portal$/);
}

test.describe('install app card: patient portal', () => {
  requireWeb();
  requireApi();
  requireAuth();
  test.use({ storageState: { cookies: [], origins: [] } });

  test('Chrome: the card appears when the browser offers install, and Install opens the browser prompt', async ({
    page,
  }) => {
    await patientPortal(page);
    await expect(page.getByTestId('install-card')).toBeHidden();
    await offerInstall(page);
    await expect(page.getByTestId('install-card')).toContainText('Add PsyClinicalMind to your home screen');
    await page.getByTestId('install-app').click();
    expect(await page.evaluate(() => (window as unknown as { __promptCalls: number }).__promptCalls)).toBe(1);
    await expect(page.getByTestId('install-card')).toBeHidden(); // the prompt can be used once
  });

  test('Not now hides the card, and it stays hidden after a reload', async ({ page }) => {
    await patientPortal(page);
    await offerInstall(page);
    await page.getByTestId('install-dismiss').click();
    await expect(page.getByTestId('install-card')).toBeHidden();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Logout' })).toBeVisible();
    await offerInstall(page);
    await expect(page.getByTestId('install-card')).toBeHidden();
  });

  test('a dismissal older than 30 days shows the card again', async ({ page }) => {
    await page.addInitScript(() =>
      localStorage.setItem('install_prompt_dismissed_at', String(Date.now() - 31 * 86_400_000)),
    );
    await patientPortal(page);
    await offerInstall(page);
    await expect(page.getByTestId('install-app')).toBeVisible();
  });

  test('works from the keyboard and is a named region for screen readers', async ({ page }) => {
    await patientPortal(page);
    await offerInstall(page);
    await expect(page.getByRole('region', { name: 'Add PsyClinicalMind to your home screen' })).toBeVisible();
    await page.getByTestId('install-app').focus();
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => (window as unknown as { __promptCalls: number }).__promptCalls)).toBe(1);
  });

  test('at 390 px the card fits the screen and sits in the page, never over form controls', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await patientPortal(page);
    await offerInstall(page);
    const card = page.getByTestId('install-card');
    await expect(card).toBeVisible();
    const box = (await card.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(await card.evaluate((el) => getComputedStyle(el).position)).toBe('static');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });

  test('no card when the browser offers no install and it is not an iPhone', async ({ page }) => {
    await patientPortal(page);
    await expect(page.getByRole('button', { name: 'Logout' })).toBeVisible();
    await expect(page.getByTestId('install-card')).toBeHidden();
  });

  test('no card when the app is already running installed', async ({ page }) => {
    await page.addInitScript(() => {
      const real = window.matchMedia.bind(window);
      window.matchMedia = (q: string) =>
        q === '(display-mode: standalone)' ? ({ matches: true, media: q } as MediaQueryList) : real(q);
    });
    await patientPortal(page);
    await offerInstall(page);
    await expect(page.getByRole('button', { name: 'Logout' })).toBeVisible();
    await expect(page.getByTestId('install-card')).toBeHidden();
  });
});

test.describe('install app card: iPhone', () => {
  requireWeb();
  requireApi();
  requireAuth();
  test.use({ storageState: { cookies: [], origins: [] }, userAgent: IPHONE_UA });

  test('the portal shows the Add to Home Screen hint and no Install button', async ({ page }) => {
    await patientPortal(page);
    await expect(page.getByTestId('install-ios-hint')).toContainText('Add to Home Screen');
    await expect(page.getByTestId('install-app')).toHaveCount(0);
  });
});

test.describe('install app card: staff', () => {
  requireWeb();
  requireAuth();

  test('the staff dashboard shows the card when the browser offers install', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByTestId('user-menu')).toBeVisible();
    await expect(page.getByTestId('install-card')).toBeHidden();
    await offerInstall(page);
    await expect(page.getByTestId('install-app')).toBeVisible();
  });
});
