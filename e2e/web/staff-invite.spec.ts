import { test, expect, requireWeb, requireApi, requireAuth } from '../src/fixtures';
import { uniq } from '../src/env';
import { deleteClinic, loginAs, onboardClinic } from '../src/clinics';
import { lastEmailTo } from '../src/outbox';
import { LoginPage } from '../src/pages/login.page';

/**
 * Settings → Users & Permissions in the browser, in a clinic of its own: the admin invites a therapist through the
 * dialog, changes the role from the table, sees the note for someone who already works at another clinic; the
 * invitee follows the emailed link to /auth/set-password and logs in; the admin removes them. The API spec
 * (api/staff-invite.spec.ts) covers the edge cases.
 */
const PASSWORD = 'Invited123!';

test.describe('staff invite (browser)', () => {
  requireWeb();
  requireApi();
  requireAuth();

  test('invite dialog → role change → invitee sets a password and logs in → remove', async ({ anon, browser }) => {
    test.setTimeout(90_000);
    const clinic = await onboardClinic(anon);
    const other = await onboardClinic(anon);
    const invitee = `${uniq('staff')}@example.com`.toLowerCase();
    const admin = await loginAs(clinic.owner);
    const adminContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const inviteeContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    try {
      const page = await adminContext.newPage();
      await page.goto('/auth/login');
      await new LoginPage(page).login(clinic.owner, 'Password123!');
      await expect(page).toHaveURL(/\/dashboard$/, { timeout: 15_000 });
      await page.goto('/dashboard/settings');
      await page.getByRole('tab', { name: 'Users & Permissions' }).click();

      // the dialog validates before sending
      await page.getByTestId('invite-staff-open').click();
      const dialog = page.getByTestId('invite-staff-dialog');
      await dialog.getByTestId('invite-staff-submit').click();
      await expect(dialog.getByText('Email is required')).toBeVisible();
      await expect(dialog.getByText('Choose a role')).toBeVisible();

      await dialog.getByTestId('invite-staff-email').fill(invitee);
      await dialog.getByTestId('invite-staff-first-name').fill('Tara');
      await dialog.getByTestId('invite-staff-last-name').fill('Pist');
      await dialog.getByTestId('invite-staff-role').selectOption('THERAPIST');
      await dialog.getByTestId('invite-staff-submit').click();
      await expect(page.getByText(`Invitation sent to ${invitee}`)).toBeVisible();
      await expect(dialog).toBeHidden();

      const listed = await (await admin.ctx.get(`/api/v1/tenants/${admin.tenant.id}/users`)).json();
      const id: string = listed.find((u: { email: string }) => u.email === invitee).id;
      await expect(page.getByTestId(`staff-status-${id}`)).toHaveText('Invited');
      await expect(page.getByTestId(`staff-role-${id}`)).toHaveValue('THERAPIST');

      await page.getByTestId(`staff-role-${id}`).selectOption('PSYCHOLOGIST');
      await expect(page.getByText('Tara Pist is now Psychologist')).toBeVisible();
      const after = await (await admin.ctx.get(`/api/v1/tenants/${admin.tenant.id}/users`)).json();
      expect(after.find((u: { id: string }) => u.id === id).role).toBe('PSYCHOLOGIST');

      // someone who already works at another clinic: added, with a note for the inviter
      await page.getByTestId('invite-staff-open').click();
      await dialog.getByTestId('invite-staff-email').fill(other.owner);
      await dialog.getByTestId('invite-staff-first-name').fill('Other');
      await dialog.getByTestId('invite-staff-last-name').fill('Owner');
      await dialog.getByTestId('invite-staff-role').selectOption('INTERN');
      await dialog.getByTestId('invite-staff-submit').click();
      await expect(dialog.getByTestId('invite-staff-existing-note')).toContainText(
        'This person already uses PsyClinicalMind at another clinic; until clinic switching ships, they will land in their first clinic.',
      );
      await dialog.getByTestId('invite-staff-done').click();
      await expect(dialog).toBeHidden();

      // the invitee follows the emailed link
      const link = lastEmailTo(invitee).html.match(/https?:\/\/[^"'\s<]+\/auth\/set-password\?token=[\w.-]+/);
      expect(link, 'the invite email carries a staff set-password link').not.toBeNull();
      const inviteePage = await inviteeContext.newPage();
      await inviteePage.goto(new URL(link![0]).pathname + new URL(link![0]).search);
      await expect(inviteePage.getByRole('heading', { name: 'Set Your Password' })).toBeVisible();
      await inviteePage.getByTestId('set-password-new').fill(PASSWORD);
      await inviteePage.getByTestId('set-password-submit').click();
      await expect(inviteePage.getByText('Password set. Please log in.')).toBeVisible();
      await expect(inviteePage).toHaveURL(/\/auth\/login$/);
      await new LoginPage(inviteePage).login(invitee, PASSWORD);
      // the link proved the email; the phone is still to be verified
      await expect(inviteePage).toHaveURL(/\/auth\/verify$/, { timeout: 15_000 });
      const stored = await inviteePage.evaluate(() => JSON.parse(localStorage.getItem('auth_user') || '{}'));
      expect(stored.email).toBe(invitee);
      expect(stored.role).toBe('PSYCHOLOGIST');

      await page.reload();
      await page.getByRole('tab', { name: 'Users & Permissions' }).click();
      await expect(page.getByTestId(`staff-status-${id}`)).toHaveText('Active');
      // the admin cannot change or remove themselves from the table
      await expect(page.getByTestId(`remove-staff-${admin.user.id}`)).toHaveCount(0);
      await expect(page.getByTestId(`staff-role-${admin.user.id}`)).toHaveCount(0);

      await page.getByTestId(`remove-staff-${id}`).click();
      await page.getByTestId('remove-staff-dialog-confirm').click();
      await expect(page.getByText('Tara Pist was removed from the clinic')).toBeVisible();
      await expect(page.getByTestId(`staff-status-${id}`)).toHaveCount(0);
      const refused = await anon.post('/api/v1/auth/login', { data: { email: invitee, password: PASSWORD } });
      expect(refused.status()).toBe(403);
    } finally {
      await adminContext.close();
      await inviteeContext.close();
      await admin.ctx.dispose();
      await deleteClinic(clinic.owner);
      await deleteClinic(other.owner);
    }
  });

  test('a CLINICAL_DIRECTOR sees Users & Permissions; a THERAPIST does not', async ({ anon, browser }) => {
    const therapist = `${uniq('ther')}@example.com`.toLowerCase();
    const clinic = await onboardClinic(anon, { ownerRole: 'CLINICAL_DIRECTOR', team: [{ email: therapist, role: 'THERAPIST' }] });
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    try {
      const page = await context.newPage();
      for (const [email, visible] of [[clinic.owner, 1], [therapist, 0]] as const) {
        await page.goto('/auth/login');
        await new LoginPage(page).login(email, 'Password123!');
        await expect(page).toHaveURL(/\/dashboard$/, { timeout: 15_000 });
        await page.goto('/dashboard/settings');
        await expect(page.getByRole('tab', { name: 'Profile' })).toBeVisible();
        await expect(page.getByRole('tab', { name: 'Users & Permissions' })).toHaveCount(visible);
        await page.evaluate(() => localStorage.clear());
      }
    } finally {
      await context.close();
      await deleteClinic(clinic.owner);
    }
  });
});
