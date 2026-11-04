import { request as pwRequest, APIRequestContext } from '@playwright/test';
import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { env, uniq } from '../src/env';
import { E2E_CLINIC, deleteClinic } from '../src/clinics';

/**
 * Front desk (SUPPORT_STAFF): registers walk-ins, books, takes payments, marks no-shows and outcomes,
 * and sees every clinician's day — but never reads or writes clinical content. The server strips it
 * from responses and refuses writes to it (403); hiding it in the UI alone would not be enough.
 */

const PASSWORD = 'Password123!';
const ALLOW_LISTED_PHONE = '+919876543211'; // VERIFICATION_TEST_PHONES: onboarding skips phone.email, logins count as verified

/** Patient fields only clinicians (and admins / directors) see. */
const PATIENT_CLINICAL = [
  'primary_diagnosis', 'secondary_diagnoses', 'risk_factors', 'medications', 'safety_plan', 'treatment_plan', 'intake_notes',
];
/** Session fields the desk never sees: the clinician's record, the risk flag, patient-visible notes and feedback. */
const SESSION_CLINICAL = [
  'session_notes', 'progress_notes', 'next_session_plan', 'treatment_goals', 'crisis_detected', 'crisis_level', 'crisis_notes',
  'patient_notes', 'feedback_rating', 'patient_feedback', 'feedback_comment',
];

type Who = { ctx: APIRequestContext; userId: string; tenantId: string };

async function loginAs(email: string): Promise<Who> {
  const anon = await pwRequest.newContext({ baseURL: env.API_URL });
  const res = await anon.post('/api/v1/auth/login', { data: { email, password: PASSWORD } });
  const text = await res.text();
  await anon.dispose();
  expect(res.status(), `login as ${email}: ${text}`).toBe(200);
  const body = JSON.parse(text);
  const ctx = await pwRequest.newContext({
    baseURL: env.API_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${body.access_token}`, 'X-Tenant-ID': body.tenant.id },
  });
  return { ctx, userId: body.user.id, tenantId: body.tenant.id };
}

const absent = (obj: Record<string, unknown>, keys: string[]) => expect(keys.filter((k) => k in obj)).toEqual([]);

test.describe('front desk (SUPPORT_STAFF) access', () => {
  requireApi();
  requireAuth();
  // one clinic, built once; the tests read and change its rows in order
  test.describe.configure({ mode: 'serial' });

  const slug = uniq('desk').toLowerCase();
  const adminEmail = `admin.${slug}@example.com`;
  const day = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10); // clinic-local day, two days out
  let admin: Who;
  let desk: Who;
  let therapist: Who;
  let patient: { id: string; first_name: string };
  let therapistSession: string; // the therapist's, with notes and a risk flag
  let adminSession: string;

  test.beforeAll(async () => {
    const anon = await pwRequest.newContext({ baseURL: env.API_URL });
    const member = (who: string, role: string) => ({
      email: `${who}.${slug}@example.com`, first_name: who, last_name: 'Staff', role, phone: ALLOW_LISTED_PHONE,
      temporary_password: PASSWORD, send_invitation: false,
      ...(role === 'THERAPIST' ? { license_number: `LIC-${slug}` } : {}),
    });
    const onboarded = await anon.post('/api/v1/onboarding/complete', {
      data: {
        organization: {
          name: `${E2E_CLINIC} ${slug}`, type: 'clinic', contact_email: `${slug}@example.com`, contact_phone: ALLOW_LISTED_PHONE,
          address_line1: '1 Road', city: 'Pune', state: 'MH', postal_code: '411001',
        },
        plan: { plan_type: 'basic', max_users: 5, max_patients: 100, max_sessions_per_month: 500 },
        admin: { email: adminEmail, password: PASSWORD, first_name: 'Desk', last_name: 'Admin', phone: ALLOW_LISTED_PHONE },
        admin_role: 'ADMIN',
        team_members: [member('desk', 'SUPPORT_STAFF'), member('therapist', 'THERAPIST')],
      },
    });
    expect(onboarded.status(), await onboarded.text()).toBe(200);
    await anon.dispose();
    admin = await loginAs(adminEmail);
    desk = await loginAs(`desk.${slug}@example.com`);
    therapist = await loginAs(`therapist.${slug}@example.com`);

    const created = await admin.ctx.post('/api/v1/patients/', {
      data: {
        first_name: uniq('Clinical'), last_name: 'Patient', phone: '+919800000001',
        primary_diagnosis: 'F41.1 Generalised anxiety', secondary_diagnoses: ['F32.0'], risk_factors: ['self-harm history'],
        medications: [{ name: 'Sertraline', dose: '50mg' }], safety_plan: { contact: 'sister' },
        treatment_plan: { goal: 'sleep' }, intake_notes: 'Intake: panic attacks', assigned_therapist_id: therapist.userId,
      },
    });
    expect(created.status(), await created.text()).toBe(200);
    patient = await created.json();

    const own = await therapist.ctx.post('/api/v1/sessions/', { data: { patient_id: patient.id, scheduled_at: `${day}T10:00:00+05:30` } });
    expect(own.status(), await own.text()).toBe(200);
    therapistSession = (await own.json()).id;
    const notes = await therapist.ctx.put(`/api/v1/sessions/${therapistSession}`, {
      data: {
        session_notes: 'Clinician note', progress_notes: 'Progress', goals_addressed: ['sleep'],
        risk_flag: true, risk_level: 'high', risk_notes: 'Risk observed',
      },
    });
    expect(notes.status(), await notes.text()).toBe(200);
    const pn = await therapist.ctx.put(`/api/v1/sessions/${therapistSession}/patient-notes`, { data: { patient_notes: 'Homework: diary' } });
    expect(pn.status(), await pn.text()).toBe(200);

    const theirs = await admin.ctx.post('/api/v1/sessions/', { data: { patient_id: patient.id, scheduled_at: `${day}T12:00:00+05:30` } });
    expect(theirs.status(), await theirs.text()).toBe(200);
    adminSession = (await theirs.json()).id;
  });

  test.afterAll(async () => {
    for (const who of [admin, desk, therapist]) await who?.ctx.dispose();
    await deleteClinic(adminEmail);
  });

  test('registers a walk-in (200, no clinical keys); clinical fields on create are refused (403)', async () => {
    const walkIn = await desk.ctx.post('/api/v1/patients/', {
      data: { first_name: uniq('WalkIn'), last_name: 'Desk', phone: '+919800000002', email: `${uniq('walkin')}@example.com`.toLowerCase(), primary_diagnosis: '', intake_notes: '' },
    });
    expect(walkIn.status(), await walkIn.text()).toBe(200);
    const body = await walkIn.json();
    expect(body.phone).toBe('+919800000002');
    absent(body, PATIENT_CLINICAL);

    for (const data of [{ primary_diagnosis: 'F41.1' }, { medications: [{ name: 'x' }] }, { intake_notes: 'x' }, { risk_factors: ['x'] }]) {
      const res = await desk.ctx.post('/api/v1/patients/', { data: { first_name: uniq('Refused'), last_name: 'Desk', ...data } });
      expect(res.status(), `${JSON.stringify(data)}: ${await res.text()}`).toBe(403);
    }
  });

  test('patient list and detail carry no clinical fields for the desk; the admin still sees them', async () => {
    const list = await desk.ctx.get('/api/v1/patients/', { params: { search: patient.first_name } });
    expect(list.status(), await list.text()).toBe(200);
    const rows = (await list.json()).patients;
    expect(rows.map((p: { id: string }) => p.id)).toEqual([patient.id]);
    absent(rows[0], PATIENT_CLINICAL);
    expect(rows[0].phone).toBe('+919800000001');

    const detail = await desk.ctx.get(`/api/v1/patients/${patient.id}`);
    expect(detail.status(), await detail.text()).toBe(200);
    const d = await detail.json();
    absent(d, PATIENT_CLINICAL);
    expect(d.phone).toBe('+919800000001');
    expect(d.recent_sessions.map((s: { id: string }) => s.id).sort()).toEqual([therapistSession, adminSession].sort());
    for (const s of d.recent_sessions) absent(s, ['patient_notes', 'feedback_rating', 'feedback_comment']);
    expect(JSON.stringify(d)).not.toContain('Homework: diary');

    // a diagnosis filter is not a side channel
    const byDiagnosis = await desk.ctx.get('/api/v1/patients/', { params: { diagnosis: 'no-such-diagnosis', search: patient.first_name } });
    expect((await byDiagnosis.json()).total).toBe(1);

    expect((await desk.ctx.get(`/api/v1/patients/${patient.id}/assessments`)).status()).toBe(403);

    const adminView = await (await admin.ctx.get(`/api/v1/patients/${patient.id}`)).json();
    expect(adminView.primary_diagnosis).toBe('F41.1 Generalised anxiety');
    expect(adminView.medications).toEqual([{ name: 'Sertraline', dose: '50mg' }]);
  });

  test('edits contact fields (200); diagnosis, medications, status are 403; delete is 403', async () => {
    const ok = await desk.ctx.put(`/api/v1/patients/${patient.id}`, {
      data: { phone: '+919800000009', emergency_contact: { name: 'Asha', phone: '+919800000010', relationship: 'sister' } },
    });
    expect(ok.status(), await ok.text()).toBe(200);
    const okBody = await ok.json();
    expect(okBody.phone).toBe('+919800000009');
    absent(okBody, PATIENT_CLINICAL);

    for (const data of [{ primary_diagnosis: 'changed' }, { medications: [] }, { phone: '+919800000011', safety_plan: {} }, { status: 'discharged' }]) {
      const res = await desk.ctx.put(`/api/v1/patients/${patient.id}`, { data });
      expect(res.status(), `${JSON.stringify(data)}: ${await res.text()}`).toBe(403);
    }
    expect((await desk.ctx.delete(`/api/v1/patients/${patient.id}`)).status()).toBe(403);

    const after = await (await admin.ctx.get(`/api/v1/patients/${patient.id}`)).json();
    expect(after.phone).toBe('+919800000009');
    expect(after.primary_diagnosis).toBe('F41.1 Generalised anxiety');
    expect(after.medications).toEqual([{ name: 'Sertraline', dose: '50mg' }]);
    expect(after.status).toBe('active');
  });

  test('session list and detail carry no clinical fields; clinical writes are 403; a reschedule is 200', async () => {
    const list = await desk.ctx.get('/api/v1/sessions/', { params: { date_from: day, date_to: day } });
    expect(list.status(), await list.text()).toBe(200);
    const sessions = (await list.json()).sessions;
    expect(sessions.map((s: { id: string }) => s.id).sort()).toEqual([therapistSession, adminSession].sort());
    for (const s of sessions) absent(s, SESSION_CLINICAL);

    const detail = await desk.ctx.get(`/api/v1/sessions/${therapistSession}`);
    expect(detail.status(), await detail.text()).toBe(200);
    const d = await detail.json();
    absent(d, SESSION_CLINICAL);
    expect(d.patient_name).toBe(`${patient.first_name} Patient`);
    expect(d.status).toBe('scheduled');

    for (const data of [{ risk_flag: false }, { risk_level: 'low' }, { progress_notes: 'x' }, { session_notes: 'x' }, { goals_addressed: [] }]) {
      const res = await desk.ctx.put(`/api/v1/sessions/${therapistSession}`, { data });
      expect(res.status(), `${JSON.stringify(data)}: ${await res.text()}`).toBe(403);
    }
    const pn = await desk.ctx.put(`/api/v1/sessions/${therapistSession}/patient-notes`, { data: { patient_notes: 'x' } });
    expect(pn.status()).toBe(403);

    const moved = await desk.ctx.put(`/api/v1/sessions/${therapistSession}`, { data: { scheduled_at: `${day}T10:30:00+05:30` } });
    expect(moved.status(), await moved.text()).toBe(200);

    const kept = await (await therapist.ctx.get(`/api/v1/sessions/${therapistSession}`)).json();
    expect(kept.crisis_detected).toBe(true);
    expect(kept.crisis_level).toBe('high');
    expect(kept.progress_notes).toBe('Progress');
    expect(kept.patient_notes).toBe('Homework: diary');
  });

  test('books a session, records a desk payment, marks a no-show and sets an outcome', async () => {
    const refused = await desk.ctx.post('/api/v1/sessions/', {
      data: { patient_id: patient.id, scheduled_at: `${day}T15:00:00+05:30`, session_notes: 'clinical' },
    });
    expect(refused.status(), await refused.text()).toBe(403);

    const booked = await desk.ctx.post('/api/v1/sessions/', {
      data: { patient_id: patient.id, scheduled_at: `${day}T15:00:00+05:30`, session_notes: '' },
    });
    expect(booked.status(), await booked.text()).toBe(200);
    const session = await booked.json();
    expect(session.status).toBe('scheduled');

    const paid = await desk.ctx.post(`/api/v1/sessions/${session.id}/payments`, { data: { amount_paise: 80000, method: 'cash' } });
    expect(paid.status(), await paid.text()).toBe(200);
    expect(await paid.json()).toMatchObject({ amount_paise: 80000, method: 'cash', status: 'paid' });

    const noShow = await desk.ctx.post(`/api/v1/sessions/${session.id}/no-show`, { data: { reason: 'did not come' } });
    expect(noShow.status(), await noShow.text()).toBe(200);
    expect((await noShow.json()).status).toBe('no_show');

    const outcome = await desk.ctx.put(`/api/v1/sessions/${adminSession}/outcome`, { data: { outcome: 'cancel_patient' } });
    expect(outcome.status(), await outcome.text()).toBe(200);
    expect(await outcome.json()).toMatchObject({ outcome: 'cancel_patient', status: 'cancelled' });
  });

  test("the desk's daily and weekly schedule is clinic-wide; a therapist still sees only their own", async () => {
    const daily = await desk.ctx.get('/api/v1/schedules/daily', { params: { schedule_date: day } });
    expect(daily.status(), await daily.text()).toBe(200);
    const deskDay = await daily.json();
    expect(deskDay.viewScope).toBe('all');
    const deskIds = deskDay.sessions.map((s: { id: string }) => s.id);
    expect(deskIds).toContain(therapistSession);
    expect(deskIds).toContain(adminSession);
    expect(deskDay.sessions.find((s: { id: string }) => s.id === therapistSession).therapistName).toBe('therapist Staff');

    const weekly = await desk.ctx.get('/api/v1/schedules/weekly', { params: { week_start: day } });
    expect(weekly.status(), await weekly.text()).toBe(200);
    expect((await weekly.json())[0].sessions.map((s: { id: string }) => s.id)).toContain(therapistSession);

    const own = await (await therapist.ctx.get('/api/v1/schedules/daily', { params: { schedule_date: day } })).json();
    expect(own.viewScope).toBe('personal');
    const ownIds = own.sessions.map((s: { id: string }) => s.id);
    expect(ownIds).toContain(therapistSession);
    expect(ownIds).not.toContain(adminSession);
  });

  test('no token is 401; another clinic is 403 / 404 for the desk', async ({ anon, api, auth }) => {
    for (const path of ['/api/v1/patients/', `/api/v1/sessions/${therapistSession}`, '/api/v1/schedules/daily']) {
      expect((await anon.get(path)).status(), path).toBe(401);
    }
    expect((await desk.ctx.get(`/api/v1/tenants/${auth.tenantId}`)).status()).toBe(403);
    const foreign = await api.post('/api/v1/patients/', { data: { first_name: uniq('Foreign'), last_name: 'Patient' } });
    expect(foreign.status(), await foreign.text()).toBe(200);
    const foreignId = (await foreign.json()).id;
    try {
      expect((await desk.ctx.get(`/api/v1/patients/${foreignId}`)).status()).toBe(404);
      expect((await desk.ctx.put(`/api/v1/patients/${foreignId}`, { data: { phone: '+919800000012' } })).status()).toBe(404);
    } finally {
      await api.delete(`/api/v1/patients/${foreignId}`);
    }
  });
});
