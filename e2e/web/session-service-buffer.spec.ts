import { Browser } from '@playwright/test';
import { test, expect, requireWeb, requireAuth } from '../src/fixtures';
import { OwnClinic, OwnMember, deleteClinic, onboardOwnClinic } from '../src/clinics';
import { nextWeekday } from '../src/days';

/** Capacity slice d in the UI: the patient's usual service (edit dialog), and the schedule form's service
 * and notes-buffer fields, prefilled from the usual service and the clinic's buffer. A fresh clinic:
 * director (the admin) + front desk, a 50-minute "Therapy" and a 90-minute "Long session". */
test.describe('schedule form: service and notes buffer', () => {
  requireWeb();
  requireAuth();
  test.describe.configure({ mode: 'serial' });

  let clinic: OwnClinic;
  let desk: OwnMember;
  let longServiceId: string;
  const day = nextWeekday(3, 10);

  test.beforeAll(async () => {
    clinic = await onboardOwnClinic('bufferui', ['SUPPORT_STAFF']);
    desk = clinic.members[0];
    const long = await clinic.api.post('/api/v1/catalog/services', {
      data: { name: 'Long session', description: 'e2e', duration_minutes: 90, price: 0, currency: 'INR' },
    });
    expect(long.status(), await long.text()).toBe(201);
    longServiceId = (await long.json()).id;
  });
  test.afterAll(async () => {
    await desk?.api.dispose();
    await clinic?.api.dispose();
    if (clinic) await deleteClinic(clinic.adminEmail);
  });

  const signedIn = async (browser: Browser, who: { token: string; user: unknown }, path: string) => {
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
  const newPatient = async (first: string) =>
    (await (await clinic.api.post('/api/v1/patients/', { data: { first_name: first, last_name: 'Patient' } })).json()).id as string;

  test('the front desk sets the usual service on the patient record', async ({ browser }) => {
    const patientId = await newPatient('UsualDesk');
    const { context, page } = await signedIn(browser, desk, `/dashboard/patients/${patientId}`);
    try {
      await page.getByTestId('patient-edit').click();
      await expect(page.getByTestId('patient-edit-usual_service_id')).toHaveValue('');
      await page.getByTestId('patient-edit-usual_service_id').selectOption({ label: 'Long session (90 min)' });
      await page.getByTestId('patient-edit-save').click();
      await expect(page.getByTestId('patient-edit-dialog')).toHaveCount(0);
      expect((await (await clinic.api.get(`/api/v1/patients/${patientId}`)).json()).usual_service_id).toBe(longServiceId);
    } finally {
      await context.close();
    }
  });

  test('booking prefills the usual service and the clinic buffer; the session keeps what the form sent', async ({ browser }) => {
    const patientId = await newPatient('UsualBook');
    expect((await clinic.api.put(`/api/v1/patients/${patientId}`, { data: { usual_service_id: longServiceId } })).status()).toBe(200);
    const { context, page } = await signedIn(browser, clinic, `/dashboard/sessions/new?patient_id=${patientId}`);
    try {
      await expect(page.getByRole('combobox', { name: 'Patient', exact: true })).toHaveValue(patientId);
      await expect(page.getByTestId('session-service')).toHaveValue(longServiceId);
      await expect(page.getByTestId('session-buffer')).toHaveValue('10');
      await page.getByTestId('session-buffer').fill('0');
      await page.getByLabel('Date & Time').fill(`${day}T10:00`);
      await page.getByRole('button', { name: 'Schedule Session' }).click();
      await expect(page).toHaveURL(/\/dashboard\/sessions$/);
      const list = await (await clinic.api.get('/api/v1/sessions/', { params: { search: 'UsualBook', limit: 10 } })).json();
      expect(list.sessions.map((s: { duration_minutes: number; buffer_minutes: number }) => [s.duration_minutes, s.buffer_minutes])).toEqual([[90, 0]]);
    } finally {
      await context.close();
    }
  });

  test('a patient with no usual service: the picker is empty and the session gets the default length', async ({ browser }) => {
    const patientId = await newPatient('NoUsual');
    const { context, page } = await signedIn(browser, clinic, `/dashboard/sessions/new?patient_id=${patientId}`);
    try {
      await expect(page.getByRole('combobox', { name: 'Patient', exact: true })).toHaveValue(patientId);
      await expect(page.getByTestId('session-service')).toHaveValue('');
      await page.getByLabel('Date & Time').fill(`${day}T14:00`);
      await page.getByRole('button', { name: 'Schedule Session' }).click();
      await expect(page).toHaveURL(/\/dashboard\/sessions$/);
      const list = await (await clinic.api.get('/api/v1/sessions/', { params: { search: 'NoUsual', limit: 10 } })).json();
      expect(list.sessions.map((s: { duration_minutes: number; buffer_minutes: number }) => [s.duration_minutes, s.buffer_minutes])).toEqual([[50, 10]]);
    } finally {
      await context.close();
    }
  });
});
