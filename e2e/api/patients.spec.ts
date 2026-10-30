import { request as pwRequest, APIRequestContext } from '@playwright/test';
import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { env, uniq, RANDOM_UUID, DEMO_THERAPIST } from '../src/env';

test.describe('/api/v1/patients', () => {
  requireApi();
  requireAuth();

  test('validates the create body (422 when first/last name missing)', async ({ api }) => {
    expect((await api.post('/api/v1/patients/', { data: {} })).status()).toBe(422);
    expect((await api.post('/api/v1/patients/', { data: { first_name: 'Only' } })).status()).toBe(422);
  });

  test('create → read → list → update', async ({ api }) => {
    const first = uniq('E2E');
    const created = await api.post('/api/v1/patients/', {
      data: {
        first_name: first,
        last_name: 'Patient',
        gender: 'female',
        email: `${first.toLowerCase()}@example.com`,
        primary_diagnosis: 'Generalized Anxiety Disorder',
        intake_notes: 'Created by the e2e suite',
      },
    });
    expect(created.status(), await created.text()).toBe(200);
    const patient = await created.json();
    expect(patient).toEqual(expect.objectContaining({ id: expect.any(String), first_name: first, last_name: 'Patient' }));

    try {
      const read = await api.get(`/api/v1/patients/${patient.id}`);
      expect(read.status()).toBe(200);
      expect((await read.json()).id).toBe(patient.id);

      const list = await api.get('/api/v1/patients/');
      expect(list.status()).toBe(200);
      const body = await list.json();
      expect(Array.isArray(body.patients)).toBe(true);
      expect(typeof body.total).toBe('number');
      expect(body.patients.map((p: { id: string }) => p.id)).toContain(patient.id);

      const updated = await api.put(`/api/v1/patients/${patient.id}`, { data: { primary_diagnosis: 'Major Depressive Disorder' } });
      expect(updated.status(), await updated.text()).toBe(200);

      const sessions = await api.get(`/api/v1/patients/${patient.id}/sessions`);
      expect(sessions.status()).toBe(200);
    } finally {
      await api.delete(`/api/v1/patients/${patient.id}`);
    }
  });

  test('DELETE /patients/{id} soft-deletes (admin)', async ({ api }) => {
    const created = await api.post('/api/v1/patients/', { data: { first_name: uniq('Del'), last_name: 'Patient' } });
    const patient = await created.json();
    const del = await api.delete(`/api/v1/patients/${patient.id}`);
    expect(del.status(), await del.text()).toBe(200);
    expect((await del.json()).message).toMatch(/deactivated/);
  });

  test('GET /patients/stats counts the caller\'s own rows (clinic for admin, own patients for a therapist)', async ({ anon }) => {
    // A clinic of its own: in the demo clinic other workers add and deactivate patients between the
    // stats read and the list reads, so only a private clinic gives exact, repeatable numbers.
    const slug = uniq('stats').toLowerCase();
    const phone = '+919876543211'; // VERIFICATION_TEST_PHONES: onboarding skips phone.email, logins count as verified
    const onboarded = await anon.post('/api/v1/onboarding/complete', {
      data: {
        organization: {
          name: `Stats ${slug}`, type: 'clinic', contact_email: `${slug}@example.com`, contact_phone: phone,
          address_line1: '1 Road', city: 'Pune', state: 'MH', postal_code: '411001',
        },
        plan: { plan_type: 'basic', max_users: 5, max_patients: 100, max_sessions_per_month: 500 },
        admin: { email: `admin.${slug}@example.com`, password: 'Password123!', first_name: 'Stats', last_name: 'Admin', phone },
        admin_role: 'ADMIN',
        team_members: [{
          email: `therapist.${slug}@example.com`, first_name: 'Stats', last_name: 'Therapist', role: 'THERAPIST', phone,
          license_number: 'LIC-E2E', temporary_password: 'Password123!', send_invitation: false,
        }],
      },
    });
    expect(onboarded.status(), await onboarded.text()).toBe(200);
    const as = async (email: string) => {
      const login = await anon.post('/api/v1/auth/login', { data: { email, password: 'Password123!' } });
      expect(login.status(), await login.text()).toBe(200);
      const body = await login.json();
      const ctx = await pwRequest.newContext({ baseURL: env.API_URL, extraHTTPHeaders: { Authorization: `Bearer ${body.access_token}` } });
      return { ctx, id: body.user.id as string };
    };
    const admin = await as(`admin.${slug}@example.com`);
    const therapist = await as(`therapist.${slug}@example.com`);
    const totals = async (ctx: APIRequestContext) => {
      const queue = await (await ctx.get('/api/v1/kanban/followups')).json();
      return {
        all: (await (await ctx.get('/api/v1/patients/?include_inactive=true&limit=1')).json()).total,
        active: (await (await ctx.get('/api/v1/patients/?limit=1')).json()).total,
        flagged: new Set(queue.items.map((t: { related_patient_id: string | null }) => t.related_patient_id).filter(Boolean)).size,
        stats: await (await ctx.get('/api/v1/patients/stats')).json(),
      };
    };
    try {
      // the therapist's: one active with a missed session (a follow-up card), one deactivated; plus one unassigned
      const create = async (first: string, assigned: boolean) => {
        const res = await admin.ctx.post('/api/v1/patients/', {
          data: { first_name: first, last_name: 'Patient', ...(assigned ? { assigned_therapist_id: therapist.id } : {}) },
        });
        expect(res.status(), await res.text()).toBe(200);
        return (await res.json()).id as string;
      };
      const missed = await create('Missed', true);
      const gone = await create('Gone', true);
      await create('Unassigned', false);
      expect((await admin.ctx.delete(`/api/v1/patients/${gone}`)).status()).toBe(200);
      const session = await (await admin.ctx.post('/api/v1/sessions/', {
        data: { patient_id: missed, scheduled_at: new Date(Date.now() + 86_400_000).toISOString() },
      })).json();
      // move it into the past (create refuses past times; update does not) so the sync files a missed-session card
      expect((await admin.ctx.put(`/api/v1/sessions/${session.id}`, { data: { scheduled_at: new Date(Date.now() - 3 * 3_600_000).toISOString() } })).status()).toBe(200);
      expect((await admin.ctx.post('/api/v1/kanban/followups/sync')).status()).toBe(200);

      const clinic = await totals(admin.ctx);
      expect(clinic.stats).toEqual(expect.objectContaining({ total_patients: 3, active_patients: 2, patients_needing_follow_up: 1 }));
      expect([clinic.all, clinic.active, clinic.flagged]).toEqual([3, 2, 1]);

      const own = await totals(therapist.ctx);
      expect(own.stats).toEqual(expect.objectContaining({ total_patients: 2, active_patients: 1, patients_needing_follow_up: 1 }));
      expect([own.all, own.active]).toEqual([2, 1]);
    } finally {
      await admin.ctx.dispose();
      await therapist.ctx.dispose();
    }
  });

  test('GET /patients/{id}/assessments lists the patient\'s stored assessments, never a made-up score', async ({ api }) => {
    const created = await api.post('/api/v1/patients/', { data: { first_name: uniq('Assess'), last_name: 'Patient' } });
    expect(created.status(), await created.text()).toBe(200);
    const patient = await created.json();
    try {
      const res = await api.get(`/api/v1/patients/${patient.id}/assessments`);
      expect(res.status(), await res.text()).toBe(200);
      expect(await res.json()).toEqual([]); // a new patient has none (it used to return a fixed PHQ-9 of 12)

      const login = await api.post('/api/v1/auth/login', { data: DEMO_THERAPIST });
      const therapist = await pwRequest.newContext({
        baseURL: env.API_URL,
        extraHTTPHeaders: { Authorization: `Bearer ${(await login.json()).access_token}` },
      });
      try {
        expect((await therapist.get(`/api/v1/patients/${patient.id}/assessments`)).status()).toBe(403); // not assigned
      } finally {
        await therapist.dispose();
      }
    } finally {
      await api.delete(`/api/v1/patients/${patient.id}`);
    }
  });

  test('GET /patients/{id}/assessments for an unknown patient → 404', async ({ api }) => {
    expect((await api.get(`/api/v1/patients/${RANDOM_UUID}/assessments`)).status()).toBe(404);
  });

  test('GET /patients/stats needs a token (401)', async ({ anon }) => {
    expect((await anon.get('/api/v1/patients/stats')).status()).toBe(401);
  });

  test('unknown patient id → 404', async ({ api }) => {
    const res = await api.get(`/api/v1/patients/${RANDOM_UUID}`);
    expect(res.status()).toBe(404);
    expect((await api.get('/api/v1/patients/not-a-uuid')).status()).toBe(404);
  });

  test('POST /patients/set-password rejects a bad invite token', async ({ anon }) => {
    const res = await anon.post('/api/v1/patients/set-password', { data: { token: 'bogus', password: 'password123' } });
    expect(res.status()).toBe(400);
  });
});
