import { request as pwRequest, APIRequestContext } from '@playwright/test';
import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { env, uniq, RANDOM_UUID, DEMO_THERAPIST, DEMO_PSYCHOLOGIST, DEMO_PATIENT } from '../src/env';

/**
 * Which clinicians offer which service. Only an admin assigns them: a new service starts with nobody and
 * is not on the booking page until assigned. Public booking offers a clinician only for the services
 * they are linked to, and a service only while someone offers it.
 */

const TEST_PHONE = '+919876543210'; // VERIFICATION_TEST_PHONES: no phone.email round-trip

const dayAfterTomorrow = () => {
  const d = new Date();
  d.setDate(d.getDate() + 2);
  return d.toISOString().slice(0, 10);
};

async function login(creds: { email: string; password: string }, audience?: 'patient') {
  const anon = await pwRequest.newContext({ baseURL: env.API_URL });
  const res = await anon.post('/api/v1/auth/login', { data: audience ? { ...creds, audience } : creds });
  expect(res.status(), `login ${creds.email}: ${await res.text()}`).toBe(200);
  const body = await res.json();
  await anon.dispose();
  const ctx = await pwRequest.newContext({
    baseURL: env.API_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${body.access_token}`, 'X-Tenant-ID': body.tenant.id },
  });
  return { ctx, id: body.user.id as string };
}

async function createService(api: APIRequestContext) {
  const res = await api.post('/api/v1/catalog/services', {
    data: { name: uniq('Linked'), duration_minutes: 50, price: 0, currency: 'INR' },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).id as string;
}

test.describe('service ↔ clinician links', () => {
  requireApi();
  requireAuth();

  test('a new service starts with nobody; assigning clinicians drives public booking', async ({ api, anon, auth }) => {
    const therapist = await login(DEMO_THERAPIST);
    const psychologist = await login(DEMO_PSYCHOLOGIST);
    const serviceId = await createService(api);
    try {
      const initial = await api.get(`/api/v1/catalog/services/${serviceId}/clinicians`);
      expect(initial.status(), await initial.text()).toBe(200);
      expect(await initial.json()).toEqual({ service_id: serviceId, clinician_ids: [] });
      const unassigned = await (await anon.get(`/api/v1/public/booking/${auth.firmCode}`)).json();
      expect(unassigned.services.map((s: { id: string }) => s.id)).not.toContain(serviceId);

      const put = await api.put(`/api/v1/catalog/services/${serviceId}/clinicians`, { data: { clinician_ids: [therapist.id] } });
      expect(put.status(), await put.text()).toBe(200);
      expect(await put.json()).toEqual({ service_id: serviceId, clinician_ids: [therapist.id] });

      const info = await (await anon.get(`/api/v1/public/booking/${auth.firmCode}`)).json();
      expect(info.services.map((s: { id: string }) => s.id)).toContain(serviceId);
      const byId = new Map(info.practitioners.map((p: { id: string; service_ids: string[] }) => [p.id, p.service_ids]));
      expect(byId.get(therapist.id)).toContain(serviceId);
      expect(byId.get(psychologist.id) ?? []).not.toContain(serviceId);

      const date = dayAfterTomorrow();
      const slots = await anon.get(`/api/v1/public/booking/${auth.firmCode}/slots`, {
        params: { practitioner_id: psychologist.id, service_id: serviceId, date },
      });
      expect(slots.status(), await slots.text()).toBe(404);
      const booking = await anon.post(`/api/v1/public/booking/${auth.firmCode}`, {
        data: {
          service_id: serviceId,
          practitioner_id: psychologist.id,
          scheduled_at: `${date}T10:00:00+05:30`,
          patient: { first_name: 'Not', last_name: 'Offered', phone: TEST_PHONE },
        },
      });
      expect(booking.status(), await booking.text()).toBe(404);

      // nobody offers it any more → it leaves the booking page
      expect((await api.put(`/api/v1/catalog/services/${serviceId}/clinicians`, { data: { clinician_ids: [] } })).status()).toBe(200);
      const after = await (await anon.get(`/api/v1/public/booking/${auth.firmCode}`)).json();
      expect(after.services.map((s: { id: string }) => s.id)).not.toContain(serviceId);
    } finally {
      await therapist.ctx.dispose();
      await psychologist.ctx.dispose();
      await api.delete(`/api/v1/catalog/services/${serviceId}`);
    }
  });

  test('only clinicians of this clinic can be linked (422); unknown service → 404', async ({ api, auth }) => {
    const serviceId = await createService(api);
    try {
      for (const id of [auth.user!.id, RANDOM_UUID]) { // the admin is not a clinician; a random id is nobody
        const res = await api.put(`/api/v1/catalog/services/${serviceId}/clinicians`, { data: { clinician_ids: [id] } });
        expect(res.status(), await res.text()).toBe(422);
      }
      expect((await api.get(`/api/v1/catalog/services/${RANDOM_UUID}/clinicians`)).status()).toBe(404);
    } finally {
      await api.delete(`/api/v1/catalog/services/${serviceId}`);
    }
  });

  test('only admins and clinical directors change links; patients see nothing; no token → 401', async ({ api, anon }) => {
    const serviceId = await createService(api);
    const therapist = await login(DEMO_THERAPIST);
    const patient = await login(DEMO_PATIENT, 'patient');
    try {
      const path = `/api/v1/catalog/services/${serviceId}/clinicians`;
      expect((await therapist.ctx.put(path, { data: { clinician_ids: [therapist.id] } })).status()).toBe(403);
      expect((await patient.ctx.get(path)).status()).toBe(403);
      expect((await anon.get(path)).status()).toBe(401);
    } finally {
      await therapist.ctx.dispose();
      await patient.ctx.dispose();
      await api.delete(`/api/v1/catalog/services/${serviceId}`);
    }
  });
});
