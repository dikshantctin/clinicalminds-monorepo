import { Browser } from '@playwright/test';
import { test, expect, requireWeb, requireAuth } from '../src/fixtures';
import { deleteClinic } from '../src/clinics';
import { addDays } from '../src/days';
import { CapacityWeek, buildCapacityWeek } from '../src/capacity';

/** The "Clinician time" page (capacity slice f) over the week built in src/capacity.ts: the director sees
 * everyone with the overload warning, a clinician their own row, the front desk free time only. */
test.describe('Clinician time page', () => {
  requireWeb();
  requireAuth();
  test.describe.configure({ mode: 'serial' });

  let w: CapacityWeek;
  test.beforeAll(async () => {
    w = await buildCapacityWeek('capui');
  });
  test.afterAll(async () => {
    for (const m of w?.clinic.members ?? []) await m.api.dispose();
    await w?.clinic.api.dispose();
    if (w) await deleteClinic(w.clinic.adminEmail);
  });

  const signedIn = async (browser: Browser, who: { token: string; user: unknown }, path: string) => {
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    await context.addInitScript(
      ([t, u, id]) => {
        localStorage.setItem('auth_token', t);
        localStorage.setItem('auth_user', u);
        localStorage.setItem('tenant_id', id);
      },
      [who.token, JSON.stringify(who.user), w.clinic.tenantId],
    );
    const page = await context.newPage();
    await page.goto(path);
    return { context, page };
  };

  test('the director: sidebar link, every clinician, hours and the overload warning; next week moves on', async ({ browser }) => {
    const { context, page } = await signedIn(browser, w.clinic, '/dashboard');
    try {
      await page.getByTestId('app-sidebar').getByRole('link', { name: 'Clinician time' }).click();
      await expect(page).toHaveURL(/\/dashboard\/capacity$/);
      await expect(page.getByRole('heading', { name: 'Clinician time' })).toBeVisible();

      await page.goto(`/dashboard/capacity?week=${w.monday}`);
      await expect(page.getByTestId('capacity-week')).toHaveText(`Week of ${w.monday}`);
      await expect(page.getByTestId(/^capacity-row-/)).toHaveCount(2);
      const t = page.getByTestId(`capacity-row-${w.therapist.user.id}`);
      await expect(t.getByTestId('capacity-name')).toHaveText('Team Member 0');
      await expect(t.getByTestId('capacity-available')).toHaveText('39 h');
      await expect(t.getByTestId('capacity-used')).toHaveText('2 h 30 min');
      await expect(t.getByTestId('capacity-no-show')).toHaveText('1 h');
      await expect(t.getByTestId('capacity-free')).toHaveText('36 h 30 min');
      await expect(t.getByTestId('capacity-extra')).toHaveText('1 h 10 min');
      await expect(t.getByTestId('capacity-percent')).toHaveText('6%');
      await expect(t.getByTestId('capacity-overload')).toHaveCount(0);
      const d = page.getByTestId(`capacity-row-${w.clinic.user.id}`);
      await expect(d.getByTestId('capacity-percent')).toHaveText('92%');
      await expect(d.getByTestId('capacity-overload')).toHaveText('Over 85%');

      await page.getByTestId('capacity-next-week').click();
      await expect(page).toHaveURL(new RegExp(`week=${addDays(w.monday, 7)}$`));
      await expect(page.getByTestId('capacity-week')).toHaveText(`Week of ${addDays(w.monday, 7)}`);
      await expect(page.getByTestId(`capacity-row-${w.therapist.user.id}`).getByTestId('capacity-used')).toHaveText('0 min');
    } finally {
      await context.close();
    }
  });

  test('a clinician sees only their own row', async ({ browser }) => {
    const { context, page } = await signedIn(browser, w.therapist, `/dashboard/capacity?week=${w.monday}`);
    try {
      await expect(page.getByTestId(/^capacity-row-/)).toHaveCount(1);
      await expect(page.getByTestId(`capacity-row-${w.therapist.user.id}`).getByTestId('capacity-free')).toHaveText('36 h 30 min');
    } finally {
      await context.close();
    }
  });

  test('the front desk sees free time only', async ({ browser }) => {
    const { context, page } = await signedIn(browser, w.desk, `/dashboard/capacity?week=${w.monday}`);
    try {
      await expect(page.getByTestId(/^capacity-row-/)).toHaveCount(2);
      const t = page.getByTestId(`capacity-row-${w.therapist.user.id}`);
      await expect(t.getByTestId('capacity-free')).toHaveText('36 h 30 min');
      await expect(page.getByTestId('capacity-used')).toHaveCount(0);
      await expect(page.getByTestId('capacity-available')).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
