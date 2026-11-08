import { test, expect, requireWeb, requireApi, requireAuth } from '../src/fixtures';
import { env, uniq } from '../src/env';
import { LoginPage } from '../src/pages/login.page';
import { AddPatientPage } from '../src/pages/patients.page';
import { adminApi, assignDemoClinicians } from '../src/catalog';
import { openDay } from '../src/days';
import { searchFor, FOLLOWUPS_LIST, SESSIONS_LIST } from '../src/search';

/**
 * One clinic, one day, through the browser only (the single API shortcut is time-travelling a
 * session into the past for the follow-up queue, since a browser cannot wait a day):
 *
 *   1. the admin logs in, publishes a service, registers a patient and schedules a session
 *   2. the patient books another slot through the public booking link
 *   3. the therapist logs in, sees both sessions and starts the online booking
 *   4. a session is missed → the admin finds it on the Follow-ups page
 */
test.describe.configure({ mode: 'serial' });

// The journey is the only spec that looks a session up by PATIENT NAME. On the booking page the patient picks
// themselves from the people the clinic has on their verified number, so the journey uses the SECOND allow-listed
// test phone exclusively (the shared +919876543210 lists every other spec's patients too).
const TEST_PHONE = '+919876543211'; // test-listed: the booking page accepts it without the phone.email round-trip
const THERAPIST = { email: 'therapist.jane@democlinic.com', password: 'Password123!', name: 'Jane Doe' };

const run = uniq('Journey'); // patient first name + service prefix for this run
const patientFullName = `${run} Patient`;
const serviceName = `${run} Consult`;

const localDateTime = (daysAhead: number, hour: number) => {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  d.setHours(hour, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const isoDate = (daysAhead: number) => openDay(daysAhead); // public booking day: clinics are closed on Sunday

async function loginAs(page: import('@playwright/test').Page, email: string, password: string) {
  const login = new LoginPage(page);
  await login.goto();
  await login.login(email, password);
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 15_000 });
}

test.describe('end-to-end clinic journey', () => {
  requireWeb();
  requireApi();
  requireAuth();
  test.use({ storageState: { cookies: [], origins: [] } });

  // the journey's service must not stay bookable in the shared clinic
  test.afterAll(async () => {
    const api = await adminApi();
    const { services } = await (await api.get('/api/v1/catalog/services', { params: { search: serviceName } })).json();
    for (const s of services ?? []) await api.delete(`/api/v1/catalog/services/${s.id}`);
    await api.dispose();
  });

  test('1. admin publishes a service, registers a patient and schedules a session', async ({ page, api }) => {
    await loginAs(page, env.EMAIL, env.PASSWORD);

    // service (what patients can book)
    await page.goto('/admin/services');
    await page.getByTestId('service-add').click();
    const serviceForm = page.getByTestId('service-form-dialog');
    await serviceForm.getByTestId('service-form-name').fill(serviceName);
    await serviceForm.getByTestId('service-form-description').fill('Journey test service');
    await serviceForm.getByTestId('service-form-duration').fill('50');
    await serviceForm.getByTestId('service-form-price').fill('0'); // free intro: the online booking below must not hit the pay step
    await serviceForm.getByTestId('service-form-save').click();
    await expect(serviceForm).toBeHidden();
    await page.getByTestId('service-search').fill(serviceName);
    await expect(page.getByTestId('services-table').getByRole('row', { name: new RegExp(serviceName) })).toBeVisible();
    // assign who offers it (booking offers a service only with assigned clinicians); the form has no picker yet
    const { services } = await (await api.get('/api/v1/catalog/services', { params: { search: serviceName } })).json();
    await assignDemoClinicians(api, services[0].id);

    // patient
    const form = new AddPatientPage(page);
    await form.goto();
    await form.firstName.fill(run);
    await form.lastName.fill('Patient');
    await form.phone.fill(TEST_PHONE); // the online booking below will attach to this record
    await form.submit.click();
    await expect(page.getByText('Patient created successfully!')).toBeVisible();
    await expect(page).toHaveURL(/\/dashboard\/patients$/);
    await expect(page.getByText(patientFullName)).toBeVisible();

    // session scheduled by the clinic
    await page.goto('/dashboard/sessions/new');
    await page.locator('#patientId').selectOption({ label: `${patientFullName} - No diagnosis` });
    await page.locator('#scheduledAt').fill(localDateTime(1, 11));
    await page.getByRole('button', { name: 'Schedule Session' }).click();
    await expect(page.getByText('Session scheduled successfully!')).toBeVisible();
    await expect(page).toHaveURL(/\/dashboard\/sessions$/);
    // the sessions list is paged on the server: search finds this patient's row
    await page.getByRole('searchbox', { name: 'Search sessions' }).fill(run);
    await expect(page.getByRole('row', { name: new RegExp(patientFullName) }).first()).toBeVisible();
  });

  test('2. the patient books a second slot through the public link', async ({ page, auth }) => {
    await page.goto(`/book/${auth.firmCode}`);
    await page.getByRole('radio', { name: new RegExp(serviceName) }).click();
    await page.getByRole('radio', { name: new RegExp(THERAPIST.name) }).click();
    await page.getByTestId('booking-date').fill(isoDate(2));
    const slots = page.getByTestId('booking-slots').getByRole('radio');
    await expect(slots.first()).toBeVisible({ timeout: 15_000 });
    await slots.first().click();
    await page.getByTestId('booking-phone').fill(TEST_PHONE);
    await page.getByTestId('booking-phone').blur();
    // the patient registered in step 1 is listed on this number: they pick themselves instead of retyping a name
    await page.getByTestId('booking-for').getByRole('radio', { name: patientFullName }).click();
    await expect(page.getByTestId('booking-first-name')).toHaveCount(0);
    await page.getByTestId('booking-submit').click();
    await expect(page.getByTestId('booking-confirmation')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('booking-confirmation')).toContainText(THERAPIST.name);
    await expect(page.getByTestId('booking-confirmation')).toContainText(serviceName);
  });

  test('3. the therapist sees the online booking and starts it', async ({ page }) => {
    await loginAs(page, THERAPIST.email, THERAPIST.password);
    await page.goto('/dashboard/sessions');
    await searchFor(page, page.getByRole('searchbox', { name: 'Search sessions' }), run, SESSIONS_LIST);
    const row = page.getByRole('row', { name: new RegExp(patientFullName) }).filter({ has: page.getByTestId('booked-online') });
    await expect(row).toBeVisible();
    await row.getByTitle('Start Session').click();
    await expect(row).toContainText(/in progress/i, { timeout: 15_000 });
  });

  test('4. a missed session lands on the admin\'s follow-up queue', async ({ page, api }) => {
    // the clinic-scheduled session from step 1, moved into the past (the one API shortcut)
    const patients = await (await api.get('/api/v1/patients/', { params: { limit: 500 } })).json();
    const patient = patients.patients.find((p: { first_name: string }) => p.first_name === run);
    expect(patient, 'journey patient exists').toBeTruthy();
    const sessions = await (await api.get('/api/v1/sessions/', { params: { patient_id: patient.id, limit: 50 } })).json();
    const scheduled = sessions.sessions.find((s: { status: string; booked_via: string | null }) => s.status === 'scheduled' && !s.booked_via);
    expect(scheduled, 'the clinic-scheduled session is still scheduled').toBeTruthy();
    const moved = await api.put(`/api/v1/sessions/${scheduled.id}`, { data: { scheduled_at: new Date(Date.now() - 3 * 3_600_000).toISOString() } });
    expect(moved.status(), await moved.text()).toBe(200);

    await loginAs(page, env.EMAIL, env.PASSWORD);
    await page.goto('/dashboard/follow-ups');
    // The worker syncs a few seconds after the change; the button syncs now and reloads the list
    await page.getByTestId('followup-refresh').click();
    await expect(page.getByTestId('followup-summary')).toBeVisible({ timeout: 15_000 });
    await searchFor(page, page.getByRole('searchbox'), patientFullName, FOLLOWUPS_LIST);
    const row = page.getByTestId('followup-row').filter({ hasText: patientFullName });
    await expect(row).toHaveCount(1, { timeout: 15_000 });
    await expect(row).toContainText('Missed session');
  });

  test('5. cleanup', async ({ api }) => {
    const patients = await (await api.get('/api/v1/patients/', { params: { limit: 500 } })).json();
    const patient = patients.patients.find((p: { first_name: string }) => p.first_name === run);
    if (!patient) return;
    const sessions = await (await api.get('/api/v1/sessions/', { params: { patient_id: patient.id, limit: 50 } })).json();
    for (const s of sessions.sessions) {
      if (s.status !== 'completed' && s.status !== 'cancelled') {
        await api.post(`/api/v1/sessions/${s.id}/cancel`, { data: { reason: 'journey cleanup' } });
      }
    }
    await api.delete(`/api/v1/patients/${patient.id}`);
  });
});
