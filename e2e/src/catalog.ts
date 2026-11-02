import { APIRequestContext, expect, request as pwRequest } from '@playwright/test';
import { env, DEMO_PSYCHOLOGIST, DEMO_THERAPIST } from './env';

export interface CatalogService {
  id: string;
  name: string;
  description: string | null;
  duration_minutes: number;
  price: number;
  currency: string;
  is_active: boolean;
}

/**
 * Creates a catalog service (what patients can book) and records it so `cleanupServices` removes it:
 * specs must not leave services behind in the shared clinic. `backend/scripts/deactivate_e2e_services.py`
 * deactivates what older runs left.
 */
export async function createService(
  api: APIRequestContext,
  created: string[],
  data: Partial<CatalogService> & { name: string },
): Promise<CatalogService> {
  const res = await api.post('/api/v1/catalog/services', {
    data: { description: 'e2e', duration_minutes: 50, price: 0, currency: 'INR', ...data },
  });
  expect(res.status(), await res.text()).toBe(201);
  const service: CatalogService = await res.json();
  created.push(service.id);
  return service;
}

/** Deletes the services recorded by `createService` (204, or 404 when the test already deleted it). */
export async function cleanupServices(api: APIRequestContext, created: string[]): Promise<void> {
  for (const id of created.splice(0)) {
    const res = await api.delete(`/api/v1/catalog/services/${id}`);
    expect([204, 404], `cleanup of service ${id}`).toContain(res.status());
  }
}

/** The E2E admin's API context outside a test (for `afterAll`, where the `api` fixture is unavailable). */
export const adminApi = (): Promise<APIRequestContext> =>
  pwRequest.newContext({
    baseURL: env.API_URL,
    extraHTTPHeaders: {
      Authorization: `Bearer ${process.env.E2E_TOKEN ?? ''}`,
      'X-Tenant-ID': process.env.E2E_TENANT_ID ?? '',
    },
  });

/** The demo clinicians' user ids (via their own login): [therapist Jane, psychologist Smith]. */
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
