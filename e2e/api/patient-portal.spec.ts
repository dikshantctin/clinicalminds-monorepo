import { request as pwRequest, APIRequestContext } from '@playwright/test';
import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { env, uniq, DEMO_THERAPIST } from '../src/env';
import { inviteTokenFor, lastEmailTo } from '../src/outbox';

/**
 * Patient portal accounts. One email = one account = one password; the login address picks the role:
 * /portal/login sends audience "patient" (PATIENT role), /auth/login sends "staff" (the staff role).
 * An invite never overwrites a password. Emails are read from the backend's dev outbox (EMAIL_OUTBOX_DIR).
 */

const PASSWORD = 'Password123!';

async function login(email: string, password: string, audience?: 'staff' | 'patient') {
  const anon = await pwRequest.newContext({ baseURL: env.API_URL });
  const res = await anon.post('/api/v1/auth/login', { data: audience ? { email, password, audience } : { email, password } });
  const status = res.status();
  const body = await res.json();
  await anon.dispose();
  return { status, body };
}

async function createPatient(api: APIRequestContext): Promise<string> {
  const res = await api.post('/api/v1/patients/', { data: { first_name: uniq('Portal'), last_name: 'Patient' } });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).id;
}

async function invite(api: APIRequestContext, patientId: string, email: string) {
  const res = await api.post(`/api/v1/patients/${patientId}/invite`, {
    data: { email, first_name: 'Portal', last_name: 'Patient' },
  });
  return { status: res.status(), body: await res.json() };
}

/** Error bodies come from the app's global handler: {error, message, status_code, ...}. */
const msg = (body: { message?: string }) => body.message;

test.describe('patient portal: invite a new email', () => {
  requireApi();
  requireAuth();

  test('invite → set password → portal login as PATIENT; staff login refused; set-password is one-shot', async ({ api, auth }) => {
    const patientId = await createPatient(api);
    const email = `${uniq('portal')}@example.com`.toLowerCase();
    try {
      const inv = await invite(api, patientId, email);
      expect(inv.status, JSON.stringify(inv.body)).toBe(200);
      expect(inv.body).toEqual({ message: 'Invitation sent', email, existing_account: false });

      const token = inviteTokenFor(email);
      const set = await api.post('/api/v1/patients/set-password', { data: { token, password: PASSWORD } });
      expect(set.status(), await set.text()).toBe(200);

      const again = await api.post('/api/v1/patients/set-password', { data: { token, password: 'Another123!' } });
      expect(again.status()).toBe(400);
      expect(msg(await again.json())).toBe('Account already has a password');

      const portal = await login(email, PASSWORD, 'patient');
      expect(portal.status, JSON.stringify(portal.body)).toBe(200);
      expect(portal.body.user.role).toBe('PATIENT');
      expect(portal.body.tenant.id).toBe(auth.tenantId);

      // the set-password link arrived by email, so the email counts as verified (phone still pending)
      const me = await pwRequest.newContext({
        baseURL: env.API_URL,
        extraHTTPHeaders: { Authorization: `Bearer ${portal.body.access_token}` },
      });
      const meRes = await me.get('/api/v1/auth/me');
      expect(meRes.status()).toBe(200);
      const meBody = await meRes.json();
      expect(meBody.role).toBe('PATIENT');
      expect(meBody.email_verified).toBe(true);
      expect(meBody.phone_verified).toBe(false);
      await me.dispose();

      const staff = await login(email, PASSWORD, 'staff');
      expect(staff.status).toBe(403);
      expect(msg(staff.body)).toBe('No staff access for this account');

      const noAudience = await login(email, PASSWORD);
      expect(noAudience.status).toBe(403);
      expect(msg(noAudience.body)).toBe('No staff access for this account');
    } finally {
      await api.delete(`/api/v1/patients/${patientId}`);
    }
  });

  test('an email already linked to another active patient record in this clinic → 409', async ({ api }) => {
    const first = await createPatient(api);
    const second = await createPatient(api);
    const email = `${uniq('portal')}@example.com`.toLowerCase();
    try {
      expect((await invite(api, first, email)).status).toBe(200);
      const dup = await invite(api, second, email);
      expect(dup.status, JSON.stringify(dup.body)).toBe(409);
      expect(msg(dup.body)).toBe('This email already has portal access for another patient record');
    } finally {
      await api.delete(`/api/v1/patients/${first}`);
      await api.delete(`/api/v1/patients/${second}`);
    }
  });
});

test.describe('patient portal: a staff member who is also a patient', () => {
  requireApi();
  requireAuth();

  test('same account, same password: the address picks the role and the password is never overwritten', async ({ api }) => {
    const patientId = await createPatient(api);
    try {
      const inv = await invite(api, patientId, DEMO_THERAPIST.email);
      expect(inv.status, JSON.stringify(inv.body)).toBe(200);
      expect(inv.body).toEqual({ message: 'Invitation sent', email: DEMO_THERAPIST.email, existing_account: true });

      // an existing account is told to use its own password: no set-password link at all
      const mail = lastEmailTo(DEMO_THERAPIST.email);
      expect(mail.html).toContain('/portal/login');
      expect(mail.html).not.toContain('set-password');

      const staff = await login(DEMO_THERAPIST.email, DEMO_THERAPIST.password, 'staff');
      expect(staff.status, JSON.stringify(staff.body)).toBe(200);
      expect(staff.body.user.role).toBe('THERAPIST');

      const portal = await login(DEMO_THERAPIST.email, DEMO_THERAPIST.password, 'patient');
      expect(portal.status, JSON.stringify(portal.body)).toBe(200);
      expect(portal.body.user.role).toBe('PATIENT');

      const legacy = await login(DEMO_THERAPIST.email, DEMO_THERAPIST.password);
      expect(legacy.status).toBe(200);
      expect(legacy.body.user.role).toBe('THERAPIST');
    } finally {
      await api.delete(`/api/v1/patients/${patientId}`);
    }
  });

  test('a staff member with no patient role cannot use the portal login', async () => {
    const res = await login(env.EMAIL, env.PASSWORD, 'patient');
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(msg(res.body)).toBe('No patient portal access for this account');
  });
});
