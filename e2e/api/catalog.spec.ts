import { request as pwRequest } from '@playwright/test';
import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { env, uniq, DEMO_THERAPIST } from '../src/env';

// What a clinic types into its catalog is shown on the public booking page and charged (price in rupees,
// charged in paise), so bad values must never be stored.
test.describe('/api/v1/catalog/services validation', () => {
  requireApi();
  requireAuth();

  const valid = () => ({ name: uniq('Service'), duration_minutes: 50, price: 1500.5 });

  test('a valid service is created with exactly what was sent', async ({ api }) => {
    const body = valid();
    const res = await api.post('/api/v1/catalog/services', { data: body });
    expect(res.status(), await res.text()).toBe(201);
    const created = await res.json();
    try {
      expect(created).toEqual(expect.objectContaining({ ...body, currency: 'INR', is_active: true }));
    } finally {
      await api.delete(`/api/v1/catalog/services/${created.id}`);
    }
  });

  const bad: [string, Record<string, unknown>][] = [
    ['blank name', { name: '   ' }],
    ['zero duration', { duration_minutes: 0 }],
    ['duration over 8 hours', { duration_minutes: 481 }],
    ['negative price', { price: -5 }],
    ['price below one paisa', { price: 1.234 }],
    ['lower-case currency', { currency: 'inr' }],
  ];
  for (const [label, override] of bad) {
    test(`${label} → 422, nothing stored`, async ({ api }) => {
      const body = { ...valid(), ...override };
      const res = await api.post('/api/v1/catalog/services', { data: body });
      expect(res.status(), await res.text()).toBe(422);
    });
  }

  test('an update is validated the same way (422)', async ({ api }) => {
    const created = await (await api.post('/api/v1/catalog/services', { data: valid() })).json();
    try {
      const res = await api.put(`/api/v1/catalog/services/${created.id}`, { data: { ...valid(), price: -1 } });
      expect(res.status(), await res.text()).toBe(422);
    } finally {
      await api.delete(`/api/v1/catalog/services/${created.id}`);
    }
  });

  test('a therapist cannot create services (403)', async ({ api, auth }) => {
    const login = await api.post('/api/v1/auth/login', { data: DEMO_THERAPIST });
    const therapist = await pwRequest.newContext({
      baseURL: env.API_URL,
      extraHTTPHeaders: { Authorization: `Bearer ${(await login.json()).access_token}`, 'X-Tenant-ID': auth.tenantId },
    });
    try {
      expect((await therapist.post('/api/v1/catalog/services', { data: valid() })).status()).toBe(403);
    } finally {
      await therapist.dispose();
    }
  });
});
