import { test, expect, expectNoCrash, requireWeb, requireAuth } from '../src/fixtures';
import { uniq } from '../src/env';
import { backdate, bookSession, uniqueDay } from '../src/sessions';
import { searchFor, SESSIONS_LIST } from '../src/search';

test.describe('sessions UI', () => {
  requireWeb();
  requireAuth();

  test('list page renders', async ({ page }) => {
    await page.goto('/dashboard/sessions');
    await expect(page.getByRole('heading', { name: 'Session Management' })).toBeVisible();
  });

  test('new-session page renders without crashing', async ({ page }) => {
    await page.goto('/dashboard/sessions/new');
    await expect(page).toHaveURL(/\/dashboard\/sessions\/new$/);
    await expectNoCrash(page);
    await expect(page.locator('form, button[type="submit"]').first()).toBeVisible();
  });

  test('session detail page opens for an API-created session', async ({ page, api }) => {
    const patient = await (await api.post('/api/v1/patients/', { data: { first_name: uniq('SessUI'), last_name: 'Patient' } })).json();
    try {
      const session = await (
        await bookSession(api, { patient_id: patient.id, scheduled_at: new Date(Date.now() + 86_400_000).toISOString() })
      ).json();
      await page.goto(`/dashboard/sessions/${session.id}`);
      await expect(page).toHaveURL(new RegExp(`/dashboard/sessions/${session.id}$`));
      await expectNoCrash(page);
    } finally {
      await api.delete(`/api/v1/patients/${patient.id}`);
    }
  });

  test('End Session on an in-progress row completes it; completing again is refused', async ({ page, api }) => {
    const patient = await (await api.post('/api/v1/patients/', { data: { first_name: uniq('EndUI'), last_name: 'Patient' } })).json();
    try {
      const session = await (
        await bookSession(api, { patient_id: patient.id, scheduled_at: new Date(Date.now() + 2 * 3_600_000).toISOString() })
      ).json();
      expect((await api.post(`/api/v1/sessions/${session.id}/start`)).status()).toBe(200);
      await page.goto('/dashboard/sessions');
      await searchFor(page, page.getByRole('searchbox', { name: 'Search sessions' }), patient.first_name, SESSIONS_LIST);
      const row = page.locator('tr', { hasText: patient.first_name });
      await expect(row.getByTestId('session-end')).toBeVisible();
      await row.getByTestId('session-end').click();
      await expect(page.getByText('Session ended')).toBeVisible();
      await expect.poll(async () => (await (await api.get(`/api/v1/sessions/${session.id}`)).json()).status, { timeout: 15_000 }).toBe('completed');
      await expect(row.getByTestId('session-end')).toHaveCount(0);

      const again = await api.post(`/api/v1/sessions/${session.id}/complete`);
      expect(again.status()).toBe(409);
    } finally {
      await api.delete(`/api/v1/patients/${patient.id}`);
    }
  });

  test('a session that has not started offers no No-show and no attended / no-show outcome (the API would answer 409)', async ({ page, api }) => {
    const patient = await (await api.post('/api/v1/patients/', { data: { first_name: uniq('NotYet'), last_name: 'Patient' } })).json();
    try {
      const session = await (
        await bookSession(api, { patient_id: patient.id, scheduled_at: new Date(Date.now() + 3 * 3_600_000).toISOString() })
      ).json();
      await page.goto('/dashboard/sessions');
      await page.getByRole('searchbox', { name: 'Search sessions' }).fill(patient.first_name);
      const row = page.locator('tr', { hasText: patient.first_name });
      await expect(row.getByTestId('session-cancel')).toBeVisible();
      await expect(row.getByTestId('session-no-show')).toHaveCount(0);

      await page.goto(`/dashboard/sessions/${session.id}`);
      await expect(page.getByTestId('session-cancel')).toBeVisible();
      await expect(page.getByTestId('session-no-show')).toHaveCount(0);
      const outcomes = page.getByTestId('session-outcome-select').locator('option');
      await expect(outcomes).toHaveText(['Choose an outcome', 'Late cancelled by patient', 'Cancelled by patient', 'Cancelled by clinic', 'Rescheduled']);

      await backdate(api, session.id); // its time has come: both are offered
      await page.reload();
      await expect(page.getByTestId('session-no-show')).toBeVisible();
      await expect(page.getByTestId('session-outcome-select').locator('option', { hasText: 'Attended' })).toHaveCount(1);
    } finally {
      await api.delete(`/api/v1/patients/${patient.id}`);
    }
  });

  test('mark a session no-show from the list, then record a cash payment on it', async ({ page, api }) => {
    const patient = await (await api.post('/api/v1/patients/', { data: { first_name: uniq('NoShowUI'), last_name: 'Patient' } })).json();
    try {
      const session = await (
        await bookSession(api, { patient_id: patient.id, scheduled_at: new Date(Date.now() + 2 * 3_600_000).toISOString() })
      ).json();
      await backdate(api, session.id); // no-show needs a session whose time has come
      await page.goto('/dashboard/sessions');
      // the list is paged on the server: search narrows it to this patient
      await searchFor(page, page.getByRole('searchbox', { name: 'Search sessions' }), patient.first_name, SESSIONS_LIST);
      const row = page.locator('tr', { hasText: patient.first_name });
      await expect(row).toBeVisible();
      await row.getByTestId('session-no-show').click();
      await page.getByTestId('session-no-show-dialog-confirm').click(); // optional-reason dialog replaced window.prompt
      await expect.poll(async () => (await (await api.get(`/api/v1/sessions/${session.id}`)).json()).status, { timeout: 15_000 }).toBe('no_show');
      await expect(row).toContainText(/no.show/i);

      await row.getByTestId('session-record-payment').click();
      const dialog = page.getByTestId('record-payment-dialog');
      await dialog.getByTestId('record-payment-amount').fill('500');
      await dialog.getByTestId('record-payment-method').selectOption('cash');
      await dialog.getByTestId('record-payment-save').click();
      await expect(row.getByTestId('payment-status')).toHaveText(/Paid ₹500/);
      const rows = await (await api.get(`/api/v1/sessions/${session.id}/payments`)).json();
      expect(rows).toEqual([expect.objectContaining({ provider: 'manual', method: 'cash', amount_paise: 50000, status: 'paid' })]);
    } finally {
      await api.delete(`/api/v1/patients/${patient.id}`);
    }
  });

  test('the session detail page saves a risk flag', async ({ page, api }) => {
    const patient = await (await api.post('/api/v1/patients/', { data: { first_name: uniq('RiskUI'), last_name: 'Patient' } })).json();
    try {
      const session = await (
        await bookSession(api, { patient_id: patient.id, scheduled_at: new Date(Date.now() + 3 * 3_600_000).toISOString() })
      ).json();
      await page.goto(`/dashboard/sessions/${session.id}`);
      await page.getByTestId('session-risk-flag').check();
      await page.getByTestId('session-risk-level').selectOption('high');
      await page.getByTestId('session-risk-notes').fill('e2e: safety plan reviewed');
      await page.getByTestId('session-risk-save').click();
      await expect.poll(async () => (await (await api.get(`/api/v1/sessions/${session.id}`)).json()).crisis_level).toBe('high');
      await page.goto('/dashboard/sessions');
      await page.getByRole('searchbox', { name: 'Search sessions' }).fill(patient.first_name);
      await expect(page.locator('tr', { hasText: patient.first_name }).getByTestId('session-risk-badge')).toHaveText(/Risk: high/);
    } finally {
      await api.delete(`/api/v1/patients/${patient.id}`);
    }
  });
});

/** "YYYY-MM-DD" in the clinic's zone (Asia/Kolkata for the demo clinic). */
const istDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);

test.describe('sessions UI: paging, types, edit, detail, time zone', () => {
  requireWeb();
  requireAuth();

  test('no summary tiles; the list pages on the server: 20 + 2 rows of 22', async ({ page, api }) => {
    const patient = await (await api.post('/api/v1/patients/', { data: { first_name: uniq('PageUI'), last_name: 'Patient' } })).json();
    try {
      const base = Date.now() + 2 * 86_400_000;
      for (let i = 0; i < 22; i++) {
        const res = await bookSession(api, { patient_id: patient.id, scheduled_at: new Date(base + i * 3_600_000).toISOString() });
        expect(res.status()).toBe(200);
      }
      await page.goto('/dashboard/sessions');
      await expect(page.getByText('Avg Duration')).toHaveCount(0);
      await searchFor(page, page.getByRole('searchbox', { name: 'Search sessions' }), patient.first_name, SESSIONS_LIST);
      const pager = page.getByTestId('sessions-pagination');
      const rows = page.getByTestId('sessions-table').locator('tbody tr');
      await expect(pager).toContainText('Showing 1–20 of 22');
      await expect(rows).toHaveCount(20);
      await pager.getByRole('button', { name: 'Next' }).click();
      await expect(pager).toContainText('Showing 21–22 of 22');
      await expect(rows).toHaveCount(2);
    } finally {
      await api.delete(`/api/v1/patients/${patient.id}`);
    }
  });

  test('search + type filter run on the server; types show their label', async ({ page, api }) => {
    const patient = await (await api.post('/api/v1/patients/', { data: { first_name: uniq('TypeUI'), last_name: 'Patient' } })).json();
    try {
      const day = uniqueDay();
      for (const [hhmm, session_type] of [['10:00', 'individual'], ['11:00', 'family']]) {
        await api.post('/api/v1/sessions/', { data: { patient_id: patient.id, scheduled_at: `${day}T${hhmm}:00+05:30`, session_type } });
      }
      await page.goto('/dashboard/sessions');
      await searchFor(page, page.getByRole('searchbox', { name: 'Search sessions' }), patient.first_name, SESSIONS_LIST);
      const rows = page.getByTestId('sessions-table').locator('tbody tr');
      await expect(rows).toHaveCount(2, { timeout: 15_000 });
      await expect(page.getByTestId('sessions-pagination')).toContainText('of 2');
      await expect(rows.filter({ hasText: 'Individual therapy' })).toHaveCount(1);

      await page.getByRole('button', { name: 'Filters' }).click();
      await page.getByTestId('session-type-filter').selectOption('family');
      await expect(rows).toHaveCount(1);
      await expect(rows.first()).toContainText('Family therapy');
    } finally {
      await api.delete(`/api/v1/patients/${patient.id}`);
    }
  });

  test('the edit dialog reschedules (clinic time) and saves notes', async ({ page, api }) => {
    const patient = await (await api.post('/api/v1/patients/', { data: { first_name: uniq('EditUI'), last_name: 'Patient' } })).json();
    try {
      const day = uniqueDay();
      const session = await (await api.post('/api/v1/sessions/', { data: { patient_id: patient.id, scheduled_at: `${day}T10:00:00+05:30` } })).json();
      await page.goto('/dashboard/sessions');
      await searchFor(page, page.getByRole('searchbox', { name: 'Search sessions' }), patient.first_name, SESSIONS_LIST);
      const row = page.locator('tr', { hasText: patient.first_name });
      await row.getByTestId('session-edit').click();
      const dialog = page.getByTestId('session-edit-dialog');
      await expect(dialog.getByTestId('session-edit-when')).toHaveValue(`${day}T10:00`);
      await dialog.getByTestId('session-edit-when').fill(`${day}T15:30`);
      await dialog.getByTestId('session-edit-notes').fill('moved by e2e');
      await dialog.getByTestId('session-edit-save').click();
      await expect(dialog).toBeHidden();
      await expect
        .poll(async () => {
          const s = await (await api.get(`/api/v1/sessions/${session.id}`)).json();
          return [new Date(s.scheduled_at).toISOString(), s.session_notes];
        })
        .toEqual([new Date(`${day}T10:00:00Z`).toISOString(), 'moved by e2e']);
    } finally {
      await api.delete(`/api/v1/patients/${patient.id}`);
    }
  });

  test('the schedule form sends the clinic offset: 10:00 entered is 10:00 IST', async ({ page, api }) => {
    const patient = await (await api.post('/api/v1/patients/', { data: { first_name: uniq('FormTz'), last_name: 'Patient' } })).json();
    try {
      const day = uniqueDay();
      await page.goto(`/dashboard/sessions/new?patient_id=${patient.id}`);
      // The patient <select> is `required` and gets its options from GET /patients: submitting before that
      // list arrives fails native validation silently (no POST). Wait until the patient is actually chosen.
      await expect(page.getByRole('combobox', { name: 'Patient', exact: true })).toHaveValue(patient.id);
      await page.getByLabel('Date & Time').fill(`${day}T10:00`);
      const created = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/v1/sessions/');
      await page.getByRole('button', { name: 'Schedule Session' }).click();
      expect((await created).status()).toBe(200);
      await expect(page).toHaveURL(/\/dashboard\/sessions$/);
      const { sessions } = await (await api.get('/api/v1/sessions/', { params: { patient_id: patient.id } })).json();
      expect(sessions.map((s: { scheduled_at: string; session_type: string }) => [new Date(s.scheduled_at).toISOString(), s.session_type])).toEqual([
        [new Date(`${day}T04:30:00Z`).toISOString(), 'individual'],
      ]);
    } finally {
      await api.delete(`/api/v1/patients/${patient.id}`);
    }
  });

  test('the detail page names the patient and the therapist', async ({ page, api }) => {
    const patient = await (await api.post('/api/v1/patients/', { data: { first_name: uniq('DetailUI'), last_name: 'Patient' } })).json();
    try {
      const session = await (await bookSession(api, { patient_id: patient.id, scheduled_at: new Date(Date.now() + 86_400_000).toISOString() })).json();
      const detail = await (await api.get(`/api/v1/sessions/${session.id}`)).json();
      await page.goto(`/dashboard/sessions/${session.id}`);
      await expect(page.getByTestId('session-detail-patient')).toHaveText(`${patient.first_name} Patient`);
      await expect(page.getByTestId('session-detail-therapist')).toHaveText(detail.therapist_name);
    } finally {
      await api.delete(`/api/v1/patients/${patient.id}`);
    }
  });

  test('the dashboard grid puts a session in its clinic-time slot', async ({ page, api }) => {
    const hourIst = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
    test.skip(hourIst + 1 > 19, 'the dashboard grid shows today until 20:00 clinic time; no future slot left today');
    // The grid starts at 08:00 (APP_CONFIG.CALENDAR_START_HOUR): before 07:00 IST the next hour has no slot,
    // so book the first slot of the day instead (still in the future). CI runs at night IST.
    const hh = String(Math.max(hourIst + 1, 8)).padStart(2, '0');
    const patient = await (await api.post('/api/v1/patients/', { data: { first_name: uniq('GridUI'), last_name: 'Patient' } })).json();
    try {
      // the hour is fixed (the grid slot under test) and parallel specs book the same demo admin: an admin may
      // double-book with a reason, so this never meets a 409
      const res = await api.post('/api/v1/sessions/', {
        data: { patient_id: patient.id, scheduled_at: `${istDate(new Date())}T${hh}:00:00+05:30`, override_reason: 'e2e: grid slot under test' },
      });
      expect(res.status(), await res.text()).toBe(200);
      await page.goto('/dashboard');
      await page.getByTestId(`schedule-slot-${hh}:00`).click();
      await expect(page.getByTestId('schedule-slot-sessions')).toContainText(`${patient.first_name} Patient`);
      await expect(page.getByTestId('schedule-slot-sessions')).toContainText(`${hh}:00`);
    } finally {
      await api.delete(`/api/v1/patients/${patient.id}`);
    }
  });
});
