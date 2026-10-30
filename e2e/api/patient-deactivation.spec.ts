import { request as pwRequest } from '@playwright/test';
import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { env, uniq, DEMO_THERAPIST } from '../src/env';

/**
 * DELETE /patients/{id} deactivates: the patient leaves the active list (status inactive, is_active
 * false) and their future scheduled sessions are cancelled so the therapist's slots free up.
 * Past and finished sessions are history and stay as they were.
 */
test.describe('/api/v1/patients DELETE (deactivate)', () => {
  requireApi();
  requireAuth();

  test('cancels future scheduled sessions, leaves past ones, drops the patient from the active list', async ({ api }) => {
    const created = await api.post('/api/v1/patients/', { data: { first_name: uniq('Deact'), last_name: 'Patient' } });
    expect(created.status(), await created.text()).toBe(200);
    const patient = await created.json();
    const book = async (hoursAhead: number) => {
      const res = await api.post('/api/v1/sessions/', {
        data: { patient_id: patient.id, scheduled_at: new Date(Date.now() + hoursAhead * 3_600_000).toISOString() },
      });
      expect(res.status(), await res.text()).toBe(200);
      return (await res.json()).id as string;
    };
    const session = async (id: string) => (await (await api.get(`/api/v1/sessions/${id}`)).json());

    const future = await book(48);
    // past, still scheduled: booked ahead, then moved to two hours ago (too recent for the no-show sweep)
    const past = await book(24);
    const moved = await api.put(`/api/v1/sessions/${past}`, { data: { scheduled_at: new Date(Date.now() - 2 * 3_600_000).toISOString() } });
    expect(moved.status(), await moved.text()).toBe(200);
    // finished
    const done = await book(72);
    expect((await api.post(`/api/v1/sessions/${done}/start`)).status()).toBe(200);
    expect((await api.post(`/api/v1/sessions/${done}/complete`)).status()).toBe(200);
    const doneBefore = await session(done);

    try {
      const del = await api.delete(`/api/v1/patients/${patient.id}`);
      expect(del.status(), await del.text()).toBe(200);
      expect(await del.json()).toEqual({ message: 'Patient record has been deactivated', cancelled_sessions: 1 });

      const f = await session(future);
      expect(f.status).toBe('cancelled');
      expect(f.session_notes).toBe('Cancelled: patient deactivated');

      const p = await session(past);
      expect(p.status).toBe('scheduled');
      expect(p.session_notes).toBeNull();

      const d = await session(done);
      expect(d.status).toBe('completed');
      expect(d.session_notes).toBe(doneBefore.session_notes);

      const read = await api.get(`/api/v1/patients/${patient.id}`);
      expect(read.status()).toBe(200);
      expect((await read.json()).status).toBe('inactive');

      const active = (await (await api.get('/api/v1/patients/?limit=1000')).json()).patients.map((x: { id: string }) => x.id);
      expect(active).not.toContain(patient.id);
      const all = (await (await api.get('/api/v1/patients/?include_inactive=true&limit=1000')).json()).patients;
      expect(all.find((x: { id: string }) => x.id === patient.id)?.status).toBe('inactive');

      // deactivating again cancels nothing more
      const again = await api.delete(`/api/v1/patients/${patient.id}`);
      expect(again.status()).toBe(200);
      expect(await again.json()).toEqual({ message: 'Patient record has been deactivated', cancelled_sessions: 0 });
    } finally {
      await api.delete(`/api/v1/patients/${patient.id}`);
    }
  });

  test('a THERAPIST cannot deactivate a patient (403) and nothing is cancelled', async ({ api }) => {
    const anon = await pwRequest.newContext({ baseURL: env.API_URL });
    const login = await anon.post('/api/v1/auth/login', { data: { ...DEMO_THERAPIST, audience: 'staff' } });
    expect(login.status(), await login.text()).toBe(200);
    const { access_token, tenant, user } = await login.json();
    await anon.dispose();
    const therapist = await pwRequest.newContext({
      baseURL: env.API_URL,
      extraHTTPHeaders: { Authorization: `Bearer ${access_token}`, 'X-Tenant-ID': tenant.id },
    });

    const patient = await (await api.post('/api/v1/patients/', {
      data: { first_name: uniq('Deact'), last_name: 'Kept' },
    })).json();
    try {
      // assigned to them, so the 403 is the role rule, not "not your patient"
      const assigned = await api.put(`/api/v1/patients/${patient.id}`, { data: { assigned_therapist_id: user.id } });
      expect(assigned.status(), await assigned.text()).toBe(200);
      const res = await api.post('/api/v1/sessions/', {
        data: { patient_id: patient.id, scheduled_at: new Date(Date.now() + 48 * 3_600_000).toISOString() },
      });
      expect(res.status(), await res.text()).toBe(200);
      const sessionId = (await res.json()).id;

      const del = await therapist.delete(`/api/v1/patients/${patient.id}`);
      expect(del.status(), await del.text()).toBe(403);
      expect(await del.json()).toEqual(expect.objectContaining({
        error: true, status_code: 403, message: 'Insufficient permissions. Required: delete_patients',
      }));

      expect((await (await api.get(`/api/v1/patients/${patient.id}`)).json()).status).toBe('active');
      expect((await (await api.get(`/api/v1/sessions/${sessionId}`)).json()).status).toBe('scheduled');
    } finally {
      await therapist.dispose();
      await api.delete(`/api/v1/patients/${patient.id}`);
    }
  });
});
