import { test, expect, requireWeb, requireAuth } from '../src/fixtures';
import { uniq } from '../src/env';
import { lastEmailTo } from '../src/outbox';
import { LoginPage } from '../src/pages/login.page';

/**
 * The whole patient invite journey in the browser: the clinic invites, the patient follows the link from the
 * email, sets a password on /portal/set-password, then signs in on /portal/login. The email link proves the
 * email, so the next stop is the phone check on /auth/verify (the phone.email widget cannot be driven headlessly).
 * This is the path a real patient takes; the API spec (api/patient-portal.spec.ts) covers the edge cases.
 */
const PASSWORD = 'Password123!';

test.describe('patient portal invite (browser)', () => {
  requireWeb();
  requireAuth();

  test('invite email link → set password → portal login as PATIENT → phone check', async ({ api, browser }) => {
    const created = await api.post('/api/v1/patients/', { data: { first_name: uniq('Invitee'), last_name: 'Patient' } });
    expect(created.status(), await created.text()).toBe(200);
    const patientId: string = (await created.json()).id;
    const email = `${uniq('invitee')}@example.com`.toLowerCase();

    // a fresh, logged-out browser: the patient has never used the app
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    try {
      const inv = await api.post(`/api/v1/patients/${patientId}/invite`, { data: { email, first_name: 'Invitee', last_name: 'Patient' } });
      expect(inv.status(), await inv.text()).toBe(200);

      const link = lastEmailTo(email).html.match(/https?:\/\/[^"'\s<]+\/portal\/set-password\?token=[\w.-]+/);
      expect(link, 'the invite email carries a set-password link').not.toBeNull();
      await page.goto(new URL(link![0]).pathname + new URL(link![0]).search);

      await expect(page.getByRole('heading', { name: 'Set Your Password' })).toBeVisible();
      await page.locator('input[type="password"]').first().fill(PASSWORD);
      await page.locator('button[type="submit"]').click();
      await expect(page.getByText('Password set. Please log in.')).toBeVisible();
      await expect(page).toHaveURL(/\/portal\/login$/);
      // set-password must not sign the patient in by itself
      expect(await page.evaluate(() => localStorage.getItem('auth_token'))).toBeNull();

      const login = new LoginPage(page, '/portal/login');
      await login.email.fill(email);
      await login.password.fill(PASSWORD);
      await login.submit.click();
      // signed in as the patient; the verification gate still asks for the phone (set-password no longer skips it)
      await expect(page).toHaveURL(/\/auth\/verify$/);
      const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('auth_user') || '{}'));
      expect(stored.email).toBe(email);
      expect(stored.role).toBe('PATIENT');
      expect(stored.emailVerified).toBe(true);
      expect(stored.phoneVerified).toBe(false);
    } finally {
      await context.close();
      await api.delete(`/api/v1/patients/${patientId}`);
    }
  });
});
