import { APIRequestContext, expect, request as pwRequest } from '@playwright/test';
import { env } from './env';

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
