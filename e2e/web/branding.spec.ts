import { test, expect, requireWeb } from '../src/fixtures';

// The product is PsyClinicalMind. Its copy describes only what exists: no AI assistant, no crisis
// detection (both were removed), one support address.
const OVERCLAIM = /AI-Powered|AI powered|Crisis Detection|crisis detection|Claude|GPT|with AI/i;
const SUPPORT = 'support@psyclinicalmind.com';

test.use({ storageState: { cookies: [], origins: [] } });

test.describe('branding copy', () => {
  requireWeb();

  test('login page: product name, no AI or crisis claims', async ({ page }) => {
    await page.goto('/auth/login');
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    await expect(page).toHaveTitle('PsyClinicalMind - Practice management for mental health clinics');
    await expect(page.getByText('Sign in to your PsyClinicalMind account')).toBeVisible();
    expect(await page.locator('body').innerText()).not.toMatch(OVERCLAIM);
    await expect(page.getByText('Online booking and payments')).toBeVisible();
    await expect(page.getByText('Follow-up queue', { exact: true })).toBeVisible();
  });

  test('page metadata and fallback screens make no AI or crisis claims and name one support address', async ({ page }) => {
    await page.goto('/auth/login');
    const description = await page.locator('meta[name="description"]').getAttribute('content');
    expect(description).toBe('Practice management for mental health clinics: online booking and payments, sessions, and a clinical follow-up queue.');
    for (const selector of ['meta[name="keywords"]', 'meta[property="og:title"]', 'meta[property="og:description"]']) {
      expect(await page.locator(selector).getAttribute('content'), selector).not.toMatch(OVERCLAIM);
    }
    // hidden loading / error fallbacks in index.html count too: search the raw HTML
    const html = await page.content();
    expect(html).not.toMatch(OVERCLAIM);
    const mailtos = [...html.matchAll(/mailto:([^"'?\s>]+)/gi)].map((m) => m[1].toLowerCase());
    expect(new Set(mailtos)).toEqual(new Set([SUPPORT]));
  });
});
