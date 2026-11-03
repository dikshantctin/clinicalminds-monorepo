import { test, expect, requireWeb, requireAuth } from '../src/fixtures';
import { uniq } from '../src/env';
import { bookSession } from '../src/sessions';

/** Session outcome on the session page and the sessions list (capacity MVP §3). */
test.describe('session outcome UI', () => {
  requireWeb();
  requireAuth();

  test('an unconfirmed session shows "Needs confirmation" in the list and on its page; tagging it attended completes it', async ({ page, api }) => {
    const first = uniq('Unconfirmed');
    const patient = await (await api.post('/api/v1/patients/', { data: { first_name: first, last_name: 'Patient' } })).json();
    try {
      const session = await (
        await bookSession(api, { patient_id: patient.id, scheduled_at: new Date(Date.now() + 86_400_000).toISOString() })
      ).json();
      const moved = await api.put(`/api/v1/sessions/${session.id}`, { data: { scheduled_at: new Date(Date.now() - 26 * 3_600_000).toISOString() } });
      expect(moved.status()).toBe(200);
      expect((await api.post('/api/v1/kanban/followups/sync')).status()).toBe(200); // runs the 24 h sweep

      await page.goto('/dashboard/sessions');
      await page.getByRole('searchbox', { name: 'Search sessions' }).fill(first);
      await expect(page.locator('tr', { hasText: first }).getByTestId('needs-confirmation')).toHaveText('Needs confirmation');

      await page.goto(`/dashboard/sessions/${session.id}`);
      await expect(page.getByTestId('session-outcome-current')).toHaveText('Needs confirmation');
      const select = page.getByTestId('session-outcome-select');
      // the sweep's own tag is never offered by hand
      await expect(select.locator('option', { hasText: 'Needs confirmation' })).toHaveCount(0);
      await expect(page.getByTestId('session-outcome-save')).toBeDisabled(); // nothing picked yet
      await select.selectOption('attended');
      await page.getByTestId('session-outcome-reason').fill('seen at the desk');
      await page.getByTestId('session-outcome-save').click();

      await expect(page.getByTestId('session-outcome-current')).toHaveText('Attended');
      const after = await (await api.get(`/api/v1/sessions/${session.id}`)).json();
      expect(after).toEqual(expect.objectContaining({ outcome: 'attended', status: 'completed' }));
      expect(after.session_notes).toContain('Outcome: Attended (seen at the desk)');
    } finally {
      await api.delete(`/api/v1/patients/${patient.id}`);
    }
  });

  test('a session with no outcome yet shows "Not marked"', async ({ page, api }) => {
    const patient = await (await api.post('/api/v1/patients/', { data: { first_name: uniq('Untagged'), last_name: 'Patient' } })).json();
    try {
      const session = await (
        await bookSession(api, { patient_id: patient.id, scheduled_at: new Date(Date.now() + 2 * 86_400_000).toISOString() })
      ).json();
      await page.goto(`/dashboard/sessions/${session.id}`);
      await expect(page.getByTestId('session-outcome-current')).toHaveText('Not marked');
    } finally {
      await api.delete(`/api/v1/patients/${patient.id}`);
    }
  });
});
