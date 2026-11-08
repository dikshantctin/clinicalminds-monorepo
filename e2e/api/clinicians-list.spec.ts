import { request as pwRequest, type APIRequestContext } from '@playwright/test';
import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { env, uniq, DEMO_PATIENT } from '../src/env';
import { E2E_CLINIC, deleteClinic } from '../src/clinics';

/**
 * GET /api/v1/clinicians: the clinic's bookable clinicians (PSYCHOLOGIST, THERAPIST, CLINICAL_DIRECTOR; active,
 * not suspended) for the New session picker. Any staff member may read it, the front desk included (it has no
 * /teams since #70); a patient may not. A clinician linked to no service is still listed.
 */
const PASSWORD = 'Password123!';
const PHONE = '+919876543211'; // VERIFICATION_TEST_PHONES: onboarding skips phone.email

test.describe('GET /api/v1/clinicians', () => {
  requireApi();
  requireAuth();

  const slug = uniq('clinlist').toLowerCase();
  const email = (who: string) => `${who}.${slug}@example.com`;
  const ctx: Record<string, APIRequestContext> = {};
  const ids: Record<string, string> = {};

  test.beforeAll(async () => {
    const anon = await pwRequest.newContext({ baseURL: env.API_URL });
    const member = (who: string, role: string) => ({
      email: email(who), first_name: who, last_name: 'List', role, phone: PHONE, temporary_password: PASSWORD, send_invitation: false,
      ...(role === 'SUPPORT_STAFF' ? {} : { license_number: `LIC-${who}-${slug}`, license_type: 'RCI' }),
    });
    const onboarded = await anon.post('/api/v1/onboarding/complete', {
      data: {
        organization: {
          name: `${E2E_CLINIC} ${slug}`, type: 'clinic', contact_email: `${slug}@example.com`, contact_phone: PHONE,
          address_line1: '1 MG Road', city: 'Pune', state: 'MH', postal_code: '411001',
        },
        plan: { plan_type: 'basic', max_users: 10, max_patients: 100, max_sessions_per_month: 500 },
        admin: { email: email('admin'), password: PASSWORD, first_name: 'admin', last_name: 'List', phone: PHONE },
        admin_role: 'CLINICAL_DIRECTOR', // the owner is the clinic's director (onboarding offers no director member)
        team_members: [
          member('therapist', 'THERAPIST'), member('psych', 'PSYCHOLOGIST'), member('intern', 'INTERN'),
          member('desk', 'SUPPORT_STAFF'), member('admin2', 'ADMIN'),
        ],
        timezone: 'Asia/Kolkata',
      },
    });
    expect(onboarded.status(), await onboarded.text()).toBe(200);
    for (const who of ['admin', 'therapist', 'psych', 'intern', 'desk', 'admin2']) {
      const login = await anon.post('/api/v1/auth/login', { data: { email: email(who), password: PASSWORD } });
      expect(login.status(), await login.text()).toBe(200);
      const body = await login.json();
      ids[who] = body.user.id;
      ctx[who] = await pwRequest.newContext({
        baseURL: env.API_URL,
        extraHTTPHeaders: { Authorization: `Bearer ${body.access_token}`, 'X-Tenant-ID': body.tenant.id },
      });
    }
    await anon.dispose();
  });

  test.afterAll(async () => {
    for (const c of Object.values(ctx)) await c.dispose();
    await deleteClinic(email('admin'));
  });

  test('every staff role, the front desk included, gets exactly the bookable clinicians', async () => {
    const expected = [
      { id: ids.admin, first_name: 'admin', last_name: 'List', role: 'CLINICAL_DIRECTOR' },
      { id: ids.psych, first_name: 'psych', last_name: 'List', role: 'PSYCHOLOGIST' },
      { id: ids.therapist, first_name: 'therapist', last_name: 'List', role: 'THERAPIST' },
    ];
    for (const who of ['desk', 'admin2', 'intern', 'therapist']) {
      const res = await ctx[who].get('/api/v1/clinicians');
      expect(res.status(), await res.text()).toBe(200);
      expect({ who, body: await res.json() }).toEqual({ who, body: expected });
    }
  });

  test('a patient gets 403, no token 401', async () => {
    const anon = await pwRequest.newContext({ baseURL: env.API_URL });
    expect((await anon.get('/api/v1/clinicians')).status()).toBe(401);
    const login = await anon.post('/api/v1/auth/login', { data: { ...DEMO_PATIENT, audience: 'patient' } });
    expect(login.status(), await login.text()).toBe(200);
    const body = await login.json();
    const patient = await pwRequest.newContext({
      baseURL: env.API_URL,
      extraHTTPHeaders: { Authorization: `Bearer ${body.access_token}`, 'X-Tenant-ID': body.tenant.id },
    });
    expect((await patient.get('/api/v1/clinicians')).status()).toBe(403);
    await patient.dispose();
    await anon.dispose();
  });
});
