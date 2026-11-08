import { APIRequestContext } from '@playwright/test';
import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { uniq, UNVERIFIED_USER } from '../src/env';
import { ALLOW_LISTED_PHONE, CLINIC_PASSWORD, E2E_CLINIC, deleteClinic, loginAs, onboardClinic } from '../src/clinics';
import { portalAccount } from '../src/portal-account';

/**
 * The onboarding verification gate checks each channel on its own: a test phone (VERIFICATION_TEST_PHONES) skips
 * only the phone proof, a test email (VERIFICATION_TEST_EMAILS; CI lists the reserved domain "@example.com")
 * only the email proof. An admin email or phone already used by a clinic's staff is refused, without telling an
 * unproven caller whose number it is, or whether an email belongs to a clinic or to a patient (health data). Proof from phone.email itself (the channel swap, a proven duplicate phone)
 * is covered by backend pytest: e2e cannot drive the vendor.
 */

const EMAIL_REQUIRED = 'Email verification required. Please verify your email address first.';
const PHONE_REQUIRED = 'Phone verification required. Please verify your phone number first.';
const EMAIL_TAKEN_BY_CLINIC = 'This email is already registered with us for a clinic.';
const EMAIL_IN_USE = 'This email is already in use. Please use a different email for the clinic.';

/** A number on no allow-list and never proven: +91 9 then nine random digits. */
const unprovenPhone = () => `+919${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;

function payload(slug: string, admin: { email: string; phone: string }, team: object[] = []) {
  return {
    organization: {
      name: `${E2E_CLINIC} ${slug}`, type: 'clinic', contact_email: `${slug}@example.com`, contact_phone: ALLOW_LISTED_PHONE,
      address_line1: '1 Road', city: 'Pune', state: 'MH', postal_code: '411001',
    },
    plan: { plan_type: 'basic', max_users: 10, max_patients: 100, max_sessions_per_month: 500 },
    admin: { email: admin.email, password: CLINIC_PASSWORD, first_name: 'New', last_name: 'Admin', phone: admin.phone },
    admin_role: 'ADMIN',
    team_members: team,
  };
}

async function gateErrors(anon: APIRequestContext, data: object): Promise<string[]> {
  const res = await anon.post('/api/v1/onboarding/complete', { data });
  expect(res.status(), await res.text()).toBe(400);
  return (await res.json()).message.errors;
}

async function validationErrors(anon: APIRequestContext, data: object): Promise<string[]> {
  const res = await anon.post('/api/v1/onboarding/validate', { data });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).errors;
}

test.describe('onboarding verification: each channel on its own', () => {
  requireApi();

  test('a test phone does not stand in for an unproven email', async ({ anon }) => {
    const slug = uniq('vb').toLowerCase();
    // example.org is reserved but not on the CI list: an email nobody has proven
    const errors = await gateErrors(anon, payload(slug, { email: `admin.${slug}@example.org`, phone: ALLOW_LISTED_PHONE }));
    expect(errors).toEqual([EMAIL_REQUIRED]);
  });

  test('a test email does not stand in for an unproven phone', async ({ anon }) => {
    const slug = uniq('vb').toLowerCase();
    const errors = await gateErrors(anon, payload(slug, { email: `admin.${slug}@example.com`, phone: unprovenPhone() }));
    expect(errors).toEqual([PHONE_REQUIRED]);
  });
});

test.describe('onboarding: an admin email or phone a clinic already uses', () => {
  requireApi();

  test("a clinic staff member's email is refused as registered for a clinic", async ({ anon }) => {
    const { owner } = await onboardClinic(anon);
    try {
      const slug = uniq('vb').toLowerCase();
      const data = payload(slug, { email: owner, phone: ALLOW_LISTED_PHONE });
      expect(await validationErrors(anon, data)).toEqual([EMAIL_TAKEN_BY_CLINIC]);
      expect(await gateErrors(anon, data)).toEqual([EMAIL_TAKEN_BY_CLINIC]);
    } finally {
      await deleteClinic(owner);
    }
  });

  test("a staff member's phone that the caller has not proven gets only the verification error", async ({ anon }) => {
    // a clinic whose team member has a real-looking number on file
    const staffPhone = unprovenPhone();
    const slug = uniq('vbs').toLowerCase();
    const owner = `admin.${slug}@example.com`;
    const created = await anon.post('/api/v1/onboarding/complete', {
      data: payload(slug, { email: owner, phone: ALLOW_LISTED_PHONE }, [{
        email: `m.${slug}@example.com`, first_name: 'Team', last_name: 'Member', role: 'THERAPIST', phone: staffPhone,
        license_number: 'RCI-E2E', temporary_password: CLINIC_PASSWORD, send_invitation: false,
      }]),
    });
    expect(created.status(), await created.text()).toBe(200);
    try {
      const other = uniq('vb').toLowerCase();
      const data = payload(other, { email: `admin.${other}@example.com`, phone: staffPhone });
      // nothing says the number belongs to a clinician until the caller proves they hold it
      expect(await validationErrors(anon, data)).toEqual([]);
      expect(await gateErrors(anon, data)).toEqual([PHONE_REQUIRED]);
    } finally {
      await deleteClinic(owner);
    }
  });
});

test.describe('onboarding: a patient account', () => {
  requireApi();
  requireAuth();

  test("a patient's email is in use, not registered for a clinic", async ({ anon, api }) => {
    const patient = await portalAccount(api, CLINIC_PASSWORD);
    try {
      const slug = uniq('vb').toLowerCase();
      expect(await validationErrors(anon, payload(slug, { email: patient.email, phone: ALLOW_LISTED_PHONE }))).toEqual([EMAIL_IN_USE]);
    } finally {
      await patient.cleanup();
    }
  });
});

test.describe('onboarding: no account details for an unproven email', () => {
  requireApi();
  requireAuth();

  test("a patient's and a staff member's email get the same answer until the email is proven", async ({ anon, api }) => {
    // example.org is on no allow-list, so neither address counts as proven
    const created = await api.post('/api/v1/patients/', { data: { first_name: uniq('Unproven'), last_name: 'Patient' } });
    expect(created.status(), await created.text()).toBe(200);
    const patientId: string = (await created.json()).id;
    const patientEmail = `${uniq('patient')}@example.org`.toLowerCase();
    const invited = await api.post(`/api/v1/patients/${patientId}/invite`, { data: { email: patientEmail, first_name: 'Un', last_name: 'Proven' } });
    expect(invited.status(), await invited.text()).toBe(200);
    try {
      for (const email of [patientEmail, UNVERIFIED_USER.email]) {
        const slug = uniq('vb').toLowerCase();
        const data = payload(slug, { email, phone: ALLOW_LISTED_PHONE });
        // whether the account is a clinic's or a patient's is not said: only that the address is taken
        expect(await validationErrors(anon, data)).toEqual([`User with email ${email} already exists`]);
        // /complete checks the proof first and says nothing about accounts
        expect(await gateErrors(anon, data)).toEqual([EMAIL_REQUIRED]);
      }
    } finally {
      await api.delete(`/api/v1/patients/${patientId}`);
    }
  });
});

test.describe('demo identities', () => {
  requireApi();
  requireAuth();

  test('the demo psychologist is verified on both channels (listed email and listed phone)', async () => {
    const { ctx, user } = await loginAs('dr.smith@democlinic.com');
    try {
      expect(user).toEqual(expect.objectContaining({ email_verified: true, phone_verified: true }));
    } finally {
      await ctx.dispose();
    }
  });
});
