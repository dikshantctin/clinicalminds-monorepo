import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { uniq, RANDOM_UUID } from '../src/env';
import { deleteClinic, inviteStaff, loginAs, onboardClinic, CLINIC_PASSWORD } from '../src/clinics';
import { inviteTokenFor, lastEmailTo } from '../src/outbox';
import { staffInviteToken } from '../src/invite-token';

/**
 * Staff after onboarding (Settings → Users & Permissions): ADMIN / CLINICAL_DIRECTOR invite staff, change roles
 * and remove people; only an ADMIN grants, changes or removes ADMIN. Every write reaches the platform mapping
 * login reads AND the tenant-data association the routers read. Each test onboards its own clinic and deletes it.
 */
type StaffRow = { id: string; email: string; role: string; status: 'pending' | 'active' };

const NEW_PASSWORD = 'Invited123!';
const email = (tag: string) => `${uniq(tag)}@example.com`.toLowerCase();
const users = async (ctx: import('@playwright/test').APIRequestContext, tenantId: string): Promise<StaffRow[]> => {
  const res = await ctx.get(`/api/v1/tenants/${tenantId}/users`);
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
};
const message = async (res: import('@playwright/test').APIResponse) => (await res.json()).message;

test.describe('staff invite, role change, removal', () => {
  requireApi();
  requireAuth();

  test('ADMIN invites a THERAPIST: email link → password → login; duplicates, bad roles, re-role, removal', async ({ anon }) => {
    const { owner } = await onboardClinic(anon);
    const admin = await loginAs(owner);
    const tenantId = admin.tenant.id;
    const invitee = email('therapist');
    try {
      const res = await inviteStaff(admin.ctx, tenantId, { email: invitee.toUpperCase(), role: 'THERAPIST', first_name: 'Tara', last_name: 'Pist' });
      expect(res.status(), await res.text()).toBe(200);
      expect(await res.json()).toEqual({ message: 'Invitation sent', email: invitee });
      expect(lastEmailTo(invitee).html).toContain('/auth/set-password?token=');
      const token = inviteTokenFor(invitee);

      // no password yet: a login attempt is a plain 401, not a server error
      const early = await anon.post('/api/v1/auth/login', { data: { email: invitee, password: NEW_PASSWORD } });
      expect(early.status(), await early.text()).toBe(401);
      let row = (await users(admin.ctx, tenantId)).find((u) => u.email === invitee);
      expect(row).toEqual(expect.objectContaining({ role: 'THERAPIST', status: 'pending' }));

      const set = await anon.post('/api/v1/auth/set-password', { data: { token, password: NEW_PASSWORD } });
      expect(set.status(), await set.text()).toBe(200);
      const reuse = await anon.post('/api/v1/auth/set-password', { data: { token, password: 'Another123!' } });
      expect(reuse.status()).toBe(400);
      expect(await message(reuse)).toBe('Account already has a password');

      const therapist = await loginAs(invitee, NEW_PASSWORD);
      try {
        expect(therapist.user.role).toBe('THERAPIST');
        expect(therapist.tenant.id).toBe(tenantId);
        // the link proved the email; the phone is still unproven, so clinical routes wait for /auth/verify
        expect(therapist.user.email_verified).toBe(true);
        expect(therapist.user.phone_verified).toBe(false);
        const gated = await therapist.ctx.get('/api/v1/patients/');
        expect(gated.status()).toBe(403);
        expect(await gated.json()).toEqual({ detail: 'verification_required' });
      } finally {
        await therapist.ctx.dispose();
      }
      row = (await users(admin.ctx, tenantId)).find((u) => u.email === invitee);
      expect(row).toEqual(expect.objectContaining({ role: 'THERAPIST', status: 'active' }));
      const id = row!.id;

      // already active here → 409, whatever the case of the address
      const dup = await inviteStaff(admin.ctx, tenantId, { email: invitee.toUpperCase(), role: 'INTERN' });
      expect(dup.status()).toBe(409);
      expect(await message(dup)).toBe('This person is already a member of this clinic');
      // staff roles only, UPPER_CASE
      for (const role of ['PATIENT', 'wizard', 'therapist']) {
        const bad = await inviteStaff(admin.ctx, tenantId, { email: email('bad'), role });
        expect(bad.status(), `role ${role}`).toBe(422);
      }

      // role change reaches the login
      const put = await admin.ctx.put(`/api/v1/tenants/${tenantId}/users/${id}/role`, { data: { role: 'PSYCHOLOGIST' } });
      expect(put.status(), await put.text()).toBe(200);
      const relogin = await loginAs(invitee, NEW_PASSWORD);
      expect(relogin.user.role).toBe('PSYCHOLOGIST');
      await relogin.ctx.dispose();
      expect((await users(admin.ctx, tenantId)).find((u) => u.id === id)?.role).toBe('PSYCHOLOGIST');
      expect((await admin.ctx.put(`/api/v1/tenants/${tenantId}/users/${id}/role`, { data: { role: 'PATIENT' } })).status()).toBe(422);
      const stranger = await admin.ctx.put(`/api/v1/tenants/${tenantId}/users/${RANDOM_UUID}/role`, { data: { role: 'INTERN' } });
      expect(stranger.status()).toBe(404);
      expect(await message(stranger)).toBe('Not a member of this clinic');
      const own = await admin.ctx.put(`/api/v1/tenants/${tenantId}/users/${admin.user.id}/role`, { data: { role: 'THERAPIST' } });
      expect(own.status()).toBe(400);
      expect(await message(own)).toBe('You cannot change your own role');

      // removal ends staff access
      const del = await admin.ctx.delete(`/api/v1/tenants/${tenantId}/users/${id}`);
      expect(del.status(), await del.text()).toBe(200);
      const after = await anon.post('/api/v1/auth/login', { data: { email: invitee, password: NEW_PASSWORD } });
      expect(after.status()).toBe(403);
      expect(await message(after)).toBe('No staff access for this account');
      expect((await users(admin.ctx, tenantId)).map((u) => u.id)).not.toContain(id);
      expect((await admin.ctx.delete(`/api/v1/tenants/${tenantId}/users/${id}`)).status()).toBe(404);
      const self = await admin.ctx.delete(`/api/v1/tenants/${tenantId}/users/${admin.user.id}`);
      expect(self.status()).toBe(400);
      expect(await message(self)).toBe('You cannot remove yourself from the clinic');

      // a removed person can be invited back: same account, new role, password kept
      const back = await inviteStaff(admin.ctx, tenantId, { email: invitee, role: 'INTERN' });
      expect(back.status(), await back.text()).toBe(200);
      expect(await back.json()).toEqual({ message: 'Invitation sent', email: invitee }); // same shape for an existing account
      const returned = await loginAs(invitee, NEW_PASSWORD);
      expect(returned.user.role).toBe('INTERN');
      await returned.ctx.dispose();
    } finally {
      await admin.ctx.dispose();
      await deleteClinic(owner);
    }
  });

  test('only ADMIN / CLINICAL_DIRECTOR of this clinic manage staff: no token 401, THERAPIST 403, foreign clinic 403', async ({ anon, api }) => {
    const therapistEmail = email('member');
    const { owner } = await onboardClinic(anon, { team: [{ email: therapistEmail, role: 'THERAPIST' }] });
    const therapist = await loginAs(therapistEmail);
    const tenantId = therapist.tenant.id;
    try {
      const target = { email: email('nope'), role: 'INTERN' };
      const paths = {
        invite: `/api/v1/tenants/${tenantId}/invite`,
        role: `/api/v1/tenants/${tenantId}/users/${therapist.user.id}/role`,
        remove: `/api/v1/tenants/${tenantId}/users/${therapist.user.id}`,
      };
      for (const ctx of [anon, therapist.ctx, api]) {
        const expected = ctx === anon ? 401 : 403; // api = the demo clinic's ADMIN: not a member of this clinic
        expect((await ctx.post(paths.invite, { data: { ...target, first_name: 'N', last_name: 'O' } })).status()).toBe(expected);
        expect((await ctx.put(paths.role, { data: { role: 'INTERN' } })).status()).toBe(expected);
        expect((await ctx.delete(paths.remove)).status()).toBe(expected);
        expect((await ctx.get(`/api/v1/tenants/${tenantId}/users`)).status()).toBe(expected);
      }
      // nothing was written
      const admin = await loginAs(owner);
      try {
        const rows = await users(admin.ctx, tenantId);
        expect(rows.map((u) => u.email)).not.toContain(target.email);
        expect(rows.find((u) => u.id === therapist.user.id)?.role).toBe('THERAPIST');
      } finally {
        await admin.ctx.dispose();
      }
    } finally {
      await therapist.ctx.dispose();
      await deleteClinic(owner);
    }
  });

  test('a CLINICAL_DIRECTOR manages roles up to CLINICAL_DIRECTOR; only an ADMIN grants, changes or removes ADMIN', async ({ anon }) => {
    const adminEmail = email('admin');
    const therapistEmail = email('ther');
    const { owner } = await onboardClinic(anon, {
      ownerRole: 'CLINICAL_DIRECTOR',
      team: [{ email: adminEmail, role: 'ADMIN' }, { email: therapistEmail, role: 'THERAPIST' }],
    });
    const director = await loginAs(owner);
    const tenantId = director.tenant.id;
    const ADMIN_ONLY = 'Only an admin can grant, change or remove the admin role';
    const user = (id: string) => `/api/v1/tenants/${tenantId}/users/${id}`;
    const newAdmin = email('admin2');
    try {
      expect(director.user.permissions).toEqual(expect.arrayContaining(['create_users', 'edit_users', 'delete_users']));
      const before = await users(director.ctx, tenantId);
      const admin = before.find((u) => u.email === adminEmail)!;
      const therapist = before.find((u) => u.email === therapistEmail)!;

      // a CD can neither grant ADMIN nor change or remove an ADMIN
      const invite = await inviteStaff(director.ctx, tenantId, { email: newAdmin, role: 'ADMIN' });
      expect(invite.status(), await invite.text()).toBe(403);
      expect(await message(invite)).toBe(ADMIN_ONLY);
      const promote = await director.ctx.put(`${user(therapist.id)}/role`, { data: { role: 'ADMIN' } });
      expect(promote.status(), await promote.text()).toBe(403);
      expect(await message(promote)).toBe(ADMIN_ONLY);
      const demote = await director.ctx.put(`${user(admin.id)}/role`, { data: { role: 'THERAPIST' } });
      expect(demote.status(), await demote.text()).toBe(403);
      expect(await message(demote)).toBe(ADMIN_ONLY);
      const sideways = await director.ctx.put(`${user(admin.id)}/role`, { data: { role: 'CLINICAL_DIRECTOR' } });
      expect(sideways.status(), await sideways.text()).toBe(403);
      expect(await message(sideways)).toBe(ADMIN_ONLY);
      const remove = await director.ctx.delete(user(admin.id));
      expect(remove.status(), await remove.text()).toBe(403);
      expect(await message(remove)).toBe(ADMIN_ONLY);
      expect(await users(director.ctx, tenantId)).toEqual(before); // nothing was written

      // a CD still invites, changes and removes everyone below ADMIN
      const second = email('ther2');
      const invited = await inviteStaff(director.ctx, tenantId, { email: second, role: 'THERAPIST' });
      expect(invited.status(), await invited.text()).toBe(200);
      expect(await invited.json()).toEqual({ message: 'Invitation sent', email: second });
      expect((await director.ctx.put(`${user(therapist.id)}/role`, { data: { role: 'CLINICAL_DIRECTOR' } })).status()).toBe(200);
      expect((await director.ctx.put(`${user(therapist.id)}/role`, { data: { role: 'INTERN' } })).status()).toBe(200);
      expect((await director.ctx.delete(user(therapist.id))).status()).toBe(200);
    } finally {
      await director.ctx.dispose();
    }

    // an ADMIN may do all of it
    const adminSession = await loginAs(adminEmail);
    try {
      const invite = await inviteStaff(adminSession.ctx, tenantId, { email: newAdmin, role: 'ADMIN' });
      expect(invite.status(), await invite.text()).toBe(200);
      const pending = (await users(adminSession.ctx, tenantId)).find((u) => u.email === newAdmin)!;
      expect(pending).toEqual(expect.objectContaining({ role: 'ADMIN', status: 'pending' }));
      const promote = await adminSession.ctx.put(`${user(director.user.id)}/role`, { data: { role: 'ADMIN' } });
      expect(promote.status(), await promote.text()).toBe(200);
      const demote = await adminSession.ctx.put(`${user(director.user.id)}/role`, { data: { role: 'CLINICAL_DIRECTOR' } });
      expect(demote.status(), await demote.text()).toBe(200);
      const remove = await adminSession.ctx.delete(user(pending.id));
      expect(remove.status(), await remove.text()).toBe(200);
      expect((await users(adminSession.ctx, tenantId)).find((u) => u.id === director.user.id)?.role).toBe('CLINICAL_DIRECTOR');
    } finally {
      await adminSession.ctx.dispose();
      await deleteClinic(owner);
    }
  });

  test('set-password: an invitee removed before setting a password cannot activate; an expired link is refused', async ({ anon }) => {
    const { owner } = await onboardClinic(anon);
    const admin = await loginAs(owner);
    const tenantId = admin.tenant.id;
    try {
      const removed = email('removed');
      expect((await inviteStaff(admin.ctx, tenantId, { email: removed, role: 'THERAPIST' })).status()).toBe(200);
      const token = inviteTokenFor(removed);
      const id = (await users(admin.ctx, tenantId)).find((u) => u.email === removed)!.id;
      expect((await admin.ctx.delete(`/api/v1/tenants/${tenantId}/users/${id}`)).status()).toBe(200);
      const set = await anon.post('/api/v1/auth/set-password', { data: { token, password: NEW_PASSWORD } });
      expect(set.status(), await set.text()).toBe(400);
      expect(await message(set)).toBe('This invitation is no longer valid');
      expect((await anon.post('/api/v1/auth/login', { data: { email: removed, password: NEW_PASSWORD } })).status()).toBe(401);

      const late = email('late');
      expect((await inviteStaff(admin.ctx, tenantId, { email: late, role: 'INTERN' })).status()).toBe(200);
      const lateId = (await users(admin.ctx, tenantId)).find((u) => u.email === late)!.id;
      const expired = await anon.post('/api/v1/auth/set-password', {
        data: { token: staffInviteToken(lateId, tenantId, -60), password: NEW_PASSWORD },
      });
      expect(expired.status(), await expired.text()).toBe(400);
      expect(await message(expired)).toBe('Invalid or expired token');
      // the same claims with a live expiry work: the 400 above was the expiry, not the signature
      const live = await anon.post('/api/v1/auth/set-password', {
        data: { token: staffInviteToken(lateId, tenantId, 600), password: NEW_PASSWORD },
      });
      expect(live.status(), await live.text()).toBe(200);
    } finally {
      await admin.ctx.dispose();
      await deleteClinic(owner);
    }
  });

  test('an account from another clinic is added without a token and still lands in its first clinic', async ({ anon }) => {
    const first = await onboardClinic(anon);
    const second = await onboardClinic(anon);
    const admin = await loginAs(second.owner);
    try {
      const firstLogin = await loginAs(first.owner);
      const firstTenant = firstLogin.tenant.id;
      await firstLogin.ctx.dispose();
      const res = await inviteStaff(admin.ctx, admin.tenant.id, { email: first.owner, role: 'PSYCHOLOGIST' });
      expect(res.status(), await res.text()).toBe(200);
      expect(await res.json()).toEqual({ message: 'Invitation sent', email: first.owner }); // nothing about other clinics
      const mail = lastEmailTo(first.owner);
      expect(mail.html).not.toContain('token=');
      expect(mail.html).toContain('/auth/login');
      expect((await users(admin.ctx, admin.tenant.id)).find((u) => u.email === first.owner)).toEqual(
        expect.objectContaining({ role: 'PSYCHOLOGIST', status: 'active' }),
      );
      // until clinic switching ships, login keeps picking the first clinic
      const login = await loginAs(first.owner, CLINIC_PASSWORD);
      expect(login.tenant.id).toBe(firstTenant);
      expect(login.user.role).toBe('ADMIN');
      await login.ctx.dispose();
    } finally {
      await admin.ctx.dispose();
      await deleteClinic(second.owner);
      await deleteClinic(first.owner);
    }
  });

  test('onboarding with "send invitation" emails the team member a set-password link (no temporary password)', async ({ anon }) => {
    const member = email('onboarded');
    const { owner } = await onboardClinic(anon, { team: [{ email: member, role: 'SUPPORT_STAFF', invite: true }] });
    try {
      await expect.poll(() => { try { return inviteTokenFor(member); } catch { return ''; } }).not.toBe('');
      const set = await anon.post('/api/v1/auth/set-password', { data: { token: inviteTokenFor(member), password: NEW_PASSWORD } });
      expect(set.status(), await set.text()).toBe(200);
      const login = await loginAs(member, NEW_PASSWORD);
      expect(login.user.role).toBe('SUPPORT_STAFF');
      await login.ctx.dispose();
    } finally {
      await deleteClinic(owner);
    }
  });
});
