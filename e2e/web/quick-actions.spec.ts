import { test, expect, requireWeb, requireAuth } from '../src/fixtures';
import { LoginPage } from '../src/pages/login.page';
import { env, DEMO_THERAPIST } from '../src/env';

// Quick Actions filter on user.permissions. The login response used to lack them (only /auth/me,
// called on reload, had them), so the card said "No Quick Actions Available" until a reload.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe('dashboard Quick Actions right after login', () => {
  requireWeb();
  requireAuth();

  test('ADMIN sees all three actions without a reload', async ({ page }) => {
    let loads = 0;
    page.on('load', () => (loads += 1));
    const login = new LoginPage(page);
    await login.goto();
    await login.login(env.EMAIL, env.PASSWORD);
    await expect(page).toHaveURL(/\/dashboard$/);

    const actions = page.getByTestId('quick-actions').getByTestId(/^quick-action-/);
    await expect(actions).toHaveText([/New Patient/, /Schedule Session/, /Settings/]);
    await expect(page.getByText('No Quick Actions Available')).toHaveCount(0);
    // reached by client-side navigation only: one document load (the login page), no reload
    expect(loads).toBe(1);
  });

  test('THERAPIST sees New Patient and Schedule Session but not Settings', async ({ page }) => {
    const login = new LoginPage(page);
    await login.goto();
    await login.login(DEMO_THERAPIST.email, DEMO_THERAPIST.password);
    await expect(page).toHaveURL(/\/dashboard$/);

    const actions = page.getByTestId('quick-actions').getByTestId(/^quick-action-/);
    await expect(actions).toHaveText([/New Patient/, /Schedule Session/]);
    await expect(page.getByTestId('quick-action-settings')).toHaveCount(0);
  });
});
