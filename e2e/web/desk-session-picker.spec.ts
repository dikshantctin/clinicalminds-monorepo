import { request as pwRequest, type APIRequestContext } from '@playwright/test';
import { test, expect, requireWeb, requireAuth } from '../src/fixtures';
import { env, uniq } from '../src/env';
import { E2E_CLINIC, deleteClinic } from '../src/clinics';
import { LoginPage } from '../src/pages/login.page';
import { uniqueDay } from '../src/sessions';

// The front desk books for a clinician: New session's picker lists the clinic's clinicians. It read
// /teams/users, which is 403 for SUPPORT_STAFF since #70, so the desk saw an empty list.
const PASSWORD = 'Password123!';
const PHONE = '+919876543211'; // VERIFICATION_TEST_PHONES: onboarding skips phone.email

test.describe('front desk: New session clinician picker', () => {
  requireWeb();
  requireAuth();
  test.use({ storageState: { cookies: [], origins: [] } });

  const slug = uniq('deskpick').toLowerCase();
  const email = (who: string) => `${who}.${slug}@example.com`;
  const ids: Record<string, string> = {};
  let admin: APIRequestContext;
  let patientId: string;

  test.beforeAll(async () => {
    const anon = await pwRequest.newContext({ baseURL: env.API_URL });
    const member = (who: string, role: string) => ({
      email: email(who), first_name: who, last_name: 'Pick', role, phone: PHONE, temporary_password: PASSWORD, send_invitation: false,
      ...(role === 'SUPPORT_STAFF' ? {} : { license_number: `LIC-${who}-${slug}`, license_type: 'RCI' }),
    });
    const onboarded = await anon.post('/api/v1/onboarding/complete', {
      data: {
        organization: {
          name: `${E2E_CLINIC} ${slug}`, type: 'clinic', contact_email: `${slug}@example.com`, contact_phone: PHONE,
          address_line1: '1 MG Road', city: 'Pune', state: 'MH', postal_code: '411001',
        },
        plan: { plan_type: 'basic', max_users: 10, max_patients: 100, max_sessions_per_month: 500 },
        admin: { email: email('admin'), password: PASSWORD, first_name: 'admin', last_name: 'Pick', phone: PHONE },
        admin_role: 'ADMIN',
        team_members: [member('therapist', 'THERAPIST'), member('psych', 'PSYCHOLOGIST'), member('intern', 'INTERN'), member('desk', 'SUPPORT_STAFF')],
        timezone: 'Asia/Kolkata',
      },
    });
    expect(onboarded.status(), await onboarded.text()).toBe(200);
    for (const who of ['admin', 'therapist', 'psych']) {
      const body = await (await anon.post('/api/v1/auth/login', { data: { email: email(who), password: PASSWORD } })).json();
      ids[who] = body.user.id;
      if (who === 'admin') {
        admin = await pwRequest.newContext({
          baseURL: env.API_URL,
          extraHTTPHeaders: { Authorization: `Bearer ${body.access_token}`, 'X-Tenant-ID': body.tenant.id },
        });
      }
    }
    await anon.dispose();
    const patient = await admin.post('/api/v1/patients/', {
      data: { first_name: `${slug}desk`, last_name: 'Patient', assigned_therapist_id: ids.therapist },
    });
    expect(patient.status(), await patient.text()).toBe(200);
    patientId = (await patient.json()).id;
  });

  test.afterAll(async () => {
    await admin.dispose();
    await deleteClinic(email('admin'));
  });

  test("the desk sees the clinic's clinicians and books the one it picks", async ({ page }) => {
    const login = new LoginPage(page);
    await login.goto();
    await login.login(email('desk'), PASSWORD);
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.goto(`/dashboard/sessions/new?patient_id=${patientId}`);

    const picker = page.getByTestId('session-clinician');
    // the patient's clinician first; no "Me", no intern, no admin, no desk
    await expect(picker).toHaveValue(ids.therapist);
    await expect(picker.locator('option:not([value=""])')).toHaveText(['psych Pick', 'therapist Pick']);

    await picker.selectOption(ids.psych);
    await page.getByLabel('Date & Time').fill(`${uniqueDay()}T12:00`);
    await page.getByRole('button', { name: 'Schedule Session' }).click();
    await expect(page).toHaveURL(/\/dashboard\/sessions$/);
    const list = await (await admin.get('/api/v1/sessions/', { params: { patient_id: patientId } })).json();
    expect(list.sessions).toHaveLength(1);
    expect((await (await admin.get(`/api/v1/sessions/${list.sessions[0].id}`)).json()).therapist_id).toBe(ids.psych);
  });
});
