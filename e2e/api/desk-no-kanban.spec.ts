import { request as pwRequest, APIRequestContext } from '@playwright/test';
import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { env, uniq } from '../src/env';
import { E2E_CLINIC, deleteClinic } from '../src/clinics';

/**
 * The front desk (SUPPORT_STAFF) has no task boards: every /kanban route answers 403, because follow-up
 * cards are titled "Risk flag: <patient name>". /teams goes with it (it only serves the boards and the
 * Teams page). Clinicians and admins keep their access.
 */

const PASSWORD = 'Password123!';
const ALLOW_LISTED_PHONE = '+919876543211'; // VERIFICATION_TEST_PHONES: onboarding skips phone.email, logins count as verified
const REFUSED = /^Access denied\. Required roles: /;

type Who = { ctx: APIRequestContext; userId: string };

async function loginAs(email: string): Promise<Who> {
  const anon = await pwRequest.newContext({ baseURL: env.API_URL });
  const res = await anon.post('/api/v1/auth/login', { data: { email, password: PASSWORD } });
  const text = await res.text();
  await anon.dispose();
  expect(res.status(), `login as ${email}: ${text}`).toBe(200);
  const body = JSON.parse(text);
  const ctx = await pwRequest.newContext({
    baseURL: env.API_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${body.access_token}`, 'X-Tenant-ID': body.tenant.id },
  });
  return { ctx, userId: body.user.id };
}

test.describe('front desk (SUPPORT_STAFF) has no task boards', () => {
  requireApi();
  requireAuth();
  test.describe.configure({ mode: 'serial' });

  const slug = uniq('desknk').toLowerCase();
  const adminEmail = `admin.${slug}@example.com`;
  let admin: Who;
  let desk: Who;
  let therapist: Who;
  let boardId: string;
  let taskId: string;

  test.beforeAll(async () => {
    const anon = await pwRequest.newContext({ baseURL: env.API_URL });
    const member = (who: string, role: string) => ({
      email: `${who}.${slug}@example.com`, first_name: who, last_name: 'Staff', role, phone: ALLOW_LISTED_PHONE,
      temporary_password: PASSWORD, send_invitation: false,
      ...(role === 'THERAPIST' ? { license_number: `LIC-${slug}` } : {}),
    });
    const onboarded = await anon.post('/api/v1/onboarding/complete', {
      data: {
        organization: {
          name: `${E2E_CLINIC} ${slug}`, type: 'clinic', contact_email: `${slug}@example.com`, contact_phone: ALLOW_LISTED_PHONE,
          address_line1: '1 Road', city: 'Pune', state: 'MH', postal_code: '411001',
        },
        plan: { plan_type: 'basic', max_users: 5, max_patients: 100, max_sessions_per_month: 500 },
        admin: { email: adminEmail, password: PASSWORD, first_name: 'Desk', last_name: 'Admin', phone: ALLOW_LISTED_PHONE },
        admin_role: 'ADMIN',
        team_members: [member('desk', 'SUPPORT_STAFF'), member('therapist', 'THERAPIST')],
      },
    });
    expect(onboarded.status(), await onboarded.text()).toBe(200);
    await anon.dispose();
    admin = await loginAs(adminEmail);
    desk = await loginAs(`desk.${slug}@example.com`);
    therapist = await loginAs(`therapist.${slug}@example.com`);

    const board = await admin.ctx.post('/api/v1/kanban/boards', { data: { name: uniq('Desk Board') } });
    expect(board.status(), await board.text()).toBe(200);
    boardId = (await board.json()).id;
    const task = await admin.ctx.post('/api/v1/kanban/tasks', {
      data: { board_id: boardId, title: 'Risk flag: Desk Patient', status: 'todo' },
    });
    expect(task.status(), await task.text()).toBe(200);
    taskId = (await task.json()).id;
  });

  test.afterAll(async () => {
    await admin?.ctx.dispose();
    await desk?.ctx.dispose();
    await therapist?.ctx.dispose();
    await deleteClinic(adminEmail);
  });

  const deskRefused: Array<{ method: 'get' | 'post' | 'put'; path: string; data?: object }> = [
    { method: 'get', path: '/api/v1/kanban/boards' },
    { method: 'get', path: '/api/v1/kanban/tasks' },
    { method: 'get', path: '/api/v1/kanban/tasks/{task_id}' },
    { method: 'put', path: '/api/v1/kanban/tasks/{task_id}', data: { title: 'renamed by the desk' } },
    { method: 'post', path: '/api/v1/kanban/tasks/{task_id}/move', data: { status: 'done', position: 0 } },
    { method: 'get', path: '/api/v1/kanban/tasks/{task_id}/comments' },
    { method: 'get', path: '/api/v1/kanban/followups' },
    { method: 'post', path: '/api/v1/kanban/followups/sync' },
    { method: 'get', path: '/api/v1/kanban/notifications' },
    { method: 'post', path: '/api/v1/kanban/notifications/mark-all-read' },
    { method: 'get', path: '/api/v1/kanban/dashboard/stats' },
    { method: 'get', path: '/api/v1/teams/users' },
    { method: 'get', path: '/api/v1/teams/teams' },
  ];

  for (const { method, path, data } of deskRefused) {
    test(`desk: ${method.toUpperCase()} ${path} → 403`, async () => {
      const res = await desk.ctx[method](path.replace('{task_id}', taskId), data ? { data } : {});
      expect(res.status(), await res.text()).toBe(403);
      const body = await res.json();
      expect(body.message).toMatch(REFUSED);
      expect(JSON.stringify(body)).not.toContain('Risk flag');
    });
  }

  test('the desk changed nothing: the admin still reads the task as created', async () => {
    const res = await admin.ctx.get(`/api/v1/kanban/tasks/${taskId}`);
    expect(res.status(), await res.text()).toBe(200);
    expect(await res.json()).toMatchObject({ id: taskId, title: 'Risk flag: Desk Patient', status: 'todo' });
  });

  for (const who of ['admin', 'therapist'] as const) {
    test(`${who} still reads the clinic's board and its notifications (200)`, async () => {
      const ctx = (who === 'admin' ? admin : therapist).ctx;
      const boards = await ctx.get('/api/v1/kanban/boards');
      expect(boards.status(), await boards.text()).toBe(200);
      expect((await boards.json()).boards.map((b: { id: string }) => b.id)).toContain(boardId);
      const notifications = await ctx.get('/api/v1/kanban/notifications');
      expect(notifications.status(), await notifications.text()).toBe(200);
      expect(Array.isArray(await notifications.json())).toBe(true);
    });
  }

  test('no token → 401', async ({ anon }) => {
    expect((await anon.get('/api/v1/kanban/boards')).status()).toBe(401);
    expect((await anon.get('/api/v1/kanban/notifications')).status()).toBe(401);
  });
});
