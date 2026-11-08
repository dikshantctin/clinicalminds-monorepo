import { request as pwRequest, APIRequestContext } from '@playwright/test';
import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { env, uniq, RANDOM_UUID, DEMO_PATIENT, DEMO_THERAPIST, DEMO_PSYCHOLOGIST } from '../src/env';
import { CLASH, uniqueDay } from '../src/sessions';
import { deleteClinic, makeDirector } from '../src/clinics';

/**
 * Staff book a session with a chosen clinician (POST /sessions/ therapist_id): an admin, director or front
 * desk picks any clinician of the clinic; a clinician books only themselves. The clash check is the chosen
 * clinician's. Clinicians = the public booking set (psychologist, therapist, clinical director); interns are
 * not booked for by others (user decision 2026-11-04). A patient with no clinician is assigned the one booked;
 * a patient with a clinician keeps them. The front desk with no pick books the patient's clinician.
 */

async function login(creds: { email: string; password: string }) {
  const anon = await pwRequest.newContext({ baseURL: env.API_URL });
  const res = await anon.post('/api/v1/auth/login', { data: { ...creds, audience: 'staff' } });
  expect(res.status(), creds.email).toBe(200);
  const body = await res.json();
  await anon.dispose();
  const ctx = await pwRequest.newContext({
    baseURL: env.API_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${body.access_token}`, 'X-Tenant-ID': body.tenant.id },
  });
  return { ctx, id: body.user.id as string };
}

async function newPatient(api: APIRequestContext, assignedTo?: string): Promise<string> {
  const res = await api.post('/api/v1/patients/', {
    data: { first_name: uniq('ForClinician'), last_name: 'Patient', ...(assignedTo ? { assigned_therapist_id: assignedTo } : {}) },
  });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).id;
}

test.describe('POST /api/v1/sessions/ with therapist_id', () => {
  requireApi();
  requireAuth();

  test("an admin books a session with a chosen clinician: it is the clinician's, on their schedule", async ({ api, auth }) => {
    const jane = await login(DEMO_THERAPIST);
    const day = uniqueDay();
    const patientId = await newPatient(api);
    try {
      const res = await api.post('/api/v1/sessions/', {
        data: { patient_id: patientId, scheduled_at: `${day}T11:00:00+05:30`, therapist_id: jane.id },
      });
      expect(res.status(), await res.text()).toBe(200);
      const id = (await res.json()).id;
      expect((await (await api.get(`/api/v1/sessions/${id}`)).json()).therapist_id).toBe(jane.id);
      expect(jane.id).not.toBe(auth.user!.id);

      // Jane sees it among her own sessions (a clinician's list is scoped to their own)
      const mine = await (await jane.ctx.get('/api/v1/sessions/', { params: { limit: 500 } })).json();
      expect(mine.sessions.map((s: { id: string }) => s.id)).toContain(id);
      // the patient had no clinician, so they are now Jane's, and she can open the record
      expect((await (await api.get(`/api/v1/patients/${patientId}`)).json()).assigned_therapist_id).toBe(jane.id);
      expect((await jane.ctx.get(`/api/v1/patients/${patientId}`)).status()).toBe(200);
    } finally {
      await jane.ctx.dispose();
      await api.delete(`/api/v1/patients/${patientId}`);
    }
  });

  test("the clash check is the chosen clinician's, not the booker's", async ({ api }) => {
    const jane = await login(DEMO_THERAPIST);
    const day = uniqueDay();
    const patientId = await newPatient(api);
    try {
      const first = await api.post('/api/v1/sessions/', {
        data: { patient_id: patientId, scheduled_at: `${day}T11:00:00+05:30`, therapist_id: jane.id },
      });
      expect(first.status(), await first.text()).toBe(200);
      const clash = await api.post('/api/v1/sessions/', {
        data: { patient_id: patientId, scheduled_at: `${day}T11:30:00+05:30`, therapist_id: jane.id },
      });
      expect(clash.status()).toBe(409);
      expect((await clash.json()).message).toBe(CLASH);
      // the admin's own calendar is free at that time
      const own = await api.post('/api/v1/sessions/', { data: { patient_id: patientId, scheduled_at: `${day}T11:30:00+05:30` } });
      expect(own.status(), await own.text()).toBe(200);
    } finally {
      await jane.ctx.dispose();
      await api.delete(`/api/v1/patients/${patientId}`);
    }
  });

  test('a clinician books only themselves (403 for a colleague)', async ({ api }) => {
    const jane = await login(DEMO_THERAPIST);
    const smith = await login(DEMO_PSYCHOLOGIST);
    await smith.ctx.dispose();
    const day = uniqueDay();
    const patientId = await newPatient(api, jane.id);
    try {
      const other = await jane.ctx.post('/api/v1/sessions/', {
        data: { patient_id: patientId, scheduled_at: `${day}T09:00:00+05:30`, therapist_id: smith.id },
      });
      expect(other.status()).toBe(403);
      expect((await other.json()).message).toBe('A clinician can book only their own sessions');
      const self = await jane.ctx.post('/api/v1/sessions/', {
        data: { patient_id: patientId, scheduled_at: `${day}T09:00:00+05:30`, therapist_id: jane.id },
      });
      expect(self.status(), await self.text()).toBe(200);
    } finally {
      await jane.ctx.dispose();
      await api.delete(`/api/v1/patients/${patientId}`);
    }
  });

  test('an unknown id, a non-clinician (portal patient) or an intern → 422; nothing is booked', async ({ api }) => {
    const staff = (await (await api.get('/api/v1/teams/users')).json()).users as { id: string; role: string }[];
    const intern = staff.find((u) => u.role === 'INTERN');
    expect(intern, 'the demo clinic has an intern').toBeTruthy();
    const anon = await pwRequest.newContext({ baseURL: env.API_URL });
    const portal = await (await anon.post('/api/v1/auth/login', { data: { ...DEMO_PATIENT, audience: 'patient' } })).json();
    await anon.dispose();
    expect(portal.user?.id, 'portal login').toBeTruthy();
    const day = uniqueDay();
    const patientId = await newPatient(api);
    try {
      for (const therapist_id of [RANDOM_UUID, portal.user.id, intern!.id]) {
        const res = await api.post('/api/v1/sessions/', {
          data: { patient_id: patientId, scheduled_at: `${day}T15:00:00+05:30`, therapist_id },
        });
        expect(res.status(), therapist_id).toBe(422);
        expect((await res.json()).message).toBe('Pick a clinician of this clinic');
      }
      expect((await api.post('/api/v1/sessions/', { data: { patient_id: patientId, scheduled_at: `${day}T15:00:00+05:30`, therapist_id: 'nope' } })).status()).toBe(422);
      const list = await (await api.get('/api/v1/sessions/', { params: { patient_id: patientId } })).json();
      expect(list.sessions).toHaveLength(0);
    } finally {
      await api.delete(`/api/v1/patients/${patientId}`);
    }
  });

  test("a patient who has a clinician keeps them when booked with another", async ({ api }) => {
    const jane = await login(DEMO_THERAPIST);
    const smith = await login(DEMO_PSYCHOLOGIST);
    await jane.ctx.dispose();
    await smith.ctx.dispose();
    const patientId = await newPatient(api, smith.id);
    try {
      const res = await api.post('/api/v1/sessions/', {
        data: { patient_id: patientId, scheduled_at: `${uniqueDay()}T16:00:00+05:30`, therapist_id: jane.id },
      });
      expect(res.status(), await res.text()).toBe(200);
      expect((await res.json()).therapist_id).toBe(jane.id);
      expect((await (await api.get(`/api/v1/patients/${patientId}`)).json()).assigned_therapist_id).toBe(smith.id);
    } finally {
      await api.delete(`/api/v1/patients/${patientId}`);
    }
  });
});

test.describe('POST /api/v1/sessions/ by the front desk', () => {
  requireApi();
  requireAuth();
  test.describe.configure({ mode: 'serial' });

  const slug = uniq('deskbook').toLowerCase();
  const phone = '+919876543211'; // VERIFICATION_TEST_PHONES: onboarding skips phone.email, logins count as verified
  const member = (who: string, role: string) => ({
    email: `${who}.${slug}@example.com`, first_name: who, last_name: 'Member', role, phone, license_number: 'E2E-LIC-1',
    temporary_password: 'Password123!', send_invitation: false,
  });
  let director: Awaited<ReturnType<typeof login>>;
  let desk: Awaited<ReturnType<typeof login>>;
  let therapistId: string;

  test.beforeAll(async () => {
    const anon = await pwRequest.newContext({ baseURL: env.API_URL });
    const onboarded = await anon.post('/api/v1/onboarding/complete', {
      data: {
        organization: {
          name: `E2E ${slug}`, type: 'clinic', contact_email: `${slug}@example.com`, contact_phone: phone,
          address_line1: '1 Road', city: 'Pune', state: 'MH', postal_code: '411001',
        },
        plan: { plan_type: 'basic', max_users: 5, max_patients: 100, max_sessions_per_month: 500 },
        admin: { email: `admin.${slug}@example.com`, password: 'Password123!', first_name: 'Desk', last_name: 'Director', phone },
        admin_role: 'ADMIN', // the registrant; the director joins as a team member and is made director below
        team_members: [member('director', 'PSYCHOLOGIST'), member('desk', 'SUPPORT_STAFF'), member('thera', 'THERAPIST')],
      },
    });
    expect(onboarded.status(), await onboarded.text()).toBe(200);
    await anon.dispose();
    await makeDirector(`admin.${slug}@example.com`, `director.${slug}@example.com`);
    director = await login({ email: `director.${slug}@example.com`, password: 'Password123!' });
    desk = await login({ email: `desk.${slug}@example.com`, password: 'Password123!' });
    const thera = await login({ email: `thera.${slug}@example.com`, password: 'Password123!' });
    therapistId = thera.id;
    await thera.ctx.dispose();
  });
  test.afterAll(async () => {
    await desk?.ctx.dispose();
    await director?.ctx.dispose();
    await deleteClinic(`admin.${slug}@example.com`);
  });

  const book = (data: Record<string, unknown>) =>
    desk.ctx.post('/api/v1/sessions/', { data: { scheduled_at: `${uniqueDay()}T10:00:00+05:30`, ...data } });

  test("no pick: the session is the patient's clinician's, never the receptionist's", async () => {
    const patientId = await newPatient(director.ctx, therapistId);
    const res = await book({ patient_id: patientId });
    expect(res.status(), await res.text()).toBe(200);
    expect((await res.json()).therapist_id).toBe(therapistId);
  });

  test('an explicit pick wins over the patient’s clinician', async () => {
    const patientId = await newPatient(director.ctx, therapistId);
    const res = await book({ patient_id: patientId, therapist_id: director.id });
    expect(res.status(), await res.text()).toBe(200);
    expect((await res.json()).therapist_id).toBe(director.id);
  });

  test('no pick and the patient has no clinician → 422 "Choose a clinician"; naming themselves too', async () => {
    const patientId = await newPatient(director.ctx);
    for (const data of [{ patient_id: patientId }, { patient_id: patientId, therapist_id: desk.id }]) {
      const res = await book(data);
      expect(res.status(), JSON.stringify(data)).toBe(422);
      expect((await res.json()).message).toBe('Choose a clinician');
    }
    const list = await (await director.ctx.get('/api/v1/sessions/', { params: { patient_id: patientId } })).json();
    expect(list.sessions).toHaveLength(0);
  });

  test("another clinic's clinician → 422 \"Pick a clinician of this clinic\"", async () => {
    const jane = await login(DEMO_THERAPIST);
    await jane.ctx.dispose();
    const patientId = await newPatient(director.ctx, therapistId);
    const res = await book({ patient_id: patientId, therapist_id: jane.id });
    expect(res.status()).toBe(422);
    expect((await res.json()).message).toBe('Pick a clinician of this clinic');
  });
});
