import { test, expect, requireWeb, requireAuth } from '../src/fixtures';
import { OwnClinic, OwnMember, deleteClinic, onboardOwnClinic } from '../src/clinics';

/** Capacity slice e in the UI: the therapist's bell lists the reminder for a session in 12 minutes and
 * opens that session. Needs the follow-up worker (celery -B), as in CI. */
const WORKER_BUDGET_MS = 100_000;

test.describe('session reminder (browser)', () => {
  requireWeb();
  requireAuth();

  let clinic: OwnClinic;
  let therapist: OwnMember;
  test.beforeAll(async () => {
    clinic = await onboardOwnClinic('remindui', ['THERAPIST']);
    therapist = clinic.members[0];
  });
  test.afterAll(async () => {
    await therapist?.api.dispose();
    await clinic?.api.dispose();
    if (clinic) await deleteClinic(clinic.adminEmail);
  });

  test('the bell shows the reminder and opens the session', async ({ browser }) => {
    test.setTimeout(WORKER_BUDGET_MS + 60_000);
    const patient = await (
      await clinic.api.post('/api/v1/patients/', { data: { first_name: 'Bell', last_name: 'Patient', assigned_therapist_id: therapist.user.id } })
    ).json();
    const booked = await clinic.api.post('/api/v1/sessions/', {
      data: { patient_id: patient.id, therapist_id: therapist.user.id, scheduled_at: new Date(Date.now() + 12 * 60_000).toISOString() },
    });
    expect(booked.status(), await booked.text()).toBe(200);
    const sessionId = (await booked.json()).id;
    await expect
      .poll(async () => ((await (await therapist.api.get('/api/v1/kanban/notifications')).json()) as { session_id: string | null }[]).some((n) => n.session_id === sessionId), {
        timeout: WORKER_BUDGET_MS,
        intervals: [2_000],
      })
      .toBe(true);

    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    try {
      await context.addInitScript(
        ([t, u, id]) => {
          localStorage.setItem('auth_token', t);
          localStorage.setItem('auth_user', u);
          localStorage.setItem('tenant_id', id);
        },
        [therapist.token, JSON.stringify(therapist.user), clinic.tenantId],
      );
      const page = await context.newPage();
      await page.goto('/dashboard');
      await page.getByTestId('notification-bell').click();
      const item = page.getByTestId('notification-panel').getByRole('button', { name: /Session at/ });
      await expect(item).toContainText('With Bell');
      await item.click();
      await expect(page).toHaveURL(new RegExp(`/dashboard/sessions/${sessionId}$`));
    } finally {
      await context.close();
    }
  });
});
