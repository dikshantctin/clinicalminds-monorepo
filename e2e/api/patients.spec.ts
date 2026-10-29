import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { uniq, RANDOM_UUID } from '../src/env';

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

  test('GET /patients/stats returns counts', async ({ api }) => {
    const res = await api.get('/api/v1/patients/stats');
    expect(res.status()).toBe(200);
    expect(typeof (await res.json())).toBe('object');
  });

  test('unknown patient id → 404', async ({ api }) => {
    const res = await api.get(`/api/v1/patients/${RANDOM_UUID}`);
    expect(res.status()).toBe(404);
    expect((await api.get('/api/v1/patients/not-a-uuid')).status()).toBe(404);
  });

  test('POST /patients/set-password rejects a bad invite token', async ({ anon }) => {
    const res = await anon.post('/api/v1/patients/set-password', { data: { token: 'bogus', password: 'password123' } });
    expect([400, 422]).toContain(res.status());
  });
});
