import { request as pwRequest } from '@playwright/test';
import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { env, uniq, RANDOM_UUID, DEMO_THERAPIST } from '../src/env';

test.describe('/api/v1/sessions', () => {
  requireApi();
  requireAuth();

  test('validates the create body (422 without patient_id / scheduled_at)', async ({ api }) => {
    expect((await api.post('/api/v1/sessions/', { data: {} })).status()).toBe(422);
    expect((await api.post('/api/v1/sessions/', { data: { patient_id: 'x', scheduled_at: new Date().toISOString(), duration_minutes: 5 } })).status()).toBe(422);
  });

  test('a patient outside the clinic cannot be booked (404)', async ({ api }) => {
    const scheduled_at = new Date(Date.now() + 86_400_000).toISOString();
    for (const patient_id of [RANDOM_UUID, 'not-a-uuid']) {
      const res = await api.post('/api/v1/sessions/', { data: { patient_id, scheduled_at } });
      expect(res.status(), await res.text()).toBe(404);
    }
  });

  test('schedule a session for a patient, then read, list, start and complete it', async ({ api }) => {
    const patientRes = await api.post('/api/v1/patients/', { data: { first_name: uniq('Sess'), last_name: 'Patient' } });
    expect(patientRes.status(), await patientRes.text()).toBe(200);
    const patient = await patientRes.json();

    try {
      const scheduledAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
      const created = await api.post('/api/v1/sessions/', {
        data: { patient_id: patient.id, scheduled_at: scheduledAt, session_type: 'individual', treatment_modality: 'CBT', duration_minutes: 50 },
      });
      expect(created.status(), await created.text()).toBe(200);
      const session = await created.json();
      expect(session.id).toEqual(expect.any(String));

      const read = await api.get(`/api/v1/sessions/${session.id}`);
      expect(read.status()).toBe(200);
      expect(await read.json()).toEqual(expect.objectContaining({ id: session.id, patient_id: patient.id, status: 'scheduled', duration_minutes: 50 }));

      const list = await api.get('/api/v1/sessions/');
      expect(list.status()).toBe(200);
      const body = await list.json();
      expect(Array.isArray(body.sessions)).toBe(true);
      expect(typeof body.total).toBe('number');

      const started = await api.post(`/api/v1/sessions/${session.id}/start`);
      expect(started.status(), await started.text()).toBe(200);
      expect((await (await api.get(`/api/v1/sessions/${session.id}`)).json()).status).toBe('in_progress');
      expect((await api.post(`/api/v1/sessions/${session.id}/start`)).status(), 'cannot start twice').toBe(409);

      expect((await api.put(`/api/v1/sessions/${session.id}/patient-notes`, { data: { notes: 'e2e note' } })).status()).toBe(422);
      const notes = await api.put(`/api/v1/sessions/${session.id}/patient-notes`, { data: { patient_notes: 'e2e note' } });
      expect(notes.status(), await notes.text()).toBe(200);

      const completed = await api.post(`/api/v1/sessions/${session.id}/complete`);
      expect(completed.status(), await completed.text()).toBe(200);
      expect((await (await api.get(`/api/v1/sessions/${session.id}`)).json()).status).toBe('completed');
      expect((await api.post(`/api/v1/sessions/${session.id}/complete`)).status(), 'cannot complete twice').toBe(409);
    } finally {
      await api.delete(`/api/v1/patients/${patient.id}`);
    }
  });

  test('cancel: scheduled or in-progress only; no-show: scheduled only; both staff-only', async ({ api, anon }) => {
    const patient = await (await api.post('/api/v1/patients/', { data: { first_name: uniq('Trans'), last_name: 'Patient' } })).json();
    const mk = async () =>
      (await (await api.post('/api/v1/sessions/', { data: { patient_id: patient.id, scheduled_at: new Date(Date.now() + 3_600_000).toISOString() } })).json()).id;
    try {
      const a = await mk();
      expect((await anon.post(`/api/v1/sessions/${a}/cancel`)).status(), 'no token').toBe(401);
      expect((await api.post(`/api/v1/sessions/${a}/start`)).status()).toBe(200);
      expect((await api.post(`/api/v1/sessions/${a}/no-show`)).status(), 'no-show from in_progress').toBe(409);
      const cancelled = await api.post(`/api/v1/sessions/${a}/cancel`, { data: { reason: 'patient called' } });
      expect(cancelled.status(), await cancelled.text()).toBe(200);
      expect((await (await api.get(`/api/v1/sessions/${a}`)).json())).toEqual(expect.objectContaining({ status: 'cancelled' }));
      expect((await api.post(`/api/v1/sessions/${a}/cancel`)).status(), 'cancel twice').toBe(409);
      expect((await api.post(`/api/v1/sessions/${a}/start`)).status(), 'start a cancelled session').toBe(409);

      const b = await mk();
      expect((await api.post(`/api/v1/sessions/${b}/complete`)).status()).toBe(200);
      expect((await api.post(`/api/v1/sessions/${b}/no-show`)).status(), 'no-show a completed session').toBe(409);
      expect((await api.post(`/api/v1/sessions/${b}/cancel`)).status(), 'cancel a completed session').toBe(409);
      expect((await api.post(`/api/v1/sessions/00000000-0000-4000-8000-000000000000/cancel`)).status()).toBe(404);
    } finally {
      await api.delete(`/api/v1/patients/${patient.id}`);
    }
  });

  test('a clinician-set risk flag puts the patient on the follow-up queue; clearing it archives the card', async ({ api }) => {
    const patient = await (await api.post('/api/v1/patients/', { data: { first_name: uniq('Risk'), last_name: 'Patient' } })).json();
    try {
      const session = await (
        await api.post('/api/v1/sessions/', { data: { patient_id: patient.id, scheduled_at: new Date(Date.now() + 3_600_000).toISOString() } })
      ).json();
      expect((await api.put(`/api/v1/sessions/${session.id}`, { data: { risk_level: 'severe' } })).status()).toBe(422);

      const flagged = await api.put(`/api/v1/sessions/${session.id}`, { data: { risk_flag: true, risk_level: 'high', risk_notes: 'safety plan reviewed' } });
      expect(flagged.status(), await flagged.text()).toBe(200);
      const detail = await (await api.get(`/api/v1/sessions/${session.id}`)).json();
      expect(detail).toEqual(expect.objectContaining({ crisis_detected: true, crisis_level: 'high', crisis_notes: 'safety plan reviewed' }));
      const row = (await (await api.get('/api/v1/sessions/', { params: { patient_id: patient.id } })).json()).sessions.find((s: { id: string }) => s.id === session.id);
      expect(row.crisis_detected).toBe(true);

      await api.post('/api/v1/kanban/followups/sync');
      let queue = await (await api.get('/api/v1/kanban/followups')).json();
      const card = queue.items.find((t: { related_patient_id: string | null; reason: string }) => t.related_patient_id === patient.id && t.reason === 'risk_flag');
      expect(card, 'an urgent risk-flag card').toEqual(expect.objectContaining({ priority: 'urgent' }));

      expect((await api.put(`/api/v1/sessions/${session.id}`, { data: { risk_flag: false } })).status()).toBe(200);
      expect((await (await api.get(`/api/v1/sessions/${session.id}`)).json()).crisis_detected).toBe(false);
      await api.post('/api/v1/kanban/followups/sync');
      queue = await (await api.get('/api/v1/kanban/followups')).json();
      expect(queue.items.some((t: { related_patient_id: string | null; reason: string }) => t.related_patient_id === patient.id && t.reason === 'risk_flag')).toBe(false);
    } finally {
      await api.delete(`/api/v1/patients/${patient.id}`);
    }
  });
});

/** "YYYY-MM-DD" in the clinic's zone (platform_firms.timezone, default Asia/Kolkata). */
const istDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);

test.describe('/api/v1/sessions: offsets, paging, filters, edit', () => {
  requireApi();
  requireAuth();

  test('scheduled_at without a UTC offset is rejected (422) on create and update', async ({ api }) => {
    const patient = await (await api.post('/api/v1/patients/', { data: { first_name: uniq('Naive'), last_name: 'Patient' } })).json();
    try {
      const day = istDate(new Date(Date.now() + 2 * 86_400_000));
      const naive = await api.post('/api/v1/sessions/', { data: { patient_id: patient.id, scheduled_at: `${day}T10:00:00` } });
      expect(naive.status(), await naive.text()).toBe(422);
      expect(JSON.stringify(await naive.json())).toContain('scheduled_at must include a UTC offset');

      const ok = await api.post('/api/v1/sessions/', { data: { patient_id: patient.id, scheduled_at: `${day}T10:00:00+05:30` } });
      expect(ok.status(), await ok.text()).toBe(200);
      const session = await ok.json();
      expect(new Date(session.scheduled_at).toISOString()).toBe(new Date(`${day}T04:30:00Z`).toISOString());

      expect((await api.put(`/api/v1/sessions/${session.id}`, { data: { scheduled_at: `${day}T11:00:00` } })).status()).toBe(422);
    } finally {
      await api.delete(`/api/v1/patients/${patient.id}`);
    }
  });

  test('server paging: exact page sizes and a real total; search, type and date filters run in SQL', async ({ api }) => {
    const patient = await (await api.post('/api/v1/patients/', { data: { first_name: uniq('Page'), last_name: 'Patient' } })).json();
    try {
      const day = istDate(new Date(Date.now() + 4 * 86_400_000));
      // 00:30 IST is the previous UTC day: the date filter must use the clinic day
      for (const [hhmm, type] of [['00:30', 'individual'], ['10:00', 'Individual Therapy'], ['12:00', 'family']]) {
        const res = await api.post('/api/v1/sessions/', {
          data: { patient_id: patient.id, scheduled_at: `${day}T${hhmm}:00+05:30`, session_type: type },
        });
        expect(res.status(), await res.text()).toBe(200);
        expect((await res.json()).session_type, 'legacy labels are stored as the code').toBe(type === 'family' ? 'family' : 'individual');
      }
      expect((await api.post('/api/v1/sessions/', { data: { patient_id: patient.id, scheduled_at: `${day}T13:00:00+05:30`, session_type: 'yoga' } })).status()).toBe(422);

      const page1 = await (await api.get('/api/v1/sessions/', { params: { patient_id: patient.id, skip: 0, limit: 2 } })).json();
      expect(page1.sessions).toHaveLength(2);
      expect(page1.total).toBe(3);
      const page2 = await (await api.get('/api/v1/sessions/', { params: { patient_id: patient.id, skip: 2, limit: 2 } })).json();
      expect(page2.sessions).toHaveLength(1);
      expect(page2.total).toBe(3);

      const searched = await (await api.get('/api/v1/sessions/', { params: { search: patient.first_name, limit: 2 } })).json();
      expect(searched.total).toBe(3);
      expect(searched.sessions).toHaveLength(2);

      const typed = await (await api.get('/api/v1/sessions/', { params: { patient_id: patient.id, session_type: 'individual' } })).json();
      expect(typed.total).toBe(2);
      expect(typed.sessions.every((s: { session_type: string }) => s.session_type === 'individual')).toBe(true);
      expect((await api.get('/api/v1/sessions/', { params: { session_type: 'yoga' } })).status()).toBe(422);

      const dated = await api.get('/api/v1/sessions/', { params: { patient_id: patient.id, date_from: day, date_to: day } });
      expect(dated.status(), await dated.text()).toBe(200);
      expect((await dated.json()).total).toBe(3);
      const before = await (await api.get('/api/v1/sessions/', { params: { patient_id: patient.id, date_to: shift(day, -1) } })).json();
      expect(before.total).toBe(0);
      expect((await api.get('/api/v1/sessions/', { params: { date_from: 'yesterday' } })).status()).toBe(400);
    } finally {
      await api.delete(`/api/v1/patients/${patient.id}`);
    }
  });

  test('edit (reschedule + notes) is saved; a therapist cannot list, read or edit another clinician\'s session', async ({ api }) => {
    const patient = await (await api.post('/api/v1/patients/', { data: { first_name: uniq('Edit'), last_name: 'Patient' } })).json();
    const therapist = await loginTherapist();
    try {
      const day = istDate(new Date(Date.now() + 5 * 86_400_000));
      const session = await (await api.post('/api/v1/sessions/', { data: { patient_id: patient.id, scheduled_at: `${day}T10:00:00+05:30` } })).json();
      const moved = await api.put(`/api/v1/sessions/${session.id}`, { data: { scheduled_at: `${day}T15:30:00+05:30`, session_notes: 'moved by e2e' } });
      expect(moved.status(), await moved.text()).toBe(200);
      const detail = await (await api.get(`/api/v1/sessions/${session.id}`)).json();
      expect(new Date(detail.scheduled_at).toISOString()).toBe(new Date(`${day}T10:00:00Z`).toISOString());
      expect(detail).toEqual(expect.objectContaining({ session_notes: 'moved by e2e', patient_name: `${patient.first_name} Patient` }));
      expect(detail.therapist_name).toEqual(expect.any(String));

      const theirs = await (await therapist.get('/api/v1/sessions/', { params: { patient_id: patient.id } })).json();
      expect(theirs).toEqual(expect.objectContaining({ sessions: [], total: 0 }));
      expect((await therapist.get(`/api/v1/sessions/${session.id}`)).status()).toBe(403);
      expect((await therapist.put(`/api/v1/sessions/${session.id}`, { data: { session_notes: 'not mine' } })).status()).toBe(403);
    } finally {
      await therapist.dispose();
      await api.delete(`/api/v1/patients/${patient.id}`);
    }
  });
});

const shift = (ymd: string, days: number) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

async function loginTherapist() {
  const anon = await pwRequest.newContext({ baseURL: env.API_URL });
  const res = await anon.post('/api/v1/auth/login', { data: DEMO_THERAPIST });
  const body = await res.json();
  await anon.dispose();
  expect(res.status()).toBe(200);
  return pwRequest.newContext({
    baseURL: env.API_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${body.access_token}`, 'X-Tenant-ID': body.tenant.id },
  });
}
