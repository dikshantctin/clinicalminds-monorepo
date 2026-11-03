import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect, requireWeb, requireAuth } from '../src/fixtures';
import { uniq } from '../src/env';

/**
 * The Follow-ups page replaces the auto "Follow-up queue" kanban board: a paged table, one tab per reason.
 * Each test makes its own patient with a missed session and finds it by searching for the patient's name
 * (the demo clinic's queue holds many more cards than one page).
 */
const HOUR = 3_600_000;

async function missedSessionFor(api: APIRequestContext) {
  const patient = await (await api.post('/api/v1/patients/', { data: { first_name: uniq('Fupage'), last_name: 'Patient' } })).json();
  const res = await api.post('/api/v1/sessions/', {
    data: { patient_id: patient.id, scheduled_at: new Date(Date.now() + 24 * HOUR).toISOString(), duration_minutes: 50 },
  });
  expect(res.status(), await res.text()).toBe(200);
  const session = await res.json();
  const moved = await api.put(`/api/v1/sessions/${session.id}`, { data: { scheduled_at: new Date(Date.now() - 3 * HOUR).toISOString() } });
  expect(moved.status(), await moved.text()).toBe(200);
  expect((await api.post('/api/v1/kanban/followups/sync')).status()).toBe(200);
  return { patient, session };
}

const rowFor = (page: Page, name: string) => page.getByTestId('followup-row').filter({ hasText: name });

test.describe('follow-ups page', () => {
  requireWeb();
  requireAuth();

  let patient: { id: string; first_name: string };
  let session: { id: string };

  test.beforeEach(async ({ api }) => {
    ({ patient, session } = await missedSessionFor(api));
  });

  test.afterEach(async ({ api }) => {
    await api.post(`/api/v1/sessions/${session.id}/cancel`, { data: { reason: 'e2e cleanup' } });
    await api.delete(`/api/v1/patients/${patient.id}`);
  });

  test('the sidebar opens it and a missed session is listed under its tab', async ({ page }) => {
    await page.goto('/dashboard');
    await page.getByTestId('app-sidebar').getByRole('link', { name: 'Follow-ups' }).click();
    await expect(page).toHaveURL(/\/dashboard\/follow-ups$/);
    await expect(page.getByRole('heading', { name: 'Follow-ups' })).toBeVisible();

    await page.getByTestId('followup-tab-missed_session').click();
    await page.getByRole('searchbox').fill(patient.first_name);
    const row = rowFor(page, patient.first_name);
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('Missed session');
    await expect(row.getByRole('link', { name: new RegExp(patient.first_name) })).toHaveAttribute('href', `/dashboard/patients/${patient.id}`);

    await page.getByTestId('followup-tab-risk_flag').click();
    await expect(rowFor(page, patient.first_name)).toHaveCount(0);
  });

  test('assign to me, then done removes it from the open list', async ({ page, api }) => {
    const me = await (await api.get('/api/v1/auth/me')).json();
    // the sync assigns the session's clinician; start from an unassigned card
    const card = (await (await api.get('/api/v1/kanban/followups', { params: { related_session_id: session.id } })).json()).items[0];
    const cleared = await api.put(`/api/v1/kanban/tasks/${card.id}`, { data: { assigned_to_user: null } });
    expect(cleared.status(), await cleared.text()).toBe(200);
    await page.goto('/dashboard/follow-ups');
    await page.getByRole('searchbox').fill(patient.first_name);
    const row = rowFor(page, patient.first_name);
    await expect(row).toHaveCount(1);

    await row.getByTestId('followup-assign-me').click();
    await expect(row).toContainText(`${me.first_name} ${me.last_name}`);
    await expect(row.getByTestId('followup-assign-me')).toHaveCount(0);

    await row.getByTestId('followup-status').selectOption('done');
    await expect(rowFor(page, patient.first_name)).toHaveCount(0);
  });

  test('the Tasks board picker no longer offers the Follow-up queue; the overview tile links here', async ({ page }) => {
    await page.goto('/dashboard/tasks');
    const picker = page.getByRole('combobox', { name: 'Board' });
    await expect(picker).toBeVisible();
    await expect(picker.locator('option', { hasText: 'Follow-up queue' })).toHaveCount(0);

    await page.goto('/dashboard');
    await page.getByTestId('overview-patients_needing_followup').click();
    await expect(page).toHaveURL(/\/dashboard\/follow-ups$/);
  });
});
