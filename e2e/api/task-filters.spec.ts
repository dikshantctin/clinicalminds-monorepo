import { request as pwRequest, APIRequestContext } from '@playwright/test';
import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { env, uniq, RANDOM_UUID, DEMO_PATIENT } from '../src/env';

/**
 * GET /kanban/tasks list filters: lists are repeated query keys (status=todo&status=review), exactly
 * as frontend/src/services/tasks.ts and teams.ts send them. Each count is exact over rows this spec owns.
 */

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

const total = async (api: APIRequestContext, query: string): Promise<number> => {
  const res = await api.get(`/api/v1/kanban/tasks?${query}`);
  const text = await res.text();
  expect(res.status(), `${query}: ${text}`).toBe(200);
  return JSON.parse(text).total;
};

test.describe('/api/v1/kanban/tasks filters', () => {
  requireApi();
  requireAuth();

  test('status, assigned_to_team and board_id filters return exact counts; team delete counts only open tasks', async ({ api }) => {
    const board = await (await api.post('/api/v1/kanban/boards', { data: { name: uniq('Filter Board') } })).json();
    const mkTeam = async () =>
      (await api.post('/api/v1/teams/teams', { data: { name: uniq('Filter Team'), team_type: 'CLINICAL', color: '#3B82F6' } })).json();
    const teamA = await mkTeam();
    const teamB = await mkTeam();
    const taskIds: string[] = [];
    const mkTask = async (status: string, team: string) => {
      const res = await api.post('/api/v1/kanban/tasks', {
        data: { board_id: board.id, title: uniq('Filter Task'), status, assigned_to_team: team },
      });
      expect(res.status(), await res.text()).toBe(200);
      const task = await res.json();
      taskIds.push(task.id);
      return task;
    };
    try {
      const a = [
        await mkTask('todo', teamA.id),
        await mkTask('todo', teamA.id),
        await mkTask('review', teamA.id),
        await mkTask('done', teamA.id),
        await mkTask('archived', teamA.id),
      ];
      await mkTask('in_progress', teamB.id);

      const b = `board_id=${board.id}`;
      expect(await total(api, b)).toBe(6);
      expect(await total(api, `${b}&status=done`)).toBe(1);
      expect(await total(api, `${b}&status=todo&status=review`)).toBe(3);
      expect(await total(api, `${b}&assigned_to_team=${teamA.id}`)).toBe(5);
      expect(await total(api, `${b}&assigned_to_team=${teamB.id}`)).toBe(1);
      expect(await total(api, `assigned_to_team=${teamA.id}&assigned_to_team=${teamB.id}`)).toBe(6);
      // what TeamsAPI.getTeamTasks asks for: the team's open cards
      expect(await total(api, `assigned_to_team=${teamA.id}&status=todo&status=in_progress&status=review`)).toBe(3);
      expect(await total(api, `assigned_to_team=${RANDOM_UUID}`)).toBe(0);
      expect((await api.get('/api/v1/kanban/tasks?status=nope')).status()).toBe(422);

      // open (todo/in_progress/review) cards block deletion; done and archived do not
      const blocked = await api.delete(`/api/v1/teams/teams/${teamA.id}`);
      expect(blocked.status(), await blocked.text()).toBe(400);
      expect(await blocked.text()).toContain('3 active tasks');
      for (const t of a.slice(0, 3)) {
        expect((await api.put(`/api/v1/kanban/tasks/${t.id}`, { data: { status: 'done' } })).status()).toBe(200);
      }
      const deleted = await api.delete(`/api/v1/teams/teams/${teamA.id}`);
      expect(deleted.status(), await deleted.text()).toBe(200);
    } finally {
      for (const id of taskIds) await api.delete(`/api/v1/kanban/tasks/${id}`);
      await api.delete(`/api/v1/kanban/boards/${board.id}`);
      await api.delete(`/api/v1/teams/teams/${teamA.id}`);
      await api.delete(`/api/v1/teams/teams/${teamB.id}`);
    }
  });

  test('PATIENT gets 403 on the task list', async () => {
    const patient = await loginAs(DEMO_PATIENT);
    try {
      const res = await patient.get('/api/v1/kanban/tasks?status=todo');
      expect(res.status(), await res.text()).toBe(403);
    } finally {
      await patient.dispose();
    }
  });
});

test.describe('/api/v1/teams/users (member and assignee picker)', () => {
  requireApi();
  requireAuth();

  test('lists staff only, never a PATIENT', async ({ api }) => {
    const res = await api.get('/api/v1/teams/users');
    expect(res.status(), await res.text()).toBe(200);
    const users: { email: string; role: string }[] = (await res.json()).users;
    expect(users.length).toBeGreaterThan(0);
    expect(users.filter((u) => u.role === 'PATIENT').map((u) => u.email)).toEqual([]);
    expect(users.map((u) => u.email)).not.toContain(DEMO_PATIENT.email);
  });
});
