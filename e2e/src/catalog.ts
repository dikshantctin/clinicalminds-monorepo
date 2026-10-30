import { APIRequestContext, expect, request as pwRequest } from '@playwright/test';
import { env, DEMO_PSYCHOLOGIST, DEMO_THERAPIST } from './env';

/** The demo clinicians' user ids (via their own login). */
export async function demoClinicianIds(): Promise<string[]> {
  const anon = await pwRequest.newContext({ baseURL: env.API_URL });
  try {
    const ids: string[] = [];
    for (const creds of [DEMO_THERAPIST, DEMO_PSYCHOLOGIST]) {
      const res = await anon.post('/api/v1/auth/login', { data: creds });
      expect(res.status(), `login ${creds.email}`).toBe(200);
      ids.push((await res.json()).user.id);
    }
    return ids;
  } finally {
    await anon.dispose();
  }
}

/** Public booking offers a service only with the clinicians an admin assigned: give it the demo pair. */
export async function assignDemoClinicians(api: APIRequestContext, serviceId: string): Promise<void> {
  const res = await api.put(`/api/v1/catalog/services/${serviceId}/clinicians`, { data: { clinician_ids: await demoClinicianIds() } });
  expect(res.status(), await res.text()).toBe(200);
}

/** Create a service and make it bookable with the demo clinicians. */
export async function createBookableService(api: APIRequestContext, data: Record<string, unknown>) {
  const res = await api.post('/api/v1/catalog/services', { data });
  expect(res.status(), await res.text()).toBe(201);
  const service = await res.json();
  await assignDemoClinicians(api, service.id);
  return service;
}
