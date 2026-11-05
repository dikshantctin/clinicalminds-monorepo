import { test, expect, requireWeb } from '../src/fixtures';
import type { Page } from '@playwright/test';

/**
 * PWA-3: a deployed new version is offered, never forced. Reload switches only the tab it was clicked in;
 * another open tab (a half-filled form) keeps its page.
 */
test.use({ serviceWorkers: 'allow', storageState: { cookies: [], origins: [] } });

const swReady = (page: Page) => page.evaluate(async () => !!(await navigator.serviceWorker.ready).active);

test.describe('installable app: new version', () => {
  requireWeb();

  test('the notice appears in every tab, Reload switches only its own tab, Later dismisses', async ({ context }) => {
    const first = await context.newPage();
    await first.goto('/portal/login');
    expect(await swReady(first)).toBe(true);
    await first.reload(); // controlled by the installed worker, like any later visit
    expect(await first.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    const second = await context.newPage();
    await second.goto('/portal/login');
    await second.locator('#email').fill('half-typed@example.com'); // unsaved input in the other tab
    await expect(first.getByTestId('pwa-update')).toBeHidden();

    // "Deploy": a new worker script URL for the same scope installs a new version that waits to take over.
    // (The browser's own update check for sw.js cannot be intercepted by page or context routes.)
    await first.evaluate(async () => {
      await navigator.serviceWorker.register('/sw.js?next-release', { scope: '/' });
    });

    await expect(first.getByTestId('pwa-update')).toContainText('A new version of PsyClinicalMind is available');
    await expect(second.getByTestId('pwa-update')).toBeVisible();

    await second.getByTestId('pwa-update-later').click();
    await expect(second.getByTestId('pwa-update')).toBeHidden();

    const reloaded = first.waitForEvent('load');
    await first.getByTestId('pwa-update-reload').click();
    await reloaded;
    await expect(first.getByTestId('pwa-update')).toBeHidden();

    // The other tab was not reloaded: its unsaved input is still there, and it is told a new version took over
    await expect(second.getByTestId('pwa-update')).toBeVisible();
    await expect(second.locator('#email')).toHaveValue('half-typed@example.com');
  });
});
