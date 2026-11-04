import { Browser } from '@playwright/test';
import { test, expect, requireWeb, requireAuth } from '../src/fixtures';
import { OwnClinic, OwnMember, deleteClinic, onboardOwnClinic } from '../src/clinics';
import { nextWeekday } from '../src/days';

/** Settings → Leave (capacity slice c2): a clinician applies, the director approves or rejects, the
 * applicant cancels; the schedule form warns (never blocks) when a booking falls in leave or blocked time.
 * A fresh clinic: director + therapist. */
test.describe('Settings → Leave and the schedule form warning', () => {
  requireWeb();
  requireAuth();
  test.describe.configure({ mode: 'serial' });

  let clinic: OwnClinic;
  let therapist: OwnMember;
  const tuesday = nextWeekday(2, 3);
  const wednesday = nextWeekday(3, 3);
  const thursday = nextWeekday(4, 3);
  const friday = nextWeekday(5, 3);
  const at = (day: string, hhmm: string) => `${day}T${hhmm}:00+05:30`;
  test.beforeAll(async () => {
    clinic = await onboardOwnClinic('leaveui', ['THERAPIST']);
    therapist = clinic.members[0];
  });
  test.afterAll(async () => {
    await therapist?.api.dispose();
    await clinic?.api.dispose();
    if (clinic) await deleteClinic(clinic.adminEmail);
  });

  const signedIn = async (browser: Browser, who: { token: string; user: unknown }, path = '/dashboard/settings') => {
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
    await page.goto(path);
    return { context, page };
  };
  const theirLeave = async () => (await (await therapist.api.get('/api/v1/leave')).json()) as { id: string; status: string; reason: string }[];

  test('a therapist applies for a day of sick leave; the director approves it', async ({ browser }) => {
    const t = await signedIn(browser, therapist);
    try {
      await t.page.getByRole('tab', { name: 'Leave' }).click();
      await expect(t.page.getByTestId('leave-pending-0')).toHaveCount(0); // not an approver
      await t.page.getByTestId('leave-reason').selectOption('sick');
      await t.page.getByTestId('leave-from').fill(tuesday);
      await t.page.getByTestId('leave-to').fill(tuesday);
      await t.page.getByTestId('leave-note').fill('Fever');
      await t.page.getByTestId('leave-apply').click();
      await expect(t.page.getByText('Leave requested')).toBeVisible();
      await expect(t.page.getByTestId('leave-mine-0')).toContainText('Sick');
      await expect(t.page.getByTestId('leave-mine-0')).toContainText('Pending');
    } finally {
      await t.context.close();
    }
    const [leave] = await theirLeave();
    expect(leave).toMatchObject({ reason: 'sick', status: 'pending' });

    const d = await signedIn(browser, clinic);
    try {
      await d.page.getByRole('tab', { name: 'Leave' }).click();
      const row = d.page.getByTestId('leave-pending-0');
      await expect(row).toContainText('Team Member 0');
      await expect(row).toContainText('Fever');
      await d.page.getByTestId('leave-approve-0').click();
      await expect(d.page.getByText('Leave approved')).toBeVisible();
      await expect(d.page.getByTestId('leave-pending-0')).toHaveCount(0);
    } finally {
      await d.context.close();
    }
    expect((await theirLeave())[0].status).toBe('approved');
  });

  test('approval over a booked session is refused with the reason; the director rejects instead', async ({ browser }) => {
    const patient = await (
      await clinic.api.post('/api/v1/patients/', { data: { first_name: 'Booked', last_name: 'Patient', assigned_therapist_id: therapist.user.id } })
    ).json();
    expect((await therapist.api.post('/api/v1/sessions/', { data: { patient_id: patient.id, scheduled_at: at(thursday, '11:00') } })).status()).toBe(200);
    const made = await therapist.api.post(`/api/v1/clinicians/${therapist.user.id}/leave`, {
      data: { reason: 'casual', starts_at: at(thursday, '00:00'), ends_at: at(friday, '00:00') },
    });
    expect(made.status(), await made.text()).toBe(201);

    const d = await signedIn(browser, clinic);
    try {
      await d.page.getByRole('tab', { name: 'Leave' }).click();
      await expect(d.page.getByTestId('leave-pending-0-sessions')).toHaveText('1 booked session in this leave');
      await d.page.getByTestId('leave-approve-0').click();
      await expect(d.page.getByText('Reassign or cancel the 1 booked session in this leave first')).toBeVisible();
      await d.page.getByTestId('leave-reject-0').click();
      await expect(d.page.getByText('Leave rejected')).toBeVisible();
    } finally {
      await d.context.close();
    }
    expect((await theirLeave()).map((l) => l.status)).toEqual(['approved', 'rejected']);
  });

  test('the therapist cancels their approved leave', async ({ browser }) => {
    const t = await signedIn(browser, therapist);
    try {
      await t.page.getByRole('tab', { name: 'Leave' }).click();
      await expect(t.page.getByTestId('leave-mine-0')).toContainText('Approved');
      await expect(t.page.getByTestId('leave-cancel-1')).toHaveCount(0); // a rejected request cannot be cancelled
      await t.page.getByTestId('leave-cancel-0').click();
      await expect(t.page.getByText('Leave cancelled')).toBeVisible();
      await expect(t.page.getByTestId('leave-mine-0')).toContainText('Cancelled');
    } finally {
      await t.context.close();
    }
  });

  test('the schedule form warns about leave and blocked time, and still books', async ({ browser }) => {
    const leave = await (
      await therapist.api.post(`/api/v1/clinicians/${therapist.user.id}/leave`, { data: { reason: 'planned', starts_at: at(wednesday, '00:00'), ends_at: at(thursday, '00:00') } })
    ).json();
    expect((await clinic.api.post(`/api/v1/leave/${leave.id}/approve`)).status()).toBe(200);
    expect((await clinic.api.post(`/api/v1/clinicians/${clinic.user.id}/blocked-time`, {
      data: { reason: 'supervision', starts_at: at(friday, '15:00'), ends_at: at(friday, '16:00') },
    })).status()).toBe(201);
    const patient = await (
      await clinic.api.post('/api/v1/patients/', { data: { first_name: 'Warned', last_name: 'Patient', assigned_therapist_id: therapist.user.id } })
    ).json();

    const d = await signedIn(browser, clinic, `/dashboard/sessions/new?patient_id=${patient.id}`);
    try {
      const page = d.page;
      const warning = page.getByTestId('session-time-off-warning');
      await expect(page.getByTestId('session-clinician')).toHaveValue(therapist.user.id);
      await page.getByLabel('Date & Time').fill(`${wednesday}T11:00`);
      await expect(warning).toHaveText('Team Member 0 is on leave at this time');
      await page.getByLabel('Date & Time').fill(`${tuesday}T11:00`);
      await expect(warning).toHaveCount(0);
      await page.getByTestId('session-clinician').selectOption(clinic.user.id);
      await page.getByLabel('Date & Time').fill(`${friday}T15:30`);
      await expect(warning).toHaveText('You have blocked this time: Supervision');
      await page.getByRole('button', { name: 'Schedule Session' }).click();
      await expect(page).toHaveURL(/\/dashboard\/sessions$/);
    } finally {
      await d.context.close();
    }
    const list = await (await clinic.api.get('/api/v1/sessions/', { params: { patient_id: patient.id } })).json();
    expect(list.sessions).toHaveLength(1);
  });
});
