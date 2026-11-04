import { request as pwRequest, APIRequestContext } from '@playwright/test';
import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { env, uniq, DEMO_THERAPIST } from '../src/env';
import { E2E_CLINIC, deleteClinic } from '../src/clinics';

/**
 * Staff can't double-book a clinician; an admin or clinical director may override with a reason
 * (capacity MVP §3). Each test books on its own random day far ahead, so no parallel spec shares it.
 */

const CLASH = 'The clinician already has a session at that time';

/** HH:MM on a random day 400–700 days ahead, clinic time (IST). */
function farDay(): (hhmm: string) => string {
  const d = new Date();
  d.setDate(d.getDate() + 400 + Math.floor(Math.random() * 300));
  const day = d.toISOString().slice(0, 10);
  return (hhmm) => `${day}T${hhmm}:00+05:30`;
}

async function newPatient(api: APIRequestContext, assignedTo?: string): Promise<string> {
  const res = await api.post('/api/v1/patients/', {
    data: { first_name: uniq('Clash'), last_name: 'Patient', ...(assignedTo ? { assigned_therapist_id: assignedTo } : {}) },
  });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).id;
}

const ALLOW_LISTED_PHONE = '+919876543211'; // VERIFICATION_TEST_PHONES: onboarding skips phone.email

/** A throwaway clinic `E2E <slug>` with a front desk and a therapist; delete it with deleteClinic(owner). */
async function onboardDeskClinic(anon: APIRequestContext): Promise<{ owner: string; desk: string; therapist: string }> {
  const slug = uniq('dbdesk').toLowerCase();
  const email = (who: string) => `${who}.${slug}@example.com`;
  const member = (who: string, role: string) => ({
    email: email(who), first_name: who, last_name: 'Staff', role, phone: ALLOW_LISTED_PHONE, license_number: `LIC-${slug}`,
    temporary_password: 'Password123!', send_invitation: false,
  });
  const res = await anon.post('/api/v1/onboarding/complete', {
    data: {
      organization: {
        name: `${E2E_CLINIC} ${slug}`, type: 'clinic', contact_email: `${slug}@example.com`, contact_phone: ALLOW_LISTED_PHONE,
        address_line1: '1 Road', city: 'Pune', state: 'MH', postal_code: '411001',
      },
      plan: { plan_type: 'basic', max_users: 5, max_patients: 100, max_sessions_per_month: 500 },
      admin: { email: email('admin'), password: 'Password123!', first_name: 'Clash', last_name: 'Admin', phone: ALLOW_LISTED_PHONE },
      admin_role: 'ADMIN',
      team_members: [member('desk', 'SUPPORT_STAFF'), member('therapist', 'THERAPIST')],
    },
  });
  expect(res.status(), await res.text()).toBe(200);
  return { owner: email('admin'), desk: email('desk'), therapist: email('therapist') };
}

/** Staff login → a context that sends what the frontend sends. */
async function loginAs(email: string): Promise<{ ctx: APIRequestContext; userId: string; role: string }> {
  const anon = await pwRequest.newContext({ baseURL: env.API_URL });
  const res = await anon.post('/api/v1/auth/login', { data: { email, password: 'Password123!' } });
  const text = await res.text();
  await anon.dispose();
  expect(res.status(), `login as ${email}: ${text}`).toBe(200);
  const body = JSON.parse(text);
  const ctx = await pwRequest.newContext({
    baseURL: env.API_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${body.access_token}`, 'X-Tenant-ID': body.tenant.id },
  });
  return { ctx, userId: body.user.id, role: body.user.role };
}

const book = (ctx: APIRequestContext, patient_id: string, scheduled_at: string, extra: Record<string, unknown> = {}) =>
  ctx.post('/api/v1/sessions/', { data: { patient_id, scheduled_at, duration_minutes: 50, ...extra } });

test.describe('staff booking refuses a double-booked clinician', () => {
  requireApi();
  requireAuth();

  test('an overlapping session → 409; back-to-back is fine; a cancelled session no longer blocks', async ({ api }) => {
    const at = farDay();
    const patientId = await newPatient(api);
    try {
      const first = await book(api, patientId, at('10:00'));
      expect(first.status(), await first.text()).toBe(200);
      const clash = await book(api, patientId, at('10:30'));
      expect(clash.status()).toBe(409);
      expect((await clash.json()).message).toBe(CLASH);
      const before = await book(api, patientId, at('09:10')); // 09:10–10:00 ends as the first starts
      expect(before.status(), await before.text()).toBe(200);
      const after = await book(api, patientId, at('10:50')); // starts as the first ends
      expect(after.status(), await after.text()).toBe(200);

      expect((await api.post(`/api/v1/sessions/${(await first.json()).id}/cancel`, { data: { reason: 'e2e' } })).status()).toBe(200);
      const again = await book(api, patientId, at('10:00'));
      expect(again.status(), await again.text()).toBe(200);
    } finally {
      await api.delete(`/api/v1/patients/${patientId}`);
    }
  });

  test('an admin may double-book with a reason (kept in the notes); a blank reason is still 409', async ({ api }) => {
    const at = farDay();
    const patientId = await newPatient(api);
    try {
      expect((await book(api, patientId, at('11:00'))).status()).toBe(200);
      const blank = await book(api, patientId, at('11:15'), { override_reason: '   ' });
      expect(blank.status()).toBe(409);
      const forced = await book(api, patientId, at('11:15'), { override_reason: 'crisis call' });
      expect(forced.status(), await forced.text()).toBe(200);
      const detail = await (await api.get(`/api/v1/sessions/${(await forced.json()).id}`)).json();
      expect(detail.session_notes).toBe('Double-booked (override): crisis call');
    } finally {
      await api.delete(`/api/v1/patients/${patientId}`);
    }
  });

  test('rescheduling onto a booked time → 409 (override allowed); moving a session into the past is not checked', async ({ api }) => {
    const at = farDay();
    const patientId = await newPatient(api);
    try {
      expect((await book(api, patientId, at('14:00'))).status()).toBe(200);
      const other = await (await book(api, patientId, at('16:00'))).json();
      const onto = await api.put(`/api/v1/sessions/${other.id}`, { data: { scheduled_at: at('14:20') } });
      expect(onto.status()).toBe(409);
      expect((await onto.json()).message).toBe(CLASH);
      const kept = (await (await api.get(`/api/v1/sessions/${other.id}`)).json()).scheduled_at;
      expect(new Date(kept).getTime()).toBe(new Date(at('16:00')).getTime()); // the refused move changed nothing
      // moving it to its own time (a no-op) never clashes with itself
      expect((await api.put(`/api/v1/sessions/${other.id}`, { data: { scheduled_at: at('16:00') } })).status()).toBe(200);
      const forced = await api.put(`/api/v1/sessions/${other.id}`, { data: { scheduled_at: at('14:20'), override_reason: 'family emergency' } });
      expect(forced.status(), await forced.text()).toBe(200);

      // two sessions recorded in the past at the same time: a record, not a booking
      const past = new Date(Date.now() - 3 * 86_400_000).toISOString();
      const a = await (await book(api, patientId, at('08:00'))).json();
      const b = await (await book(api, patientId, at('12:00'))).json();
      expect((await api.put(`/api/v1/sessions/${a.id}`, { data: { scheduled_at: past } })).status()).toBe(200);
      expect((await api.put(`/api/v1/sessions/${b.id}`, { data: { scheduled_at: past } })).status()).toBe(200);
    } finally {
      await api.delete(`/api/v1/patients/${patientId}`);
    }
  });

  test('a therapist cannot override a double booking (403); their clash is 409 like anyone else', async ({ api }) => {
    const anon = await pwRequest.newContext({ baseURL: env.API_URL });
    const login = await anon.post('/api/v1/auth/login', { data: { ...DEMO_THERAPIST, audience: 'staff' } });
    expect(login.status()).toBe(200);
    const body = await login.json();
    await anon.dispose();
    const jane = await pwRequest.newContext({
      baseURL: env.API_URL,
      extraHTTPHeaders: { Authorization: `Bearer ${body.access_token}`, 'X-Tenant-ID': body.tenant.id },
    });
    const at = farDay();
    const patientId = await newPatient(api, body.user.id);
    try {
      expect((await book(jane, patientId, at('15:00'))).status()).toBe(200);
      expect((await book(jane, patientId, at('15:30'))).status()).toBe(409);
      const forced = await book(jane, patientId, at('15:30'), { override_reason: 'please' });
      expect(forced.status()).toBe(403);
      expect((await forced.json()).message).toBe('Only an admin or clinical director can double-book a clinician');
    } finally {
      await jane.dispose();
      await api.delete(`/api/v1/patients/${patientId}`);
    }
  });

  test('the front desk cannot override a double booking (403, nothing changes); its clash is 409, a free time 200', async ({ anon }) => {
    const clinic = await onboardDeskClinic(anon);
    const ther = await loginAs(clinic.therapist);
    const front = await loginAs(clinic.desk);
    try {
      expect(front.role).toBe('SUPPORT_STAFF');
      const at = farDay();
      const patientId = await newPatient(ther.ctx, ther.userId);
      const first = await book(ther.ctx, patientId, at('10:00'));
      expect(first.status(), await first.text()).toBe(200);
      const second = await book(ther.ctx, patientId, at('12:00'));
      expect(second.status(), await second.text()).toBe(200);
      const id: string = (await second.json()).id;

      const forced = await front.ctx.put(`/api/v1/sessions/${id}`, { data: { scheduled_at: at('10:20'), override_reason: 'walk-in' } });
      expect(forced.status()).toBe(403);
      expect((await forced.json()).message).toBe('Only an admin or clinical director can double-book a clinician');
      const kept = await (await ther.ctx.get(`/api/v1/sessions/${id}`)).json();
      expect(new Date(kept.scheduled_at).getTime()).toBe(new Date(at('12:00')).getTime());
      expect(kept.session_notes ?? '').not.toContain('Double-booked (override)');

      const clash = await front.ctx.put(`/api/v1/sessions/${id}`, { data: { scheduled_at: at('10:20') } });
      expect(clash.status()).toBe(409);
      expect((await clash.json()).message).toBe(CLASH);

      const moved = await front.ctx.put(`/api/v1/sessions/${id}`, { data: { scheduled_at: at('13:00') } });
      expect(moved.status(), await moved.text()).toBe(200);
      const after = await (await ther.ctx.get(`/api/v1/sessions/${id}`)).json();
      expect(new Date(after.scheduled_at).getTime()).toBe(new Date(at('13:00')).getTime());
    } finally {
      await ther.ctx.dispose();
      await front.ctx.dispose();
      await deleteClinic(clinic.owner);
    }
  });
});
