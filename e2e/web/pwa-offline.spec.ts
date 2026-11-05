import { test, expect, requireWeb, requireApi, requireAuth } from '../src/fixtures';
import { env } from '../src/env';
import { LoginPage } from '../src/pages/login.page';
import type { Page } from '@playwright/test';

/**
 * PWA-3: the service worker keeps only the app shell (never API data), so the installed app opens offline
 * and says so. Needs the production build (vite build + vite preview, as in CI): dev has no service worker.
 */
test.use({ serviceWorkers: 'allow' });

/** Waits until the service worker is active, i.e. the app shell is precached. */
const swReady = (page: Page) => page.evaluate(async () => !!(await navigator.serviceWorker.ready).active);

test.describe('installable app: offline (logged out)', () => {
  requireWeb();
  test.use({ storageState: { cookies: [], origins: [] } });

  test('a service worker is registered on the production build', async ({ page, context }) => {
    await page.goto('/portal/login');
    expect(await swReady(page)).toBe(true);
    expect(context.serviceWorkers().length).toBe(1);
  });

  test('offline, the sign-in page still opens and says the app is offline; online again, the notice goes', async ({
    page,
    context,
  }) => {
    await page.goto('/portal/login');
    expect(await swReady(page)).toBe(true);
    await expect(page.getByTestId('offline-banner')).toBeHidden();

    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Welcome back', exact: true })).toBeVisible();
    await expect(page.locator('#email')).toBeVisible();
    await expect(page.getByTestId('offline-banner')).toBeVisible();
    await expect(page.getByTestId('offline-banner')).toHaveText(
      "You're offline. Data needs a connection, and changes can't be saved until you reconnect.",
    );

    await context.setOffline(false);
    await expect(page.getByTestId('offline-banner')).toBeHidden();
  });
});

test.describe('installable app: the service worker never holds API data', () => {
  requireWeb();
  requireApi();
  requireAuth();

  const isApi = (url: string) => url.startsWith(env.API_URL) || new URL(url).pathname.startsWith('/api/');

  test('API responses never come from the service worker', async ({ page }) => {
    await page.goto('/dashboard');
    expect(await swReady(page)).toBe(true);

    const apiResponses: { url: string; fromSW: boolean }[] = [];
    page.on('response', (r) => {
      if (isApi(r.url())) apiResponses.push({ url: r.url(), fromSW: r.fromServiceWorker() });
    });
    await page.reload(); // this load is controlled by the service worker
    await expect(page.getByTestId('user-menu')).toBeVisible();
    await page.waitForLoadState('networkidle');

    expect(apiResponses.length).toBeGreaterThan(0);
    expect(apiResponses.filter((r) => r.fromSW)).toEqual([]);
  });

  /** Every URL in the browser's Cache Storage, and whether it is a static build file. */
  const cachedUrls = (page: Page) =>
    page.evaluate(async () => {
      const urls: string[] = [];
      for (const name of await caches.keys()) {
        for (const req of await (await caches.open(name)).keys()) urls.push(req.url);
      }
      return urls;
    });
  const STATIC = /\/(assets\/[\w.-]+\.(js|css)|[\w-]+\.(png|ico)|logo\/[\w.-]+\.png|index\.html|manifest\.webmanifest)(\?__WB_REVISION__=\w+)?$/;

  test('the cache holds only static app files, before and after logout', async ({ browser }) => {
    // Own sign-in: logging out the shared storage-state token would end it for every other spec
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] }, serviceWorkers: 'allow' });
    const page = await context.newPage();
    const login = new LoginPage(page, '/auth/login');
    await login.goto();
    await login.login(env.EMAIL, env.PASSWORD);
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.goto('/dashboard/patients');
    expect(await swReady(page)).toBe(true);
    await page.reload(); // controlled load: patients are fetched while the service worker is in charge
    await expect(page.getByTestId('user-menu')).toBeVisible();
    await page.waitForLoadState('networkidle');

    const before = await cachedUrls(page);
    expect(before.length).toBeGreaterThan(0); // the app shell is there
    expect(before.filter(isApi)).toEqual([]);
    expect(before.filter((u) => !STATIC.test(u))).toEqual([]);
    expect(before.filter((u) => u.includes('.map'))).toEqual([]);

    await page.getByTestId('user-menu').click();
    await page.getByRole('menuitem', { name: 'Logout' }).click();
    await expect(page).toHaveURL(/\/auth\/login$/);
    const after = await cachedUrls(page);
    expect(after.filter((u) => !STATIC.test(u))).toEqual([]);
    await context.close();
  });
});
