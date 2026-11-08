import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test, expect, expectNoCrash, requireWeb } from '../src/fixtures';
import { LoginPage } from '../src/pages/login.page';
import { env, FRONTEND_DIST, PLATFORM_DOCS_DIR, PLATFORM_STAFF } from '../src/env';

/**
 * /docs: PsyClinicalMind's internal docs. Platform staff read them; a clinic user who types the URL lands
 * on the dashboard exactly like any unknown path, and the content is never part of the built frontend
 * (it comes from GET /api/v1/docs at runtime).
 */
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });

/** One long prose line per doc (the longest), unique enough that finding it anywhere means the doc leaked. */
function sentinels(): { doc: string; line: string }[] {
  return files(PLATFORM_DOCS_DIR)
    .filter((f) => f.endsWith('.md') && !f.endsWith('README.md'))
    .map((f) => {
      const longest = readFileSync(f, 'utf8').split('\n').map((l) => l.trim())
        .reduce((a, b) => (b.length > a.length ? b : a), '');
      return { doc: relative(PLATFORM_DOCS_DIR, f), line: longest };
    });
}

test.describe('@docs internal docs page', () => {
  requireWeb();

  test.describe('platform staff', () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test('opens /docs, lists the docs and renders the register', async ({ page }) => {
      const login = new LoginPage(page);
      await login.goto();
      await login.login(PLATFORM_STAFF.email, PLATFORM_STAFF.password);
      await expect(page).toHaveURL(/\/dashboard/);

      await page.goto('/docs');
      await expect(page.getByTestId('docs-page')).toBeVisible();
      await expect(page.getByTestId('docs-nav-runbook')).toBeVisible();
      await page.getByTestId('docs-nav-register').click();
      await expect(page).toHaveURL(/\/docs\/register$/);
      await expect(page.getByTestId('docs-content').getByRole('heading', { level: 1 })).toHaveText('Feature register');
      await expect(page.getByTestId('docs-content').locator('table').first()).toBeVisible();

      await page.goto('/docs/help/razorpay');
      await expect(page.getByTestId('docs-content').getByRole('heading', { level: 1 })).toBeVisible();
      await expectNoCrash(page);
    });

    test('an unknown doc shows a not-found message, not a crash', async ({ page }) => {
      const login = new LoginPage(page);
      await login.goto();
      await login.login(PLATFORM_STAFF.email, PLATFORM_STAFF.password);
      await expect(page).toHaveURL(/\/dashboard/);
      await page.goto('/docs/no-such-doc');
      await expect(page.getByTestId('docs-not-found')).toBeVisible();
      await expectNoCrash(page);
    });
  });

  test('a clinic ADMIN typing /docs lands on the dashboard, like any unknown path', async ({ page }) => {
    await page.goto('/docs');
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByTestId('docs-page')).toHaveCount(0);
    await page.goto('/docs/runbook');
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByTestId('docs-page')).toHaveCount(0);
  });

  test('no sidebar or page links to /docs for a clinic user', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByTestId('app-sidebar')).toBeVisible();
    await expect(page.locator('a[href^="/docs"]')).toHaveCount(0);
  });
});

test.describe('@docs the docs never ship in the frontend', () => {
  test('no doc text in any built asset', () => {
    expect(existsSync(FRONTEND_DIST), `${FRONTEND_DIST} missing: run npm run build in frontend/`).toBe(true);
    const docs = sentinels();
    expect(docs.length).toBeGreaterThanOrEqual(18); // register + runbook + 16 help pages
    for (const { doc, line } of docs) expect(line.length, `${doc} has no long line to look for`).toBeGreaterThanOrEqual(60);
    const leaks = files(FRONTEND_DIST).flatMap((asset) => {
      const text = readFileSync(asset, 'latin1');
      return docs.filter(({ line }) => text.includes(line)).map(({ doc }) => `${doc} in ${relative(FRONTEND_DIST, asset)}`);
    });
    expect(leaks).toEqual([]);
  });

  test('the web server does not serve the doc files', async ({ request }) => {
    requireWeb();
    const runbook = sentinels().find((s) => s.doc === 'runbook.md')!;
    for (const path of ['/docs', '/docs/runbook', '/runbook.md', '/platform_docs/runbook.md', '/app/platform_docs/runbook.md']) {
      const res = await request.get(`${env.WEB_URL}${path}`);
      expect(await res.text(), path).not.toContain(runbook.line);
    }
  });
});
