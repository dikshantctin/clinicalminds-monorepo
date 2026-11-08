import { request as pwRequest, APIRequestContext } from '@playwright/test';
import { expect } from './fixtures';
import { env, uniq } from './env';

/** Clinics the specs onboard are named `E2E <slug>`, so leftovers are easy to recognise. */
export const E2E_CLINIC = 'E2E';

/**
 * Delete a clinic the spec onboarded: log in as its admin, then call the backend's dev/test-only
 * DELETE /api/v1/dev/tenants/{id} (not mounted when ENVIRONMENT=production). Call it from afterAll.
 */
export async function deleteClinic(adminEmail: string, password = 'Password123!'): Promise<void> {
  const ctx = await pwRequest.newContext({ baseURL: env.API_URL });
  try {
    const registrant = registrantOf.get(adminEmail) ?? adminEmail; // a re-roled director's clinic is deleted by its registrant
    const login = await ctx.post('/api/v1/auth/login', { data: { email: registrant, password } });
    expect(login.status(), await login.text()).toBe(200);
    const { access_token, tenant } = await login.json();
    const res = await ctx.delete(`/api/v1/dev/tenants/${tenant.id}`, { headers: { Authorization: `Bearer ${access_token}` } });
    expect(res.status(), await res.text()).toBe(204);
  } finally {
    await ctx.dispose();
  }
}

/** Director email → the ADMIN who registered its clinic (only a registrant may delete a clinic). */
const registrantOf = new Map<string, string>();

/**
 * Make `email` (a staff member with a verified phone, e.g. a team member from onboarding) the clinic's
 * CLINICAL_DIRECTOR, as its ADMIN `adminEmail` does in Settings. Onboarding makes only the registrant an ADMIN and
 * offers no director role, so specs that need a director (bookable, manages every role but ADMIN) use this.
 */
export async function makeDirector(adminEmail: string, email: string): Promise<void> {
  const admin = await loginAs(adminEmail);
  try {
    const staff = await (await admin.ctx.get(`/api/v1/tenants/${admin.tenant.id}/users`)).json();
    const id = staff.find((u: { email: string }) => u.email === email).id;
    const res = await admin.ctx.put(`/api/v1/tenants/${admin.tenant.id}/users/${id}/role`, { data: { role: 'CLINICAL_DIRECTOR' } });
    expect(res.status(), await res.text()).toBe(200);
    registrantOf.set(email, adminEmail);
  } finally {
    await admin.ctx.dispose();
  }
}

/** On VERIFICATION_TEST_PHONES: onboarding skips phone.email and the account counts as verified. */
export const ALLOW_LISTED_PHONE = '+919876543211';
export const CLINIC_PASSWORD = 'Password123!';

type Role = 'ADMIN' | 'CLINICAL_DIRECTOR' | 'PSYCHOLOGIST' | 'THERAPIST' | 'INTERN' | 'SUPPORT_STAFF';

/**
 * Onboard a throwaway clinic (`E2E <slug>`) whose owner and team members can log in with CLINIC_PASSWORD.
 * Team members get the allow-listed phone, so they pass the verification gate. Delete it with deleteClinic(owner).
 * The registrant is always the clinic's ADMIN; with ownerRole CLINICAL_DIRECTOR, `owner` is a verified team member
 * the registrant (`registrant.<slug>`) makes director, and the clinic has that ADMIN as well.
 */
export async function onboardClinic(
  anon: APIRequestContext,
  opts: {
    ownerRole?: 'ADMIN' | 'CLINICAL_DIRECTOR';
    /** invite: no temporary password, onboarding emails a set-password link instead */
    team?: { email: string; role: Exclude<Role, 'CLINICAL_DIRECTOR'>; invite?: boolean }[];
  } = {},
): Promise<{ owner: string; slug: string }> {
  const slug = uniq('clinic').toLowerCase();
  const owner = `owner.${slug}@example.com`;
  const director = opts.ownerRole === 'CLINICAL_DIRECTOR';
  const registrant = director ? `registrant.${slug}@example.com` : owner;
  const team = [
    ...(director ? [{ email: owner, role: 'PSYCHOLOGIST' as const }] : []),
    ...(opts.team ?? []),
  ];
  const res = await anon.post('/api/v1/onboarding/complete', {
    data: {
      organization: {
        name: `${E2E_CLINIC} ${slug}`, type: 'clinic', contact_email: `${slug}@example.com`, contact_phone: ALLOW_LISTED_PHONE,
        address_line1: '1 Road', city: 'Pune', state: 'MH', postal_code: '411001',
      },
      plan: { plan_type: 'basic', max_users: 10, max_patients: 100, max_sessions_per_month: 500 },
      admin: { email: registrant, password: CLINIC_PASSWORD, first_name: 'Owner', last_name: 'E2E', phone: ALLOW_LISTED_PHONE },
      admin_role: 'ADMIN',
      team_members: team.map((m: { email: string; role: string; invite?: boolean }) => ({
        email: m.email, first_name: 'Team', last_name: m.role, role: m.role, phone: ALLOW_LISTED_PHONE,
        license_number: 'RCI-E2E',
        ...(m.invite ? { send_invitation: true } : { temporary_password: CLINIC_PASSWORD, send_invitation: false }),
      })),
    },
  });
  expect(res.status(), await res.text()).toBe(200);
  if (director) await makeDirector(registrant, owner);
  return { owner, slug };
}

/** Log in (staff door) and return a request context that sends what the frontend sends, plus the login body. */
export async function loginAs(
  email: string,
  password = CLINIC_PASSWORD,
): Promise<{ ctx: APIRequestContext; user: { id: string; role: string; email_verified: boolean; phone_verified: boolean; permissions: string[] }; tenant: { id: string } }> {
  const anon = await pwRequest.newContext({ baseURL: env.API_URL });
  const res = await anon.post('/api/v1/auth/login', { data: { email, password } });
  const text = await res.text();
  await anon.dispose();
  expect(res.status(), `login as ${email}: ${text}`).toBe(200);
  const body = JSON.parse(text);
  const ctx = await pwRequest.newContext({
    baseURL: env.API_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${body.access_token}`, 'X-Tenant-ID': body.tenant.id },
  });
  return { ctx, user: body.user, tenant: body.tenant };
}

/** POST /tenants/{id}/invite (Settings → Users & Permissions → Invite staff). */
export const inviteStaff = (
  ctx: APIRequestContext,
  tenantId: string,
  data: { email: string; role: string; first_name?: string; last_name?: string },
) => ctx.post(`/api/v1/tenants/${tenantId}/invite`, { data: { first_name: 'Invited', last_name: 'Staff', ...data } });

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

/** A fresh clinic (Asia/Kolkata) whose CLINICAL_DIRECTOR is its one bookable clinician, with one free 50-minute
 * service and, optionally, team members with the given roles. For specs that change clinic-wide settings the demo
 * clinic's other specs rely on. The registrant (`adminEmail`) is the clinic's ADMIN, who is never bookable, so the
 * director joins as a verified team member and the ADMIN re-roles them; `api`/`token`/`user` act as the director. */
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
        admin_role: 'ADMIN',
        team_members: [
          {
            email: `director.${slug}@example.com`, first_name: 'Dee', last_name: 'Rector', role: 'PSYCHOLOGIST', phone, license_number: 'E2E-LIC-1',
            temporary_password: 'Password123!', send_invitation: false,
          },
          ...team.map((role, i) => ({
          email: `m${i}.${slug}@example.com`, first_name: 'Team', last_name: `Member ${i}`, role, phone, license_number: 'E2E-LIC-1',
          temporary_password: 'Password123!', send_invitation: false,
          })),
        ],
        timezone: 'Asia/Kolkata',
      },
    });
    expect(onboarded.status(), await onboarded.text()).toBe(200);
    const owner = await loginAs(adminEmail);
    const directorId = (await (await owner.ctx.get(`/api/v1/tenants/${owner.tenant.id}/users`)).json()).find(
      (u: { email: string }) => u.email === `director.${slug}@example.com`,
    ).id;
    const reRoled = await owner.ctx.put(`/api/v1/tenants/${owner.tenant.id}/users/${directorId}/role`, { data: { role: 'CLINICAL_DIRECTOR' } });
    expect(reRoled.status(), await reRoled.text()).toBe(200);
    await owner.ctx.dispose();
    const login = await anon.post('/api/v1/auth/login', { data: { email: `director.${slug}@example.com`, password: 'Password123!' } });
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
