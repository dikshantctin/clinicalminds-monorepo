import { request as pwRequest } from '@playwright/test';
import { test, expect, requireWeb, requireAuth } from '../src/fixtures';
import { env, uniq } from '../src/env';
import { E2E_CLINIC, deleteClinic } from '../src/clinics';
import { LoginPage } from '../src/pages/login.page';
import { DashboardPage, NAV } from '../src/pages/dashboard.page';

// The front desk (SUPPORT_STAFF) has no task boards: no bell (it polls /kanban/notifications), no Tasks
// link, and the follow-up tile is a number, not a link to the boards.
const PASSWORD = 'Password123!';
const ALLOW_LISTED_PHONE = '+919876543211'; // VERIFICATION_TEST_PHONES: onboarding skips phone.email, logins count as verified

test.describe('front desk (SUPPORT_STAFF): no task boards in the browser', () => {
  requireWeb();
  requireAuth();

  const slug = uniq('desknkweb').toLowerCase();
  const adminEmail = `admin.${slug}@example.com`;
  const deskEmail = `desk.${slug}@example.com`;

  test.beforeAll(async () => {
    const anon = await pwRequest.newContext({ baseURL: env.API_URL });
    const onboarded = await anon.post('/api/v1/onboarding/complete', {
      data: {
        organization: {
          name: `${E2E_CLINIC} ${slug}`, type: 'clinic', contact_email: `${slug}@example.com`, contact_phone: ALLOW_LISTED_PHONE,
          address_line1: '1 Road', city: 'Pune', state: 'MH', postal_code: '411001',
        },
        plan: { plan_type: 'basic', max_users: 5, max_patients: 100, max_sessions_per_month: 500 },
        admin: { email: adminEmail, password: PASSWORD, first_name: 'Desk', last_name: 'Admin', phone: ALLOW_LISTED_PHONE },
        admin_role: 'ADMIN',
        team_members: [{
          email: deskEmail, first_name: 'desk', last_name: 'Staff', role: 'SUPPORT_STAFF', phone: ALLOW_LISTED_PHONE,
          temporary_password: PASSWORD, send_invitation: false,
        }],
      },
    });
    expect(onboarded.status(), await onboarded.text()).toBe(200);
    await anon.dispose();
  });

  test.afterAll(async () => {
    await deleteClinic(adminEmail);
  });

  test.describe('desk', () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test('no bell, no Tasks link, follow-up tile is not a link, and /kanban is never called', async ({ page }) => {
      const kanbanCalls: string[] = [];
      page.on('request', (req) => {
        if (req.url().includes('/api/v1/kanban/')) kanbanCalls.push(req.url());
      });
      const login = new LoginPage(page);
      await login.goto();
      await login.login(deskEmail, PASSWORD);
      await expect(page).toHaveURL(/\/dashboard$/);

      const tile = page.getByTestId('overview-patients_needing_followup');
      await expect(tile.getByTestId('stat-tile-value')).toHaveText(/^\d+$/);
      await expect(tile).not.toHaveAttribute('href', /.*/);
      await expect(page.getByTestId('clinic-overview').locator(`a[href="${NAV.Tasks}"]`)).toHaveCount(0);

      await expect(page.getByTestId('user-menu')).toBeVisible(); // the header has rendered
      await expect(page.getByTestId('notification-bell')).toHaveCount(0);
      await expect(page.getByTestId('app-sidebar').getByRole('link', { name: 'Overview' })).toBeVisible();
      await expect(page.locator(`a[href="${NAV.Tasks}"]`)).toHaveCount(0);

      // the Tasks route stays guarded for a typed-in URL: RoleGuard sends the desk back to the overview
      await page.goto(NAV.Tasks);
      await expect(page).toHaveURL(/\/dashboard$/);
      await expect(new DashboardPage(page).heading(/Welcome back,/)).toBeVisible();
      expect(kanbanCalls).toEqual([]);
    });
  });

  test('admin still sees the bell and a follow-up tile that opens the follow-up queue', async ({ page }) => {
    await page.goto(NAV.Overview);
    await expect(page.getByTestId('notification-bell')).toBeVisible();
    await expect(page.getByTestId('overview-patients_needing_followup')).toHaveAttribute('href', '/dashboard/follow-ups');
    await expect(page.getByTestId('app-sidebar').locator(`a[href="${NAV.Tasks}"]`)).toBeVisible();
  });
});
