import { request as pwRequest } from '@playwright/test';
import { expect } from './fixtures';
import { env } from './env';

/** Clinics the specs onboard are named `E2E <slug>`, so leftovers are easy to recognise. */
export const E2E_CLINIC = 'E2E';

/**
 * Delete a clinic the spec onboarded: log in as its admin, then call the backend's dev/test-only
 * DELETE /api/v1/dev/tenants/{id} (not mounted when ENVIRONMENT=production). Call it from afterAll.
 */
export async function deleteClinic(adminEmail: string, password = 'Password123!'): Promise<void> {
  const ctx = await pwRequest.newContext({ baseURL: env.API_URL });
  try {
    const login = await ctx.post('/api/v1/auth/login', { data: { email: adminEmail, password } });
    expect(login.status(), await login.text()).toBe(200);
    const { access_token, tenant } = await login.json();
    const res = await ctx.delete(`/api/v1/dev/tenants/${tenant.id}`, { headers: { Authorization: `Bearer ${access_token}` } });
    expect(res.status(), await res.text()).toBe(204);
  } finally {
    await ctx.dispose();
  }
}

export interface OwnClinic {
  api: import('@playwright/test').APIRequestContext;
  adminEmail: string;
  token: string;
  user: { id: string };
  tenantId: string;
  firmCode: string;
  serviceId: string;
  /** The team members asked for, in order: each signed in (same password as the admin). */
  members: OwnMember[];
}

export interface OwnMember {
  api: import('@playwright/test').APIRequestContext;
  email: string;
  token: string;
  user: { id: string };
}

/** A fresh clinic (Asia/Kolkata) whose CLINICAL_DIRECTOR admin is its one bookable clinician, with one free
 * 50-minute service and, optionally, team members with the given roles. For specs that change clinic-wide settings the demo clinic's other specs rely on. */
export async function onboardOwnClinic(prefix: string, team: string[] = []): Promise<OwnClinic> {
  const slug = `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toLowerCase();
  const phone = '+919876543211'; // VERIFICATION_TEST_PHONES: onboarding skips phone.email
  const adminEmail = `admin.${slug}@example.com`;
  const anon = await pwRequest.newContext({ baseURL: env.API_URL });
  try {
    const onboarded = await anon.post('/api/v1/onboarding/complete', {
      data: {
        organization: {
          name: `${E2E_CLINIC} ${slug}`, type: 'clinic', contact_email: `${slug}@example.com`, contact_phone: phone,
          address_line1: '1 MG Road', city: 'Pune', state: 'MH', postal_code: '411001',
        },
        plan: { plan_type: 'basic', max_users: 5, max_patients: 100, max_sessions_per_month: 500 },
        admin: { email: adminEmail, password: 'Password123!', first_name: 'Hema', last_name: 'Hours', phone },
        admin_role: 'CLINICAL_DIRECTOR',
        team_members: team.map((role, i) => ({
          email: `m${i}.${slug}@example.com`, first_name: 'Team', last_name: `Member ${i}`, role, phone, license_number: 'E2E-LIC-1',
          temporary_password: 'Password123!', send_invitation: false,
        })),
        timezone: 'Asia/Kolkata',
      },
    });
    expect(onboarded.status(), await onboarded.text()).toBe(200);
    const login = await anon.post('/api/v1/auth/login', { data: { email: adminEmail, password: 'Password123!' } });
    expect(login.status(), await login.text()).toBe(200);
    const { access_token, user, tenant } = await login.json();
    const api = await pwRequest.newContext({
      baseURL: env.API_URL,
      extraHTTPHeaders: { Authorization: `Bearer ${access_token}`, 'X-Tenant-ID': tenant.id },
    });
    const service = await api.post('/api/v1/catalog/services', {
      data: { name: 'Therapy', description: 'e2e', duration_minutes: 50, price: 0, currency: 'INR' },
    });
    expect(service.status(), await service.text()).toBe(201);
    const serviceId = (await service.json()).id;
    const linked = await api.put(`/api/v1/catalog/services/${serviceId}/clinicians`, { data: { clinician_ids: [user.id] } });
    expect(linked.status(), await linked.text()).toBe(200);
    const members: OwnMember[] = [];
    for (let i = 0; i < team.length; i++) {
      const email = `m${i}.${slug}@example.com`;
      const res = await anon.post('/api/v1/auth/login', { data: { email, password: 'Password123!' } });
      expect(res.status(), await res.text()).toBe(200);
      const m = await res.json();
      members.push({
        email, token: m.access_token, user: m.user,
        api: await pwRequest.newContext({
          baseURL: env.API_URL,
          extraHTTPHeaders: { Authorization: `Bearer ${m.access_token}`, 'X-Tenant-ID': m.tenant.id },
        }),
      });
    }
    return { api, adminEmail, token: access_token, user, tenantId: tenant.id, firmCode: tenant.firm_code, serviceId, members };
  } finally {
    await anon.dispose();
  }
}
