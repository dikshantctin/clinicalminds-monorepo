import { test, expect, requireApi, requireAuth } from '../src/fixtures';

test.describe('/api/v1/tenants', () => {
  requireApi();
  requireAuth();

  test('GET /tenants/my-tenants includes the login tenant', async ({ api, auth }) => {
    const res = await api.get('/api/v1/tenants/my-tenants');
    expect(res.status()).toBe(200);
    const body = await res.json();
    const tenants = Array.isArray(body) ? body : body.tenants ?? [];
    expect(tenants.map((t: { id: string }) => t.id)).toContain(auth.tenantId);
  });

  test('own tenant details, features, users and branding are readable', async ({ api, auth }) => {
    for (const suffix of ['', '/features', '/users', '/branding']) {
      const res = await api.get(`/api/v1/tenants/${auth.tenantId}${suffix}`);
      expect(res.status(), `${suffix || '/'} → ${await res.text()}`).toBe(200);
    }
  });

  test('GET /tenants/{id}/usage and /billing are gone (they 500ed over an empty AI-cost table)', async ({ api, auth }) => {
    // No screen used them and the tenant_usage table they read is never written, so any number would be invented.
    expect((await api.get(`/api/v1/tenants/${auth.tenantId}/usage`)).status()).toBe(404);
    expect((await api.get(`/api/v1/tenants/${auth.tenantId}/billing`)).status()).toBe(404);
    // the rest of the tenant router is unaffected
    expect((await api.get(`/api/v1/tenants/${auth.tenantId}`)).status()).toBe(200);
  });

  test('PUT /tenants/{id}/branding stores the colour and GET reads it back', async ({ api, auth }) => {
    const before = await (await api.get(`/api/v1/tenants/${auth.tenantId}/branding`)).json();
    try {
      const put = await api.put(`/api/v1/tenants/${auth.tenantId}/branding`, { data: { primary_color: '#336699', organization_name: 'Branding e2e' } });
      expect(put.status(), await put.text()).toBe(200);
      const after = await (await api.get(`/api/v1/tenants/${auth.tenantId}/branding`)).json();
      expect(after).toEqual(expect.objectContaining({ primary_color: '#336699', organization_name: 'Branding e2e' }));
      expect((await api.put(`/api/v1/tenants/${auth.tenantId}/branding`, { data: { primary_color: 'blue' } })).status()).toBe(422);
    } finally {
      await api.put(`/api/v1/tenants/${auth.tenantId}/branding`, {
        data: { primary_color: before.primary_color ?? '#667eea', organization_name: before.organization_name ?? 'Demo Mental Health Clinic' },
      });
    }
  });

  test('schedule endpoints respond', async ({ api }) => {
    for (const path of ['/api/v1/schedules/daily', '/api/v1/schedules/weekly', '/api/v1/schedules/stats']) {
      const res = await api.get(path);
      expect(res.status(), path).toBe(200);
    }
  });

  test('catalog lists respond', async ({ api }) => {
    for (const path of ['/api/v1/catalog/services', '/api/v1/catalog/locations']) {
      const res = await api.get(path);
      expect(res.status(), path).toBe(200);
    }
  });
});
