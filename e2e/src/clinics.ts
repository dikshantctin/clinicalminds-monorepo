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
    const login = await ctx.post('/api/v1/auth/login', { data: { email: adminEmail, password } });
    expect(login.status(), await login.text()).toBe(200);
    const { access_token, tenant } = await login.json();
    const res = await ctx.delete(`/api/v1/dev/tenants/${tenant.id}`, { headers: { Authorization: `Bearer ${access_token}` } });
    expect(res.status(), await res.text()).toBe(204);
  } finally {
    await ctx.dispose();
  }
}

/** On VERIFICATION_TEST_PHONES: onboarding skips phone.email and the account counts as verified. */
export const ALLOW_LISTED_PHONE = '+919876543211';
export const CLINIC_PASSWORD = 'Password123!';

type Role = 'ADMIN' | 'CLINICAL_DIRECTOR' | 'PSYCHOLOGIST' | 'THERAPIST' | 'INTERN' | 'SUPPORT_STAFF';

/**
 * Onboard a throwaway clinic (`E2E <slug>`) whose owner and team members can log in with CLINIC_PASSWORD.
 * Team members get the allow-listed phone, so they pass the verification gate. Delete it with deleteClinic(owner).
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
  const res = await anon.post('/api/v1/onboarding/complete', {
    data: {
      organization: {
        name: `${E2E_CLINIC} ${slug}`, type: 'clinic', contact_email: `${slug}@example.com`, contact_phone: ALLOW_LISTED_PHONE,
        address_line1: '1 Road', city: 'Pune', state: 'MH', postal_code: '411001',
      },
      plan: { plan_type: 'basic', max_users: 10, max_patients: 100, max_sessions_per_month: 500 },
      admin: { email: owner, password: CLINIC_PASSWORD, first_name: 'Owner', last_name: 'E2E', phone: ALLOW_LISTED_PHONE },
      admin_role: opts.ownerRole ?? 'ADMIN',
      team_members: (opts.team ?? []).map((m) => ({
        email: m.email, first_name: 'Team', last_name: m.role, role: m.role, phone: ALLOW_LISTED_PHONE,
        license_number: 'RCI-E2E',
        ...(m.invite ? { send_invitation: true } : { temporary_password: CLINIC_PASSWORD, send_invitation: false }),
      })),
    },
  });
  expect(res.status(), await res.text()).toBe(200);
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
