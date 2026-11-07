import { Browser } from '@playwright/test';
import { test, expect, requireWeb, requireAuth } from '../src/fixtures';
import { OwnClinic, OwnMember, deleteClinic, onboardOwnClinic } from '../src/clinics';
import { nextWeekday } from '../src/days';

/** Settings → My hours (capacity slice c1): a clinician's own days, hours, breaks and blocked time; a
 * director edits anyone's. A fresh clinic: director + therapist + front desk. */
test.describe('Settings → My hours', () => {
  requireWeb();
  requireAuth();
  test.describe.configure({ mode: 'serial' });

  let clinic: OwnClinic;
  let therapist: OwnMember;
  let desk: OwnMember;
  test.beforeAll(async () => {
    clinic = await onboardOwnClinic('myhoursui', ['THERAPIST', 'SUPPORT_STAFF']);
    [therapist, desk] = clinic.members;
  });
  test.afterAll(async () => {
    for (const m of clinic?.members ?? []) await m.api.dispose();
    await clinic?.api.dispose();
    if (clinic) await deleteClinic(clinic.adminEmail);
  });

  const signedIn = async (browser: Browser, who: { token: string; user: unknown }) => {
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    await context.addInitScript(
      ([t, u, id]) => {
        localStorage.setItem('auth_token', t);
        localStorage.setItem('auth_user', u);
        localStorage.setItem('tenant_id', id);
      },
      [who.token, JSON.stringify(who.user), clinic.tenantId],
    );
    const page = await context.newPage();
    await page.goto('/dashboard/settings');
    return { context, page };
  };

  test('a therapist sets their own days and hours and blocks time for supervision', async ({ browser }) => {
    const { context, page } = await signedIn(browser, therapist);
    try {
      await page.getByRole('tab', { name: 'My hours' }).click();
      await expect(page.getByTestId('my-hours-following')).toBeVisible(); // follows the clinic until saved
      await expect(page.getByTestId('my-hours-clinician')).toHaveCount(0); // only their own
      await expect(page.getByTestId('my-hours-open')).toHaveValue('10:00');

      for (const day of [2, 4, 6]) await page.getByTestId(`my-hours-day-${day}`).uncheck(); // keep Mon, Wed, Fri
      await page.getByTestId('my-hours-open').fill('11:00');
      await page.getByTestId('my-hours-close').fill('17:00');
      await page.getByTestId('my-hours-save').click();
      await expect(page.getByText('Hours saved')).toBeVisible();
      await expect(page.getByTestId('my-hours-following')).toHaveCount(0);
      expect(await (await therapist.api.get(`/api/v1/clinicians/${therapist.user.id}/hours`)).json()).toEqual({
        custom: true, open_days: [1, 3, 5], open: '11:00', close: '17:00', breaks: [],
      });

      const tuesday = nextWeekday(2, 3);
      await page.getByTestId('my-hours-block-reason').selectOption('supervision');
      await page.getByTestId('my-hours-block-date').fill(tuesday);
      await page.getByTestId('my-hours-block-start').fill('15:00');
      await page.getByTestId('my-hours-block-end').fill('16:00');
      await page.getByTestId('my-hours-block-note').fill('Peer group');
      await page.getByTestId('my-hours-block-add').click();
      await expect(page.getByText('Blocked time added')).toBeVisible();
      await expect(page.getByTestId('my-hours-block-0')).toContainText('Supervision');
      await expect(page.getByTestId('my-hours-block-0')).toContainText('15:00–16:00');
      const listed = await (await therapist.api.get(`/api/v1/clinicians/${therapist.user.id}/blocked-time`)).json();
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ reason: 'supervision', note: 'Peer group' });
      expect(new Date(listed[0].starts_at).getTime()).toBe(new Date(`${tuesday}T15:00:00+05:30`).getTime());

      await page.getByTestId('my-hours-block-remove-0').click();
      await expect(page.getByText('Blocked time removed')).toBeVisible();
      await expect(page.getByTestId('my-hours-block-0')).toHaveCount(0);
      expect(await (await therapist.api.get(`/api/v1/clinicians/${therapist.user.id}/blocked-time`)).json()).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test('hours that end before they start are refused with the rule, and nothing is saved', async ({ browser }) => {
    const { context, page } = await signedIn(browser, therapist);
    try {
      await page.getByRole('tab', { name: 'My hours' }).click();
      await expect(page.getByTestId('my-hours-open')).toHaveValue('11:00');
      await page.getByTestId('my-hours-close').fill('09:00');
      await page.getByTestId('my-hours-save').click();
      await expect(page.getByTestId('my-hours-error')).toHaveText('Hours must end after they start');
      expect((await (await therapist.api.get(`/api/v1/clinicians/${therapist.user.id}/hours`)).json()).close).toBe('17:00');
    } finally {
      await context.close();
    }
  });

  test("the director picks the therapist, sees their hours and puts them back on the clinic's", async ({ browser }) => {
    const { context, page } = await signedIn(browser, clinic);
    try {
      await page.getByRole('tab', { name: 'My hours' }).click();
      const picker = page.getByTestId('my-hours-clinician');
      await expect(picker).toHaveValue(clinic.user.id); // the director is a clinician: themselves first
      await picker.selectOption(therapist.user.id);
      await expect(page.getByTestId('my-hours-open')).toHaveValue('11:00');
      await page.getByTestId('my-hours-reset').click();
      await expect(page.getByText("Using the clinic's hours")).toBeVisible();
      await expect(page.getByTestId('my-hours-following')).toBeVisible();
      await expect(page.getByTestId('my-hours-open')).toHaveValue('10:00');
      expect((await (await therapist.api.get(`/api/v1/clinicians/${therapist.user.id}/hours`)).json()).custom).toBe(false);
    } finally {
      await context.close();
    }
  });

  test('the front desk has no My hours tab', async ({ browser }) => {
    const { context, page } = await signedIn(browser, desk);
    try {
      await expect(page.getByRole('tab', { name: 'Profile' })).toBeVisible();
      await expect(page.getByRole('tab', { name: 'My hours' })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
