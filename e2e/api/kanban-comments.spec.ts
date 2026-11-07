import { request as pwRequest, APIRequestContext } from '@playwright/test';
import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { env, uniq, RANDOM_UUID, DEMO_THERAPIST, DEMO_PATIENT } from '../src/env';

/**
 * Task comments: the task comes from the path (the body carries only content + mentions), and an @mention
 * notifies the mentioned staff member. Before: a body without task_id was a 422, and any mention was a 500
 * (the notification text read user["first_name"], which the JWT user does not carry).
 */
async function loginAs(creds: { email: string; password: string }) {
  const anon = await pwRequest.newContext({ baseURL: env.API_URL });
  // a patient logs in through the portal (audience "patient"); everyone else through the staff login
  const audience = creds === DEMO_PATIENT ? 'patient' : 'staff';
  const res = await anon.post('/api/v1/auth/login', { data: { ...creds, audience } });
  expect(res.status(), await res.text()).toBe(200);
  const body = await res.json();
  await anon.dispose();
  const ctx = await pwRequest.newContext({
    baseURL: env.API_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${body.access_token}`, 'X-Tenant-ID': body.tenant.id },
  });
  return { ctx, userId: body.user.id as string };
}

async function newTask(api: APIRequestContext): Promise<{ boardId: string; taskId: string }> {
  const board = await api.post('/api/v1/kanban/boards', { data: { name: uniq('Comments') } });
  expect(board.status(), await board.text()).toBe(200);
  const boardId = (await board.json()).id;
  const task = await api.post('/api/v1/kanban/tasks', { data: { board_id: boardId, title: uniq('Commented') } });
  expect(task.status(), await task.text()).toBe(200);
  return { boardId, taskId: (await task.json()).id };
}

test.describe('/api/v1/kanban/tasks/{id}/comments', () => {
  requireApi();
  requireAuth();

  test('a comment needs only content; it is listed on the task and counted', async ({ api, auth }) => {
    const { boardId, taskId } = await newTask(api);
    try {
      const res = await api.post(`/api/v1/kanban/tasks/${taskId}/comments`, { data: { content: 'first note' } });
      expect(res.status(), await res.text()).toBe(200);
      const comment = await res.json();
      expect(comment).toEqual(expect.objectContaining({ task_id: taskId, content: 'first note', author_id: auth.user?.id, mentions: [] }));

      const list = await (await api.get(`/api/v1/kanban/tasks/${taskId}/comments`)).json();
      expect(list.map((c: { id: string }) => c.id)).toEqual([comment.id]);
      expect((await (await api.get(`/api/v1/kanban/tasks/${taskId}`)).json()).comment_count).toBe(1);

      expect((await api.post(`/api/v1/kanban/tasks/${taskId}/comments`, { data: {} })).status()).toBe(422);
      expect((await api.post(`/api/v1/kanban/tasks/${RANDOM_UUID}/comments`, { data: { content: 'x' } })).status()).toBe(404);
    } finally {
      await api.delete(`/api/v1/kanban/boards/${boardId}?hard_delete=true`);
    }
  });

  test('an @mention notifies the mentioned staff member, named after the author; a self-mention notifies nobody', async ({ api, auth }) => {
    const therapist = await loginAs(DEMO_THERAPIST);
    const { boardId, taskId } = await newTask(api);
    try {
      const res = await api.post(`/api/v1/kanban/tasks/${taskId}/comments`, {
        data: { content: 'please review', mentions: [therapist.userId, auth.user?.id] },
      });
      expect(res.status(), await res.text()).toBe(200);

      const theirs = (await (await therapist.ctx.get('/api/v1/kanban/notifications')).json())
        .filter((n: { task_id: string; type: string }) => n.task_id === taskId && n.type === 'mentioned');
      expect(theirs).toHaveLength(1);
      expect(theirs[0].title).toBe('You were mentioned');
      expect(theirs[0].message).toMatch(/^Demo Admin mentioned you in a comment on task: /);

      const mine = (await (await api.get('/api/v1/kanban/notifications')).json())
        .filter((n: { task_id: string; type: string }) => n.task_id === taskId && n.type === 'mentioned');
      expect(mine).toHaveLength(0);
    } finally {
      await api.delete(`/api/v1/kanban/boards/${boardId}?hard_delete=true`);
      await therapist.ctx.dispose();
    }
  });

  test('mentioning someone who is not staff in this clinic → 400, nothing saved', async ({ api }) => {
    const { boardId, taskId } = await newTask(api);
    try {
      const res = await api.post(`/api/v1/kanban/tasks/${taskId}/comments`, { data: { content: 'hi', mentions: [RANDOM_UUID] } });
      expect(res.status()).toBe(400);
      expect((await res.json()).message).toBe('Mentioned users must be staff in this clinic');
      expect(await (await api.get(`/api/v1/kanban/tasks/${taskId}/comments`)).json()).toEqual([]);
    } finally {
      await api.delete(`/api/v1/kanban/boards/${boardId}?hard_delete=true`);
    }
  });

  test('task details name comment authors and activity actors; history is newest first; values are plain', async ({ api }) => {
    const { boardId, taskId } = await newTask(api);
    const secret = uniq('private detail');
    try {
      expect((await api.put(`/api/v1/kanban/tasks/${taskId}`, { data: { status: 'in_progress' } })).status()).toBe(200);
      expect((await api.put(`/api/v1/kanban/tasks/${taskId}`, { data: { description: secret } })).status()).toBe(200);
      const res = await api.post(`/api/v1/kanban/tasks/${taskId}/comments`, { data: { content: 'looks good' } });
      expect(res.status(), await res.text()).toBe(200);
      const comment = await res.json();
      expect(comment.author_name).toBe('Demo Admin');

      const list = await (await api.get(`/api/v1/kanban/tasks/${taskId}/comments`)).json();
      expect(list.map((c: { id: string; author_name: string }) => [c.id, c.author_name])).toEqual([[comment.id, 'Demo Admin']]);

      const detail = await (await api.get(`/api/v1/kanban/tasks/${taskId}`)).json();
      expect(detail.comments.map((c: { content: string; author_name: string }) => [c.content, c.author_name])).toEqual([
        ['looks good', 'Demo Admin'],
      ]);
      type Activity = { action: string; user_name: string; old_value: string | null; new_value: string | null };
      const activities: Activity[] = detail.recent_activities;
      expect(activities.map((a) => a.action)).toEqual(['commented', 'updated_description', 'updated_status', 'created']);
      expect(activities.map((a) => a.user_name)).toEqual(['Demo Admin', 'Demo Admin', 'Demo Admin', 'Demo Admin']);
      expect(activities[2]).toEqual(expect.objectContaining({ old_value: 'todo', new_value: 'in_progress' }));
      // a description may hold clinical detail: the history says it changed, never what it said
      expect(activities[1]).toEqual(expect.objectContaining({ old_value: null, new_value: null }));
      expect(JSON.stringify(activities)).not.toContain(secret);
    } finally {
      await api.delete(`/api/v1/kanban/boards/${boardId}?hard_delete=true`);
    }
  });

  test('task details return the 50 newest activities', async ({ api }) => {
    const { boardId, taskId } = await newTask(api);
    try {
      for (let i = 1; i <= 51; i++) {
        const res = await api.post(`/api/v1/kanban/tasks/${taskId}/comments`, { data: { content: `note ${i}` } });
        expect(res.status(), await res.text()).toBe(200);
      }
      const detail = await (await api.get(`/api/v1/kanban/tasks/${taskId}`)).json();
      expect(detail.comments).toHaveLength(51);
      expect(detail.recent_activities).toHaveLength(50);
      expect(detail.recent_activities[0].details.comment_preview).toBe('note 51');
      expect(detail.recent_activities[49].details.comment_preview).toBe('note 2'); // "note 1" and "created" fall off
    } finally {
      await api.delete(`/api/v1/kanban/boards/${boardId}?hard_delete=true`);
    }
  });

  test('empty content → 422, nothing saved', async ({ api }) => {
    const { boardId, taskId } = await newTask(api);
    try {
      expect((await api.post(`/api/v1/kanban/tasks/${taskId}/comments`, { data: { content: '' } })).status()).toBe(422);
      expect(await (await api.get(`/api/v1/kanban/tasks/${taskId}/comments`)).json()).toEqual([]);
    } finally {
      await api.delete(`/api/v1/kanban/boards/${boardId}?hard_delete=true`);
    }
  });

  test('no token → 401 and a PATIENT token → 403 on both comment routes', async ({ api, anon }) => {
    const { boardId, taskId } = await newTask(api);
    const patient = await loginAs(DEMO_PATIENT);
    const path = `/api/v1/kanban/tasks/${taskId}/comments`;
    try {
      expect((await anon.get(path)).status()).toBe(401);
      expect((await anon.post(path, { data: { content: 'x' } })).status()).toBe(401);
      expect((await patient.ctx.get(path)).status()).toBe(403);
      expect((await patient.ctx.post(path, { data: { content: 'x' } })).status()).toBe(403);
      expect(await (await api.get(path)).json()).toEqual([]);
    } finally {
      await api.delete(`/api/v1/kanban/boards/${boardId}?hard_delete=true`);
      await patient.ctx.dispose();
    }
  });
});
