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

  test('GET /patients/stats counts the caller\'s own rows (clinic for admin, own patients for a therapist)', async ({ api }) => {
    const totals = async (ctx: APIRequestContext) => ({
      all: (await (await ctx.get('/api/v1/patients/?include_inactive=true&limit=1')).json()).total,
      active: (await (await ctx.get('/api/v1/patients/?limit=1')).json()).total,
      stats: await (await ctx.get('/api/v1/patients/stats')).json(),
    });

    const admin = await totals(api);
    expect(admin.stats.total_patients).toBe(admin.all);
    expect(admin.stats.active_patients).toBe(admin.active);
    const queue = await (await api.get('/api/v1/kanban/followups')).json();
    const flagged = new Set(queue.items.map((t: { related_patient_id: string | null }) => t.related_patient_id).filter(Boolean));
    expect(admin.stats.patients_needing_follow_up).toBe(flagged.size);

    const login = await api.post('/api/v1/auth/login', { data: DEMO_THERAPIST });
    const therapist = await pwRequest.newContext({
      baseURL: env.API_URL,
      extraHTTPHeaders: { Authorization: `Bearer ${(await login.json()).access_token}` },
    });
    try {
      const own = await totals(therapist);
      expect(own.stats.total_patients).toBe(own.all);
      expect(own.stats.active_patients).toBe(own.active);
      expect(own.stats.total_patients).toBeLessThan(admin.stats.total_patients);
    } finally {
      await therapist.dispose();
    }
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
