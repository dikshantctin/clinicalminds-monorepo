import { test, expect, requireWeb, requireApi, requireAuth } from '../src/fixtures';
import { LoginPage } from '../src/pages/login.page';
import { env, DEMO_PATIENT } from '../src/env';
import type { Page } from '@playwright/test';

/**
 * "Stay signed in" in the browser: the 1-hour access token is renewed quietly with the stored refresh key
 * (POST /auth/session/refresh), and logout ends the sign-in on the server. Fresh storage per test.
 */
test.use({ storageState: { cookies: [], origins: [] } });

const REFRESH = '/api/v1/auth/session/refresh';
const STAY = 'login-stay-signed-in';

const stored = (page: Page, key: string) => page.evaluate((k) => localStorage.getItem(k), key);

/** Same token with exp moved into the past: the signature no longer matches, so the API answers 401. */
const expired = (jwt: string) => {
  const [h, p, s] = jwt.split('.');
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  claims.exp = Math.floor(Date.now() / 1000) - 60;
  return `${h}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${s}`;
};

/**
 * Reload with an expired access token (and optionally a changed refresh key, null = removed). The storage is
 * changed by an init script in the NEW page only: changing it in the live page let that page renew too, and the
 * reload dropped the renewal's answer (the server had already rotated the key).
 */
async function reloadExpired(page: Page, refreshKey?: string | null): Promise<string> {
  const token = expired((await stored(page, 'auth_token')) ?? '');
  await page.addInitScript(
    ({ token, refreshKey, setRefresh }) => {
      if (sessionStorage.getItem('e2e_expired')) return; // once, not on later navigations
      sessionStorage.setItem('e2e_expired', '1');
      localStorage.setItem('auth_token', token);
      if (setRefresh) {
        if (refreshKey === null) localStorage.removeItem('refresh_token');
        else localStorage.setItem('refresh_token', refreshKey as string);
      }
    },
    { token, refreshKey: refreshKey ?? null, setRefresh: refreshKey !== undefined },
  );
  await page.reload();
  return token;
}

async function signIn(page: Page, path: '/auth/login' | '/portal/login', email: string, password: string) {
  const login = new LoginPage(page, path);
  await login.goto();
  await page.getByTestId(STAY).check();
  await login.login(email, password);
}

test.describe('stay signed in (browser)', () => {
  requireWeb();
  requireApi();
  requireAuth();

  test('both sign-in pages show an unticked "Stay signed in" box', async ({ page }) => {
    for (const path of ['/auth/login', '/portal/login']) {
      await page.goto(path);
      await expect(page.getByTestId(STAY)).toBeVisible();
      await expect(page.getByTestId(STAY)).not.toBeChecked();
      await expect(page.getByText('Use only on your own device.')).toBeVisible();
    }
  });

  test('staff: with an expired access token the app renews quietly and stays on the dashboard', async ({ page }) => {
    await signIn(page, '/auth/login', env.EMAIL, env.PASSWORD);
    await expect(page).toHaveURL(/\/dashboard$/);
    const refreshBefore = await stored(page, 'refresh_token');
    expect(refreshBefore).not.toBeNull();

    const renewed = page.waitForResponse((r) => r.url().endsWith(REFRESH));
    const expiredToken = await reloadExpired(page);
    expect((await renewed).status()).toBe(200);

    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByTestId('user-menu')).toBeVisible();
    expect(await stored(page, 'auth_token')).not.toBe(expiredToken);
    expect(await stored(page, 'refresh_token')).not.toBe(refreshBefore);
  });

  test('patient: with an expired access token the app renews quietly and stays on the portal', async ({ page }) => {
    await signIn(page, '/portal/login', DEMO_PATIENT.email, DEMO_PATIENT.password);
    await expect(page).toHaveURL(/\/portal$/);
    const refreshBefore = await stored(page, 'refresh_token');
    expect(refreshBefore).not.toBeNull();

    const renewed = page.waitForResponse((r) => r.url().endsWith(REFRESH));
    const expiredToken = await reloadExpired(page);
    expect((await renewed).status()).toBe(200);

    await expect(page).toHaveURL(/\/portal$/);
    await expect(page.getByRole('button', { name: 'Logout' })).toBeVisible();
    expect(await stored(page, 'auth_token')).not.toBe(expiredToken);
    expect(await stored(page, 'refresh_token')).not.toBe(refreshBefore);
  });

  test('with no refresh key, an expired access token sends staff to the sign-in', async ({ page }) => {
    await signIn(page, '/auth/login', env.EMAIL, env.PASSWORD);
    await expect(page).toHaveURL(/\/dashboard$/);

    await reloadExpired(page, null);

    await expect(page).toHaveURL(/\/auth\/login$/);
    expect(await stored(page, 'auth_token')).toBeNull();
  });

  test('a patient whose sign-in has ended is sent to the patient sign-in', async ({ page }) => {
    await signIn(page, '/portal/login', DEMO_PATIENT.email, DEMO_PATIENT.password);
    await expect(page).toHaveURL(/\/portal$/);

    const refused = page.waitForResponse((r) => r.url().endsWith(REFRESH));
    await reloadExpired(page, 'not-a-real-refresh-key');
    expect((await refused).status()).toBe(401);

    await expect(page).toHaveURL(/\/portal\/login$/);
    expect(await stored(page, 'refresh_token')).toBeNull();
  });

  test('after logout the old refresh key no longer works', async ({ page, anon }) => {
    await signIn(page, '/auth/login', env.EMAIL, env.PASSWORD);
    await expect(page).toHaveURL(/\/dashboard$/);
    const key = await stored(page, 'refresh_token');
    expect(key).not.toBeNull();

    const loggedOut = page.waitForResponse((r) => r.url().endsWith('/api/v1/auth/logout'));
    await page.getByTestId('user-menu').click();
    await page.getByRole('menuitem', { name: 'Logout' }).click();
    expect((await loggedOut).status()).toBe(200);
    await expect(page).toHaveURL(/\/auth\/login$/);
    expect(await stored(page, 'refresh_token')).toBeNull();

    const res = await anon.post(REFRESH, { data: { refresh_token: key } });
    expect(res.status()).toBe(401);
    expect((await res.json()).message).toBe('Session ended');
  });
});
