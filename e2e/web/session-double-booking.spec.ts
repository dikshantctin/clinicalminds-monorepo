import { request as pwRequest } from '@playwright/test';
import { test, expect, requireWeb, requireAuth } from '../src/fixtures';
import { env, uniq, DEMO_THERAPIST } from '../src/env';
import { uniqueDay } from '../src/sessions';

/** The schedule form when the clinician already has a session at that time (capacity MVP §3). */
test.describe('schedule form: double booking', () => {
  requireWeb();
  requireAuth();

  test('an admin sees the clash and may book anyway with a reason', async ({ page, api }) => {
    const day = uniqueDay();
    const first = uniq('ClashUI');
    const patient = await (await api.post('/api/v1/patients/', { data: { first_name: first, last_name: 'Patient' } })).json();
    try {
      const booked = await api.post('/api/v1/sessions/', { data: { patient_id: patient.id, scheduled_at: `${day}T10:00:00+05:30` } });
      expect(booked.status(), await booked.text()).toBe(200);

      await page.goto(`/dashboard/sessions/new?patient_id=${patient.id}`);
      // the patient <select> is `required` and its options come from GET /patients: wait until the patient is chosen,
      // or a click before that list arrives fails native validation silently (no POST)
      await expect(page.getByRole('combobox', { name: 'Patient', exact: true })).toHaveValue(patient.id);
      await page.getByLabel('Date & Time').fill(`${day}T10:30`);
      await page.getByRole('button', { name: 'Schedule Session' }).click();
      await expect(page.getByTestId('session-clash')).toContainText('You already have a session at that time');
      await expect(page).toHaveURL(/\/dashboard\/sessions\/new/); // nothing was booked
      await expect(page.getByTestId('session-override-submit')).toBeDisabled();
      await page.getByTestId('session-override-reason').fill('crisis call');
      await page.getByTestId('session-override-submit').click();
      await expect(page).toHaveURL(/\/dashboard\/sessions$/);

      const list = await (await api.get('/api/v1/sessions/', { params: { search: first, limit: 10 } })).json();
      const forced = list.sessions.find((s: { scheduled_at: string }) => new Date(s.scheduled_at).getTime() === new Date(`${day}T10:30:00+05:30`).getTime());
      expect(forced, 'the overridden booking exists').toBeTruthy();
      const detail = await (await api.get(`/api/v1/sessions/${forced.id}`)).json();
      expect(detail.session_notes).toContain('Double-booked (override): crisis call');
    } finally {
      await api.delete(`/api/v1/patients/${patient.id}`);
    }
  });

  test('a therapist sees the clash but no way to book anyway', async ({ browser, api }) => {
    const anon = await pwRequest.newContext({ baseURL: env.API_URL });
    const login = await (await anon.post('/api/v1/auth/login', { data: { ...DEMO_THERAPIST, audience: 'staff' } })).json();
    await anon.dispose();
    const jane = await pwRequest.newContext({
      baseURL: env.API_URL,
      extraHTTPHeaders: { Authorization: `Bearer ${login.access_token}`, 'X-Tenant-ID': login.tenant.id },
    });
    const day = uniqueDay();
    const patient = await (
      await api.post('/api/v1/patients/', { data: { first_name: uniq('ClashJane'), last_name: 'Patient', assigned_therapist_id: login.user.id } })
    ).json();
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    try {
      expect((await jane.post('/api/v1/sessions/', { data: { patient_id: patient.id, scheduled_at: `${day}T15:00:00+05:30` } })).status()).toBe(200);
      await context.addInitScript(
        ([token, user, tenantId]) => {
          localStorage.setItem('auth_token', token);
          localStorage.setItem('auth_user', user);
          localStorage.setItem('tenant_id', tenantId);
        },
        [login.access_token, JSON.stringify(login.user), login.tenant.id],
      );
      const page = await context.newPage();
      await page.goto(`/dashboard/sessions/new?patient_id=${patient.id}`);
      // the patient <select> is `required` and its options come from GET /patients: wait until the patient is chosen,
      // or a click before that list arrives fails native validation silently (no POST)
      await expect(page.getByRole('combobox', { name: 'Patient', exact: true })).toHaveValue(patient.id);
      await page.getByLabel('Date & Time').fill(`${day}T15:20`);
      await page.getByRole('button', { name: 'Schedule Session' }).click();
      await expect(page.getByTestId('session-clash')).toContainText('You already have a session at that time');
      await expect(page.getByTestId('session-override-reason')).toHaveCount(0);
    } finally {
      await context.close();
      await jane.dispose();
      await api.delete(`/api/v1/patients/${patient.id}`);
    }
  });
});
