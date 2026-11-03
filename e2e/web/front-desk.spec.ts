import { request as pwRequest, APIRequestContext } from '@playwright/test';
import { test, expect, requireWeb, requireAuth } from '../src/fixtures';
import { env, uniq } from '../src/env';
import { E2E_CLINIC, deleteClinic } from '../src/clinics';
import { LoginPage } from '../src/pages/login.page';
import { DashboardPage } from '../src/pages/dashboard.page';
import { AddPatientPage } from '../src/pages/patients.page';

// The front desk (SUPPORT_STAFF) works Patients and Sessions without seeing clinical content.
const PASSWORD = 'Password123!';
const ALLOW_LISTED_PHONE = '+919876543211'; // VERIFICATION_TEST_PHONES: onboarding skips phone.email, logins count as verified

async function authed(email: string): Promise<{ ctx: APIRequestContext; userId: string }> {
  const anon = await pwRequest.newContext({ baseURL: env.API_URL });
  const res = await anon.post('/api/v1/auth/login', { data: { email, password: PASSWORD } });
  const text = await res.text();
  await anon.dispose();
  expect(res.status(), text).toBe(200);
  const body = JSON.parse(text);
  const ctx = await pwRequest.newContext({
    baseURL: env.API_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${body.access_token}`, 'X-Tenant-ID': body.tenant.id },
  });
  return { ctx, userId: body.user.id };
}

test.describe('front desk (SUPPORT_STAFF) in the browser', () => {
  requireWeb();
  requireAuth();
  test.use({ storageState: { cookies: [], origins: [] } });

  const slug = uniq('fdweb').toLowerCase();
  const adminEmail = `admin.${slug}@example.com`;
  const deskEmail = `desk.${slug}@example.com`;
  const patientName = uniq('Booked');

  test.beforeAll(async () => {
    const anon = await pwRequest.newContext({ baseURL: env.API_URL });
    const member = (who: string, role: string) => ({
      email: `${who}.${slug}@example.com`, first_name: who, last_name: 'Staff', role, phone: ALLOW_LISTED_PHONE,
      temporary_password: PASSWORD, send_invitation: false,
      ...(role === 'THERAPIST' ? { license_number: `LIC-${slug}` } : {}),
    });
    const onboarded = await anon.post('/api/v1/onboarding/complete', {
      data: {
        organization: {
          name: `${E2E_CLINIC} ${slug}`, type: 'clinic', contact_email: `${slug}@example.com`, contact_phone: ALLOW_LISTED_PHONE,
          address_line1: '1 Road', city: 'Pune', state: 'MH', postal_code: '411001',
        },
        plan: { plan_type: 'basic', max_users: 5, max_patients: 100, max_sessions_per_month: 500 },
        admin: { email: adminEmail, password: PASSWORD, first_name: 'Desk', last_name: 'Admin', phone: ALLOW_LISTED_PHONE },
        admin_role: 'ADMIN',
        team_members: [member('desk', 'SUPPORT_STAFF'), member('therapist', 'THERAPIST')],
      },
    });
    expect(onboarded.status(), await onboarded.text()).toBe(200);
    await anon.dispose();

    // a therapist's patient and session, with a diagnosis and a risk flag the desk must not see
    const therapist = await authed(`therapist.${slug}@example.com`);
    try {
      const patient = await therapist.ctx.post('/api/v1/patients/', {
        data: { first_name: patientName, last_name: 'Patient', primary_diagnosis: 'F41.1 Generalised anxiety' },
      });
      expect(patient.status(), await patient.text()).toBe(200);
      const session = await therapist.ctx.post('/api/v1/sessions/', {
        data: { patient_id: (await patient.json()).id, scheduled_at: new Date(Date.now() + 2 * 86_400_000).toISOString() },
      });
      expect(session.status(), await session.text()).toBe(200);
      const flagged = await therapist.ctx.put(`/api/v1/sessions/${(await session.json()).id}`, {
        data: { risk_flag: true, risk_level: 'high', risk_notes: 'Risk observed' },
      });
      expect(flagged.status(), await flagged.text()).toBe(200);
    } finally {
      await therapist.ctx.dispose();
    }
  });

  test.afterAll(async () => {
    await deleteClinic(adminEmail);
  });

  test('registers a walk-in, opens records without clinical data, and records a payment', async ({ page }) => {
    const login = new LoginPage(page);
    await login.goto();
    await login.login(deskEmail, PASSWORD);
    await expect(page).toHaveURL(/\/dashboard/);

    const nav = new DashboardPage(page);
    await expect(nav.navLink('Patients')).toBeVisible();
    await expect(nav.navLink('Sessions')).toBeVisible();
    await expect(nav.navLink('Tasks')).toHaveCount(0);

    // the overview's schedule is clinic-wide for the desk
    await expect(page.getByText('All Sessions')).toBeVisible();

    // walk-in: contact details only, no clinical fields on the form
    const walkIn = uniq('WalkIn');
    const form = new AddPatientPage(page);
    await form.goto();
    await expect(form.primaryDiagnosis).toHaveCount(0);
    await expect(form.intakeNotes).toHaveCount(0);
    await form.firstName.fill(walkIn);
    await form.lastName.fill('Desk');
    await form.phone.fill('+919800000003');
    await form.submit.click();
    await expect(page).toHaveURL(/\/dashboard\/patients$/);

    // the list has no Diagnosis column; the record has no Clinical Data tab
    await page.getByRole('searchbox', { name: 'Search patients' }).fill(walkIn);
    const row = page.locator('tr', { hasText: walkIn });
    await expect(row).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Diagnosis' })).toHaveCount(0);
    await row.getByRole('link', { name: 'View Details' }).click();
    await expect(page.getByRole('heading', { name: `${walkIn} Desk` })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Overview' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Clinical Data' })).toHaveCount(0);

    // the therapist's session: no risk badge in the list, no notes column, no risk-flag card on the detail
    await nav.navLink('Sessions').click();
    await page.getByRole('searchbox', { name: 'Search sessions' }).fill(patientName);
    const sessionRow = page.locator('tr', { hasText: patientName });
    await expect(sessionRow).toBeVisible();
    await expect(sessionRow.getByTestId('session-risk-badge')).toHaveCount(0);
    await expect(page.getByRole('columnheader', { name: 'Notes' })).toHaveCount(0);

    await sessionRow.getByTestId('session-record-payment').click();
    const dialog = page.getByTestId('record-payment-dialog');
    await dialog.getByTestId('record-payment-amount').fill('700');
    await dialog.getByTestId('record-payment-method').selectOption('upi');
    await dialog.getByTestId('record-payment-save').click();
    await expect(sessionRow.getByTestId('payment-status')).toHaveText(/Paid ₹700/);

    await sessionRow.getByRole('link', { name: 'View Details' }).click();
    await expect(page.getByTestId('session-detail-patient')).toHaveText(`${patientName} Patient`);
    await expect(page.getByTestId('session-outcome-select')).toBeVisible();
    await expect(page.getByTestId('session-risk-flag')).toHaveCount(0);
    await expect(page.getByTestId('session-patient-notes')).toHaveCount(0);
    await expect(page.getByText('Risk observed')).toHaveCount(0);
  });
});
