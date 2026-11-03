import { request as pwRequest } from '@playwright/test';
import { test, expect, requireWeb, requireAuth } from '../src/fixtures';
import { env, uniq, DEMO_THERAPIST, DEMO_PSYCHOLOGIST } from '../src/env';
import { uniqueDay } from '../src/sessions';

/** The schedule form's clinician picker: staff who book for others choose the clinician (capacity a3). */
test.describe('schedule form: book with a chosen clinician', () => {
  requireWeb();
  requireAuth();

  const idOf = async (creds: { email: string; password: string }) => {
    const anon = await pwRequest.newContext({ baseURL: env.API_URL });
    const body = await (await anon.post('/api/v1/auth/login', { data: { ...creds, audience: 'staff' } })).json();
    await anon.dispose();
    return body as { access_token: string; user: { id: string }; tenant: { id: string } };
  };

  test("an admin's picker starts at the patient's clinician; the session goes to the one picked", async ({ page, api }) => {
    const jane = await idOf(DEMO_THERAPIST);
    const smith = await idOf(DEMO_PSYCHOLOGIST);
    const day = uniqueDay();
    const patient = await (
      await api.post('/api/v1/patients/', { data: { first_name: uniq('Picker'), last_name: 'Patient', assigned_therapist_id: jane.user.id } })
    ).json();
    try {
      await page.goto(`/dashboard/sessions/new?patient_id=${patient.id}`);
      const picker = page.getByTestId('session-clinician');
      await expect(picker).toHaveValue(jane.user.id);
      // only bookable clinicians are offered: no admin, intern or front desk
      await expect(picker.locator('option', { hasText: 'Ira Intern' })).toHaveCount(0);
      await picker.selectOption(smith.user.id);
      await page.getByLabel('Date & Time').fill(`${day}T12:00`);
      await page.getByRole('button', { name: 'Schedule Session' }).click();
      await expect(page).toHaveURL(/\/dashboard\/sessions$/);

      const list = await (await api.get('/api/v1/sessions/', { params: { patient_id: patient.id } })).json();
      expect(list.sessions).toHaveLength(1);
      expect((await (await api.get(`/api/v1/sessions/${list.sessions[0].id}`)).json()).therapist_id).toBe(smith.user.id);
    } finally {
      await api.delete(`/api/v1/patients/${patient.id}`);
    }
  });

  test('a therapist books only themselves: no picker', async ({ browser, api }) => {
    const jane = await idOf(DEMO_THERAPIST);
    const patient = await (
      await api.post('/api/v1/patients/', { data: { first_name: uniq('NoPicker'), last_name: 'Patient', assigned_therapist_id: jane.user.id } })
    ).json();
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    try {
      await context.addInitScript(
        ([token, user, tenantId]) => {
          localStorage.setItem('auth_token', token);
          localStorage.setItem('auth_user', user);
          localStorage.setItem('tenant_id', tenantId);
        },
        [jane.access_token, JSON.stringify(jane.user), jane.tenant.id],
      );
      const page = await context.newPage();
      await page.goto(`/dashboard/sessions/new?patient_id=${patient.id}`);
      await expect(page.getByLabel('Date & Time')).toBeVisible();
      await expect(page.getByTestId('session-clinician')).toHaveCount(0);
    } finally {
      await context.close();
      await api.delete(`/api/v1/patients/${patient.id}`);
    }
  });
});
