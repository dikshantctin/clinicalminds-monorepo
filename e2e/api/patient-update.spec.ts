import { request as pwRequest } from '@playwright/test';
import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { env, uniq, RANDOM_UUID, DEMO_THERAPIST } from '../src/env';

/** PUT /patients/{id}: what the patient detail edit form sends. Each case used to 500 or be silently dropped. */
test.describe('PUT /api/v1/patients/{id}', () => {
  requireApi();
  requireAuth();

  test('status, date of birth, intake notes and record number round-trip exactly', async ({ api }) => {
    const created = await api.post('/api/v1/patients/', { data: { first_name: uniq('Edit'), last_name: 'Patient' } });
    const id: string = (await created.json()).id;
    try {
      const put = await api.put(`/api/v1/patients/${id}`, {
        data: { status: 'discharged', date_of_birth: '1990-05-15', intake_notes: 'Referred by GP', medical_record_number: 'MRN-0042', phone: '+919812345678' },
      });
      expect(put.status(), await put.text()).toBe(200);
      const read = await (await api.get(`/api/v1/patients/${id}`)).json();
      expect(read).toEqual(expect.objectContaining({
        status: 'discharged', date_of_birth: '1990-05-15', intake_notes: 'Referred by GP', medical_record_number: 'MRN-0042', phone: '+919812345678',
      }));
    } finally {
      await api.delete(`/api/v1/patients/${id}`);
    }
  });

  test('bad input is a 422, not a 500', async ({ api }) => {
    const created = await api.post('/api/v1/patients/', { data: { first_name: uniq('Bad'), last_name: 'Patient' } });
    const id: string = (await created.json()).id;
    try {
      for (const data of [{ status: 'bogus' }, { phone: '+91 98765 43210 ext 12345' }, { assigned_therapist_id: 'not-a-uuid' }, { first_name: '   ' }]) {
        const res = await api.put(`/api/v1/patients/${id}`, { data });
        expect(res.status(), JSON.stringify(data)).toBe(422);
      }
      const longPhone = await api.post('/api/v1/patients/', { data: { first_name: uniq('Long'), last_name: 'Phone', phone: '+91 98765 43210 ext 12345' } });
      expect(longPhone.status()).toBe(422);
    } finally {
      await api.delete(`/api/v1/patients/${id}`);
    }
  });

  test('unknown patient → 404; a therapist cannot edit a patient not assigned to them → 403', async ({ api }) => {
    expect((await api.put(`/api/v1/patients/${RANDOM_UUID}`, { data: { first_name: 'X' } })).status()).toBe(404);

    const created = await api.post('/api/v1/patients/', { data: { first_name: uniq('NotYours'), last_name: 'Patient' } });
    const id: string = (await created.json()).id;
    const anon = await pwRequest.newContext({ baseURL: env.API_URL });
    const login = await (await anon.post('/api/v1/auth/login', { data: { ...DEMO_THERAPIST, audience: 'staff' } })).json();
    const therapist = await pwRequest.newContext({
      baseURL: env.API_URL, extraHTTPHeaders: { Authorization: `Bearer ${login.access_token}`, 'X-Tenant-ID': login.tenant.id },
    });
    try {
      expect((await therapist.put(`/api/v1/patients/${id}`, { data: { first_name: 'Changed' } })).status()).toBe(403);
    } finally {
      await therapist.dispose();
      await anon.dispose();
      await api.delete(`/api/v1/patients/${id}`);
    }
  });
});
