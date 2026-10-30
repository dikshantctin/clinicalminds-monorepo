import { request as pwRequest, APIRequestContext } from '@playwright/test';
import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { env, uniq, RANDOM_UUID, DEMO_THERAPIST } from '../src/env';

/** Settings → Profile (GET/PUT /users/me) and Settings → Organization (PUT /tenants/{id}/organization). */

async function loginAs(creds: { email: string; password: string }): Promise<{ ctx: APIRequestContext; tenantId: string }> {
  const anon = await pwRequest.newContext({ baseURL: env.API_URL });
  const res = await anon.post('/api/v1/auth/login', { data: creds });
  const text = await res.text();
  await anon.dispose();
  expect(res.status(), `login as ${creds.email}: ${text}`).toBe(200);
  const body = JSON.parse(text);
  const ctx = await pwRequest.newContext({
    baseURL: env.API_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${body.access_token}`, 'X-Tenant-ID': body.tenant.id },
  });
  return { ctx, tenantId: body.tenant.id };
}

test.describe('settings: no token', () => {
  requireApi();

  test('GET/PUT /users/me and PUT /tenants/{id}/organization answer 401', async ({ anon }) => {
    expect((await anon.get('/api/v1/users/me')).status()).toBe(401);
    expect((await anon.put('/api/v1/users/me', { data: { first_name: 'X' } })).status()).toBe(401);
    expect((await anon.put(`/api/v1/tenants/${RANDOM_UUID}/organization`, { data: { organization_name: 'X' } })).status()).toBe(401);
  });
});

test.describe('settings: profile (/users/me)', () => {
  requireApi();
  requireAuth();

  test('a therapist edits their own profile and it survives a reload', async () => {
    const { ctx } = await loginAs(DEMO_THERAPIST);
    const before = await (await ctx.get('/api/v1/users/me')).json();
    expect(before).toEqual(expect.objectContaining({ email: DEMO_THERAPIST.email, role: 'THERAPIST' }));
    const license = uniq('LIC');
    try {
      const put = await ctx.put('/api/v1/users/me', {
        data: { first_name: 'Janet', last_name: before.last_name, license_number: license, specializations: ['CBT', 'Trauma'] },
      });
      expect(put.status(), await put.text()).toBe(200);
      expect(await put.json()).toEqual(expect.objectContaining({ first_name: 'Janet', license_number: license }));

      const after = await (await ctx.get('/api/v1/users/me')).json();
      expect(after).toEqual(
        expect.objectContaining({ first_name: 'Janet', last_name: before.last_name, license_number: license, specializations: ['CBT', 'Trauma'] }),
      );
      // the name login and /auth/me show comes from the same row
      expect(await (await ctx.get('/api/v1/auth/me')).json()).toEqual(expect.objectContaining({ first_name: 'Janet' }));

      expect((await ctx.put('/api/v1/users/me', { data: { first_name: '' } })).status()).toBe(422);
      expect((await ctx.put('/api/v1/users/me', { data: { email: 'someone.else@example.com' } })).status()).toBe(422);
    } finally {
      await ctx.put('/api/v1/users/me', {
        data: {
          first_name: before.first_name,
          last_name: before.last_name,
          license_number: before.license_number,
          specializations: before.specializations ?? [],
        },
      });
      await ctx.dispose();
    }
  });
});

test.describe('settings: organization (PUT /tenants/{id}/organization)', () => {
  requireApi();
  requireAuth();

  test('ADMIN saves the organization and GET /tenants/{id} reads it back', async ({ api, auth }) => {
    const before = await (await api.get(`/api/v1/tenants/${auth.tenantId}`)).json();
    const license = uniq('ORG');
    try {
      const put = await api.put(`/api/v1/tenants/${auth.tenantId}/organization`, {
        data: {
          organization_name: `${before.organization_name} e2e`,
          organization_type: 'clinic',
          address: '42 Settings Lane, Pune',
          contact_phone: '+919812345678',
          website: 'https://clinic.example.com',
          license_number: license,
        },
      });
      expect(put.status(), await put.text()).toBe(200);

      const after = await (await api.get(`/api/v1/tenants/${auth.tenantId}`)).json();
      expect(after).toEqual(
        expect.objectContaining({
          organization_name: `${before.organization_name} e2e`,
          organization_type: 'clinic',
          address_line1: '42 Settings Lane, Pune',
          contact_phone: '+919812345678',
          license_number: license,
        }),
      );
      expect(after.settings).toEqual(expect.objectContaining({ website: 'https://clinic.example.com' }));

      expect((await api.put(`/api/v1/tenants/${auth.tenantId}/organization`, { data: { organization_name: '' } })).status()).toBe(422);
    } finally {
      await api.put(`/api/v1/tenants/${auth.tenantId}/organization`, {
        data: {
          organization_name: before.organization_name,
          organization_type: before.organization_type,
          address: before.address_line1 ?? '',
          contact_phone: before.contact_phone ?? '',
          website: before.settings?.website ?? '',
          license_number: before.license_number ?? '',
        },
      });
    }
  });

  test('THERAPIST gets 403, and a foreign tenant id gets 403', async ({ api }) => {
    const { ctx, tenantId } = await loginAs(DEMO_THERAPIST);
    try {
      expect((await ctx.put(`/api/v1/tenants/${tenantId}/organization`, { data: { organization_name: 'hijacked' } })).status()).toBe(403);
    } finally {
      await ctx.dispose();
    }
    expect((await api.put(`/api/v1/tenants/${RANDOM_UUID}/organization`, { data: { organization_name: 'hijacked' } })).status()).toBe(403);
  });
});
