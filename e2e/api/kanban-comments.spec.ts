import { request as pwRequest, APIRequestContext } from '@playwright/test';
import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { env, uniq, RANDOM_UUID, DEMO_THERAPIST } from '../src/env';

/**
 * Task comments: the task comes from the path (the body carries only content + mentions), and an @mention
 * notifies the mentioned staff member. Before: a body without task_id was a 422, and any mention was a 500
 * (the notification text read user["first_name"], which the JWT user does not carry).
 */
async function loginAs(creds: { email: string; password: string }) {
  const anon = await pwRequest.newContext({ baseURL: env.API_URL });
  const res = await anon.post('/api/v1/auth/login', { data: { ...creds, audience: 'staff' } });
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
});
