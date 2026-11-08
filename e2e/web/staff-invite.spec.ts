import { test, expect, requireWeb, requireApi, requireAuth } from '../src/fixtures';
import { uniq } from '../src/env';
import { deleteClinic, loginAs, onboardClinic } from '../src/clinics';
import { emailsTo, lastEmailTo } from '../src/outbox';
import { LoginPage } from '../src/pages/login.page';

/**
 * Settings → Users & Permissions in the browser, in a clinic of its own: the admin invites a therapist through the
 * dialog, changes the role from the table, adds someone who already works at another clinic (same answer); the
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

      // an invited row offers a resend (a new link by email); an active one does not
      const sent = emailsTo(invitee);
      await page.getByTestId(`resend-staff-${id}`).click();
      await expect(page.getByText(`Invitation sent again to ${invitee}`)).toBeVisible();
      expect(emailsTo(invitee)).toBe(sent + 1);
      await expect(page.getByTestId(`resend-staff-${admin.user.id}`)).toHaveCount(0);

      await page.getByTestId(`staff-role-${id}`).selectOption('PSYCHOLOGIST');
      await page.getByTestId('staff-role-dialog-confirm').click();
      await expect(page.getByText('Tara Pist is now Psychologist')).toBeVisible();
      const after = await (await admin.ctx.get(`/api/v1/tenants/${admin.tenant.id}/users`)).json();
      expect(after.find((u: { id: string }) => u.id === id).role).toBe('PSYCHOLOGIST');

      // someone who already works at another clinic: the inviter sees the same answer as for a new address
      await page.getByTestId('invite-staff-open').click();
      await dialog.getByTestId('invite-staff-email').fill(other.owner);
      await dialog.getByTestId('invite-staff-first-name').fill('Other');
      await dialog.getByTestId('invite-staff-last-name').fill('Owner');
      await dialog.getByTestId('invite-staff-role').selectOption('INTERN');
      await dialog.getByTestId('invite-staff-submit').click();
      await expect(page.getByText(`Invitation sent to ${other.owner}`)).toBeVisible();
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

  test('a role change waits for the confirm: cancel sends nothing, confirm changes it', async ({ anon, browser }) => {
    const therapist = `${uniq('ther')}@example.com`.toLowerCase();
    const clinic = await onboardClinic(anon, { team: [{ email: therapist, role: 'THERAPIST' }] });
    const admin = await loginAs(clinic.owner);
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const roleOf = async (id: string) =>
      (await (await admin.ctx.get(`/api/v1/tenants/${admin.tenant.id}/users`)).json()).find((u: { id: string }) => u.id === id).role;
    try {
      const listed = await (await admin.ctx.get(`/api/v1/tenants/${admin.tenant.id}/users`)).json();
      const id: string = listed.find((u: { email: string }) => u.email === therapist).id;
      const page = await context.newPage();
      const roleWrites: string[] = [];
      page.on('request', (r) => {
        if (r.method() === 'PUT' && r.url().endsWith(`/users/${id}/role`)) roleWrites.push(r.url());
      });
      await page.goto('/auth/login');
      await new LoginPage(page).login(clinic.owner, 'Password123!');
      await expect(page).toHaveURL(/\/dashboard$/, { timeout: 15_000 });
      await page.goto('/dashboard/settings');
      await page.getByRole('tab', { name: 'Users & Permissions' }).click();
      const select = page.getByTestId(`staff-role-${id}`);
      await expect(select).toHaveValue('THERAPIST');

      // (a) changing the select only stages it; cancelling restores the old value and sends nothing
      await select.selectOption('INTERN');
      const dialog = page.getByTestId('staff-role-dialog');
      await expect(dialog).toContainText('Change Team THERAPIST from Therapist to Intern?');
      await page.getByTestId('staff-role-dialog-cancel').click();
      await expect(dialog).toBeHidden();
      await expect(select).toHaveValue('THERAPIST');
      expect(roleWrites).toEqual([]);
      expect(await roleOf(id)).toBe('THERAPIST');

      // (b) confirming sends exactly one change
      await select.selectOption('PSYCHOLOGIST');
      await page.getByTestId('staff-role-dialog-confirm').click();
      await expect(page.getByText('Team THERAPIST is now Psychologist')).toBeVisible();
      await expect(dialog).toBeHidden();
      await expect(select).toHaveValue('PSYCHOLOGIST');
      expect(roleWrites).toHaveLength(1);
      expect(await roleOf(id)).toBe('PSYCHOLOGIST');
    } finally {
      await context.close();
      await admin.ctx.dispose();
      await deleteClinic(clinic.owner);
    }
  });

  test('a CLINICAL_DIRECTOR is offered no ADMIN role and cannot edit or remove an ADMIN', async ({ anon, browser }) => {
    const adminEmail = `${uniq('adm')}@example.com`.toLowerCase();
    const therapist = `${uniq('ther')}@example.com`.toLowerCase();
    const clinic = await onboardClinic(anon, {
      ownerRole: 'CLINICAL_DIRECTOR',
      team: [{ email: adminEmail, role: 'ADMIN' }, { email: therapist, role: 'THERAPIST' }],
    });
    const director = await loginAs(clinic.owner);
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    try {
      const listed = await (await director.ctx.get(`/api/v1/tenants/${director.tenant.id}/users`)).json();
      const idOf = (email: string): string => listed.find((u: { email: string }) => u.email === email).id;
      const adminId = idOf(adminEmail);
      const therapistId = idOf(therapist);
      const page = await context.newPage();
      await page.goto('/auth/login');
      await new LoginPage(page).login(clinic.owner, 'Password123!');
      await expect(page).toHaveURL(/\/dashboard$/, { timeout: 15_000 });
      await page.goto('/dashboard/settings');
      await page.getByRole('tab', { name: 'Users & Permissions' }).click();

      // the ADMIN row: role as text, no select, no Remove
      await expect(page.getByTestId(`staff-role-text-${adminId}`)).toHaveText('Admin');
      await expect(page.getByTestId(`staff-role-${adminId}`)).toHaveCount(0);
      await expect(page.getByTestId(`remove-staff-${adminId}`)).toHaveCount(0);

      // the THERAPIST row stays editable, without ADMIN among its options
      const select = page.getByTestId(`staff-role-${therapistId}`);
      await expect(select).toHaveValue('THERAPIST');
      await expect(select.locator('option[value="ADMIN"]')).toHaveCount(0);
      await expect(select.locator('option[value="CLINICAL_DIRECTOR"]')).toHaveCount(1);
      await expect(page.getByTestId(`remove-staff-${therapistId}`)).toBeVisible();

      // the invite dialog offers no ADMIN either
      await page.getByTestId('invite-staff-open').click();
      const role = page.getByTestId('invite-staff-dialog').getByTestId('invite-staff-role');
      await expect(role.locator('option[value="ADMIN"]')).toHaveCount(0);
      await expect(role.locator('option[value="CLINICAL_DIRECTOR"]')).toHaveCount(1);
    } finally {
      await context.close();
      await director.ctx.dispose();
      await deleteClinic(clinic.owner);
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

  test("a demoted admin's open page shows the server's refusal", async ({ anon, browser }) => {
    const admin2Email = `${uniq('adm2')}@example.com`.toLowerCase();
    const clinic = await onboardClinic(anon, { team: [{ email: admin2Email, role: 'ADMIN' }] });
    const admin = await loginAs(clinic.owner);
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const roleOf = async (id: string) =>
      (await (await admin.ctx.get(`/api/v1/tenants/${admin.tenant.id}/users`)).json()).find((u: { id: string }) => u.id === id).role;
    try {
      const listed = await (await admin.ctx.get(`/api/v1/tenants/${admin.tenant.id}/users`)).json();
      const admin2Id: string = listed.find((u: { email: string }) => u.email === admin2Email).id;
      expect(await roleOf(admin2Id)).toBe('ADMIN');

      // admin2 opens Users & Permissions while still an ADMIN
      const page = await context.newPage();
      await page.goto('/auth/login');
      await new LoginPage(page).login(admin2Email, 'Password123!');
      await expect(page).toHaveURL(/\/dashboard$/, { timeout: 15_000 });
      await page.goto('/dashboard/settings');
      await page.getByRole('tab', { name: 'Users & Permissions' }).click();
      const ownerRole = page.getByTestId(`staff-role-${admin.user.id}`);
      await expect(ownerRole).toHaveValue('ADMIN');

      // the first admin demotes admin2; the open page still shows Admin controls (the cached role)
      const demoted = await admin.ctx.put(`/api/v1/tenants/${admin.tenant.id}/users/${admin2Id}/role`, {
        data: { role: 'CLINICAL_DIRECTOR' },
      });
      expect(demoted.status(), await demoted.text()).toBe(200);
      expect(await roleOf(admin2Id)).toBe('CLINICAL_DIRECTOR');
      await expect(ownerRole).toBeVisible();
      await expect(ownerRole.locator('option[value="ADMIN"]')).toHaveCount(1);

      // admin2 tries to change the first admin's role: the server refuses and the page says why
      await ownerRole.selectOption('THERAPIST');
      await page.getByTestId('staff-role-dialog-confirm').click();
      await expect(
        page.getByRole('status').filter({ hasText: 'Only an admin can grant, change or remove the admin role' }),
      ).toHaveText('Only an admin can grant, change or remove the admin role');
      expect(await roleOf(admin.user.id)).toBe('ADMIN');
    } finally {
      await context.close();
      await admin.ctx.dispose();
      await deleteClinic(clinic.owner);
    }
  });
});
