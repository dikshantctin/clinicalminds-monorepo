import { request as pwRequest, APIRequestContext } from '@playwright/test';
import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { env, uniq, RANDOM_UUID, DEMO_THERAPIST } from '../src/env';
import { cleanupServices, createService } from '../src/catalog';

/** /api/v1/catalog: services (what patients book) and locations, managed by ADMIN / CLINICAL_DIRECTOR. */

async function loginAs(creds: { email: string; password: string }): Promise<APIRequestContext> {
  const anon = await pwRequest.newContext({ baseURL: env.API_URL });
  const res = await anon.post('/api/v1/auth/login', { data: creds });
  const text = await res.text();
  await anon.dispose();
  expect(res.status(), `login as ${creds.email}: ${text}`).toBe(200);
  const body = JSON.parse(text);
  return pwRequest.newContext({
    baseURL: env.API_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${body.access_token}`, 'X-Tenant-ID': body.tenant.id },
  });
}

const created: string[] = [];

test.describe('catalog services', () => {
  requireApi();
  requireAuth();
  test.afterEach(async ({ api }) => cleanupServices(api, created));

  const invalid: Array<[string, Record<string, unknown>]> = [
    ['blank name', { name: '   ' }],
    ['zero duration', { duration_minutes: 0 }],
    ['negative duration', { duration_minutes: -30 }],
    ['duration under 15 minutes', { duration_minutes: 14 }],
    ['duration over 8 hours', { duration_minutes: 481 }],
    ['negative price', { price: -1 }],
    ['price with more than 2 decimals', { price: 10.555 }],
    ['lower-case currency', { currency: 'inr' }],
  ];
  for (const [label, patch] of invalid) {
    test(`POST with ${label} → 422`, async ({ api }) => {
      const res = await api.post('/api/v1/catalog/services', {
        data: { name: uniq('Invalid'), duration_minutes: 50, price: 100, currency: 'INR', ...patch },
      });
      expect(res.status(), await res.text()).toBe(422);
    });
  }

  test('PUT with a blank name or zero duration → 422; the service is unchanged', async ({ api }) => {
    const service = await createService(api, created, { name: uniq('Catalog put'), price: 1500.5 });
    for (const data of [{ name: '' }, { duration_minutes: 0 }, { price: -5 }]) {
      const res = await api.put(`/api/v1/catalog/services/${service.id}`, { data });
      expect(res.status(), JSON.stringify(data)).toBe(422);
    }
    const list = await (await api.get('/api/v1/catalog/services', { params: { search: service.name } })).json();
    expect(list.services).toEqual([expect.objectContaining({ id: service.id, name: service.name, duration_minutes: 50, price: 1500.5 })]);
  });

  test('create trims the name; a partial PUT edits only what it sends', async ({ api }) => {
    const name = uniq('Catalog edit');
    const service = await createService(api, created, { name: `  ${name}  `, price: 1200 });
    expect(service).toEqual(expect.objectContaining({ name, price: 1200, duration_minutes: 50, is_active: true }));
    const res = await api.put(`/api/v1/catalog/services/${service.id}`, { data: { price: 1499.99 } });
    expect(res.status(), await res.text()).toBe(200);
    expect(await res.json()).toEqual(expect.objectContaining({ id: service.id, name, price: 1499.99, duration_minutes: 50 }));
  });

  test('search + skip/limit page the list and report the total', async ({ api }) => {
    const prefix = uniq('Catalog page');
    for (const n of [1, 2, 3]) await createService(api, created, { name: `${prefix} ${n}` });
    const first = await api.get('/api/v1/catalog/services', { params: { search: prefix, skip: 0, limit: 2 } });
    expect(first.status(), await first.text()).toBe(200);
    const page1 = await first.json();
    expect(page1.total).toBe(3);
    expect(page1.services.map((s: { name: string }) => s.name)).toEqual([`${prefix} 1`, `${prefix} 2`]);
    const page2 = await (await api.get('/api/v1/catalog/services', { params: { search: prefix, skip: 2, limit: 2 } })).json();
    expect(page2.total).toBe(3);
    expect(page2.services.map((s: { name: string }) => s.name)).toEqual([`${prefix} 3`]);
  });

  test('a deactivated service leaves the public booking page; is_active filters the list', async ({ api, anon, auth }) => {
    const service = await createService(api, created, { name: uniq('Catalog deactivate') });
    const listed = async () =>
      ((await (await anon.get(`/api/v1/public/booking/${auth.firmCode}`)).json()).services as Array<{ id: string }>).some(
        (s) => s.id === service.id,
      );
    expect(await listed()).toBe(true);

    const res = await api.put(`/api/v1/catalog/services/${service.id}`, { data: { is_active: false } });
    expect(res.status(), await res.text()).toBe(200);
    expect((await res.json()).is_active).toBe(false);
    expect(await listed()).toBe(false);

    const inactive = await (await api.get('/api/v1/catalog/services', { params: { search: service.name, is_active: false } })).json();
    expect(inactive.total).toBe(1);
    const active = await (await api.get('/api/v1/catalog/services', { params: { search: service.name, is_active: true } })).json();
    expect(active.total).toBe(0);
  });

  test('DELETE removes the service (204); a second DELETE and an unknown id → 404', async ({ api }) => {
    const service = await createService(api, created, { name: uniq('Catalog delete') });
    expect((await api.delete(`/api/v1/catalog/services/${service.id}`)).status()).toBe(204);
    expect((await api.delete(`/api/v1/catalog/services/${service.id}`)).status()).toBe(404);
    expect((await api.delete(`/api/v1/catalog/services/${RANDOM_UUID}`)).status()).toBe(404);
    const list = await (await api.get('/api/v1/catalog/services', { params: { search: service.name } })).json();
    expect(list.total).toBe(0);
  });

  test('THERAPIST: create, edit and delete → 403', async ({ api }) => {
    const service = await createService(api, created, { name: uniq('Catalog therapist') });
    const therapist = await loginAs(DEMO_THERAPIST);
    try {
      expect((await therapist.post('/api/v1/catalog/services', { data: { name: 'x', duration_minutes: 50, price: 0 } })).status()).toBe(403);
      expect((await therapist.put(`/api/v1/catalog/services/${service.id}`, { data: { is_active: false } })).status()).toBe(403);
      expect((await therapist.delete(`/api/v1/catalog/services/${service.id}`)).status()).toBe(403);
      expect((await therapist.post('/api/v1/catalog/locations', { data: { name: 'x', location_type: 'in_person' } })).status()).toBe(403);
    } finally {
      await therapist.dispose();
    }
  });

  test('no token → 401', async ({ anon }) => {
    expect((await anon.get('/api/v1/catalog/services')).status()).toBe(401);
  });
});

test.describe('catalog locations', () => {
  requireApi();
  requireAuth();

  test('a structured address is stored and returned; edit, deactivate and delete work', async ({ api }) => {
    const name = uniq('Catalog room');
    const address = { line1: '12 MG Road', city: 'Bengaluru', state: 'Karnataka', postal_code: '560001', country: 'India' };
    const res = await api.post('/api/v1/catalog/locations', { data: { name, location_type: 'in_person', address } });
    expect(res.status(), await res.text()).toBe(201);
    const location = await res.json();
    try {
      expect(location).toEqual(expect.objectContaining({ name, location_type: 'in_person', address, is_active: true }));

      const put = await api.put(`/api/v1/catalog/locations/${location.id}`, {
        data: { address: { ...address, line1: '14 MG Road' }, is_active: false },
      });
      expect(put.status(), await put.text()).toBe(200);
      expect(await put.json()).toEqual(
        expect.objectContaining({ name, address: { ...address, line1: '14 MG Road' }, is_active: false }),
      );

      const list = await (await api.get('/api/v1/catalog/locations', { params: { search: name } })).json();
      expect(list.total).toBe(1);
      expect(list.locations[0]).toEqual(expect.objectContaining({ id: location.id, is_active: false }));
    } finally {
      expect((await api.delete(`/api/v1/catalog/locations/${location.id}`)).status()).toBe(204);
    }
    expect((await api.delete(`/api/v1/catalog/locations/${location.id}`)).status()).toBe(404);
  });

  test('blank name or an unknown type → 422', async ({ api }) => {
    for (const data of [{ name: ' ', location_type: 'in_person' }, { name: uniq('Room'), location_type: 'moon' }]) {
      const res = await api.post('/api/v1/catalog/locations', { data });
      expect(res.status(), JSON.stringify(data)).toBe(422);
    }
  });
});
