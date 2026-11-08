import { request as pwRequest, type APIRequestContext } from '@playwright/test';
import { test, expect, requireWeb, requireAuth } from '../src/fixtures';
import { env, uniq } from '../src/env';
import { E2E_CLINIC, deleteClinic } from '../src/clinics';
import { LoginPage } from '../src/pages/login.page';

// Assigning a follow-up card to someone who could not open it (not the patient's clinician, no live
// session with them) asks first: the director sees why and may still assign, or keep the old assignee.
const PASSWORD = 'Password123!';
const PHONE = '+919876543211'; // VERIFICATION_TEST_PHONES: onboarding skips phone.email

test.describe('follow-up card: warn before assigning someone who cannot see it', () => {
  requireWeb();
  requireAuth();
  test.use({ storageState: { cookies: [], origins: [] } });

  const slug = uniq('assignwarn').toLowerCase();
  const email = (who: string) => `${who}.${slug}@example.com`;
  const ids: Record<string, string> = {};
  let director: APIRequestContext;
  let card: string;
  const patientName = `${slug}warn`;

  test.beforeAll(async () => {
    const anon = await pwRequest.newContext({ baseURL: env.API_URL });
    const member = (who: string, role: string) => ({
      email: email(who), first_name: who, last_name: 'Warn', role, phone: PHONE, temporary_password: PASSWORD,
      send_invitation: false, license_number: `LIC-${who}-${slug}`, license_type: 'RCI',
    });
    const onboarded = await anon.post('/api/v1/onboarding/complete', {
      data: {
        organization: {
          name: `${E2E_CLINIC} ${slug}`, type: 'clinic', contact_email: `${slug}@example.com`, contact_phone: PHONE,
          address_line1: '1 MG Road', city: 'Pune', state: 'MH', postal_code: '411001',
        },
        plan: { plan_type: 'basic', max_users: 10, max_patients: 100, max_sessions_per_month: 500 },
        admin: { email: email('director'), password: PASSWORD, first_name: 'Director', last_name: 'Warn', phone: PHONE },
        admin_role: 'ADMIN',
        team_members: [member('therapist', 'THERAPIST'), member('psych', 'PSYCHOLOGIST')],
        timezone: 'Asia/Kolkata',
      },
    });
    expect(onboarded.status(), await onboarded.text()).toBe(200);
    const ctx: Record<string, APIRequestContext> = {};
    for (const who of ['director', 'psych', 'therapist']) {
      const login = await anon.post('/api/v1/auth/login', { data: { email: email(who), password: PASSWORD } });
      expect(login.status(), await login.text()).toBe(200);
      const body = await login.json();
      ids[who] = body.user.id;
      ctx[who] = await pwRequest.newContext({
        baseURL: env.API_URL,
        extraHTTPHeaders: { Authorization: `Bearer ${body.access_token}`, 'X-Tenant-ID': body.tenant.id },
      });
    }
    await anon.dispose();
    director = ctx.director;

    // the psychologist's patient, flagged at the psychologist's session: the therapist can't see the card
    const patient = await director.post('/api/v1/patients/', {
      data: { first_name: patientName, last_name: 'Patient', assigned_therapist_id: ids.psych },
    });
    expect(patient.status(), await patient.text()).toBe(200);
    const patientId = (await patient.json()).id;
    const session = await ctx.psych.post('/api/v1/sessions/', {
      data: { patient_id: patientId, scheduled_at: new Date(Date.now() + 2 * 86_400_000).toISOString(), duration_minutes: 50 },
    });
    expect(session.status(), await session.text()).toBe(200);
    const flag = await director.put(`/api/v1/sessions/${(await session.json()).id}`, { data: { risk_flag: true, risk_level: 'high' } });
    expect(flag.status(), await flag.text()).toBe(200);
    expect((await director.post('/api/v1/kanban/followups/sync')).status()).toBe(200);
    const list = await (await director.get('/api/v1/kanban/followups')).json();
    card = list.items.find((i: { related_patient_id: string }) => i.related_patient_id === patientId).id;
    expect((await director.put(`/api/v1/kanban/tasks/${card}`, { data: { assigned_to_user: ids.psych } })).status()).toBe(200);
    await ctx.psych.dispose();
    await ctx.therapist.dispose();
  });

  test.afterAll(async () => {
    await director.dispose();
    await deleteClinic(email('director'));
  });

  const assignee = async () => (await (await director.get(`/api/v1/kanban/tasks/${card}`)).json()).assigned_to_user;

  test('a clinician who cannot see the card: warning, Cancel keeps the old assignee, Assign anyway saves', async ({ page }) => {
    const login = new LoginPage(page);
    await login.goto();
    await login.login(email('director'), PASSWORD);
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.goto('/dashboard/follow-ups');
    await page.getByRole('button', { name: /Risk flag/ }).click() // the clinic's only card;
    await page.getByRole('button', { name: 'Edit Assignment' }).click();
    const select = page.getByTestId('task-assignee-select');
    const warning = page.getByTestId('assignee-cant-see-warning');

    await select.selectOption(ids.therapist);
    await expect(warning).toBeVisible();
    await expect(warning).toContainText("therapist Warn can't open this card");
    await page.getByTestId('assignee-cant-see-cancel').click();
    await expect(warning).toHaveCount(0);
    await expect(select).toHaveValue(ids.psych);
    expect(await assignee()).toBe(ids.psych);

    await select.selectOption(ids.therapist);
    await expect(warning).toBeVisible();
    const saved = page.waitForResponse((r) => r.url().endsWith(`/api/v1/kanban/tasks/${card}`) && r.request().method() === 'PUT');
    await page.getByTestId('assignee-cant-see-confirm').click();
    expect((await saved).status()).toBe(200);
    await expect(warning).toHaveCount(0);
    expect(await assignee()).toBe(ids.therapist);
  });

  test('someone who can see the card is assigned straight away, with no warning', async ({ page }) => {
    const login = new LoginPage(page);
    await login.goto();
    await login.login(email('director'), PASSWORD);
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.goto('/dashboard/follow-ups');
    await page.getByRole('button', { name: /Risk flag/ }).click() // the clinic's only card;
    await page.getByRole('button', { name: 'Edit Assignment' }).click();
    const saved = page.waitForResponse((r) => r.url().endsWith(`/api/v1/kanban/tasks/${card}`) && r.request().method() === 'PUT');
    await page.getByTestId('task-assignee-select').selectOption(ids.psych);
    expect((await saved).status()).toBe(200);
    await expect(page.getByTestId('assignee-cant-see-warning')).toHaveCount(0);
    expect(await assignee()).toBe(ids.psych);
  });
});
