import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { env, DEMO_THERAPIST, DEMO_PATIENT } from '../src/env';

// The login response's `user` must carry what /auth/me returns (permissions, tenant_id, firm_code,
// timezone): the dashboard's Quick Actions filter on user.permissions, and the app keeps the login
// user until the next reload. Lists are app/core/permissions.py's role → permission map.
const ADMIN_PERMISSIONS = [
  'view_patients', 'create_patients', 'edit_patients', 'delete_patients', 'view_all_patients',
  'view_sessions', 'create_sessions', 'edit_sessions', 'delete_sessions', 'manage_sessions',
  'view_schedule', 'view_all_schedules', 'create_schedule', 'edit_schedule', 'manage_schedule',
  'use_ai_assistant', 'configure_ai', 'view_crisis_alerts', 'manage_crisis_detection',
  'view_analytics', 'access_analytics', 'export_data',
  'view_users', 'create_users', 'edit_users', 'delete_users',
  'view_organization_settings', 'edit_organization_settings', 'manage_tenants', 'system_admin', 'manage_billing',
];
const THERAPIST_PERMISSIONS = [
  'view_patients', 'create_patients', 'edit_patients', 'view_sessions', 'create_sessions', 'edit_sessions',
  'view_schedule', 'create_schedule', 'edit_schedule', 'use_ai_assistant', 'view_crisis_alerts',
];

test.describe('POST /auth/login user payload matches /auth/me', () => {
  requireApi();
  requireAuth();

  for (const [label, creds, role, permissions] of [
    ['ADMIN', { email: env.EMAIL, password: env.PASSWORD }, 'ADMIN', ADMIN_PERMISSIONS],
    ['THERAPIST', DEMO_THERAPIST, 'THERAPIST', THERAPIST_PERMISSIONS],
  ] as const) {
    test(`${label}: login carries permissions, tenant_id, firm_code and timezone`, async ({ anon }) => {
      const login = await anon.post('/api/v1/auth/login', { data: creds });
      expect(login.status(), await login.text()).toBe(200);
      const { access_token, user, tenant } = await login.json();

      expect(user.role).toBe(role);
      expect(user.permissions).toEqual(permissions);
      expect(user.tenant_id).toBe(tenant.id);
      expect(user.firm_code).toBe(tenant.firm_code);
      expect(user.timezone).toEqual(expect.stringMatching(/^[A-Za-z_]+\/[A-Za-z_]+/));

      const me = await anon.get('/api/v1/auth/me', { headers: { Authorization: `Bearer ${access_token}` } });
      expect(me.status()).toBe(200);
      expect(user).toEqual(await me.json());
    });
  }

  test('patient-audience login: PATIENT role, no staff permissions, same shape as /auth/me', async ({ anon }) => {
    const login = await anon.post('/api/v1/auth/login', { data: { ...DEMO_PATIENT, audience: 'patient' } });
    expect(login.status(), await login.text()).toBe(200);
    const { access_token, user, tenant } = await login.json();
    expect(user.role).toBe('PATIENT');
    expect(user.permissions).toEqual([]);
    expect(user.tenant_id).toBe(tenant.id);

    const me = await anon.get('/api/v1/auth/me', { headers: { Authorization: `Bearer ${access_token}` } });
    expect(me.status()).toBe(200);
    expect(user).toEqual(await me.json());
  });

  test('a patient-only account is refused at the staff login (403, no user payload)', async ({ anon }) => {
    const login = await anon.post('/api/v1/auth/login', { data: DEMO_PATIENT });
    expect(login.status()).toBe(403);
    const body = await login.json();
    expect(body.message).toBe('No staff access for this account');
    expect(body.user).toBeUndefined();
  });
});
