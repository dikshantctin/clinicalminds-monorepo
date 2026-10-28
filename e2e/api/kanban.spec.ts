import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { uniq } from '../src/env';

test.describe('/api/v1/kanban', () => {
  requireApi();
  requireAuth();

  test('validates bodies (422 for board without name, task without board_id)', async ({ api }) => {
    expect((await api.post('/api/v1/kanban/boards', { data: {} })).status()).toBe(422);
    expect((await api.post('/api/v1/kanban/tasks', { data: { title: 'no board' } })).status()).toBe(422);
    expect((await api.post('/api/v1/kanban/tasks', { data: { title: 'bad status', board_id: '00000000-0000-4000-8000-000000000000', status: 'nope' } })).status()).toBe(422);
  });

  test('board → task → move → comment → update → delete', async ({ api }) => {
    const boardRes = await api.post('/api/v1/kanban/boards', {
      data: { name: uniq('Board'), description: 'e2e', columns: ['todo', 'in_progress', 'review', 'done'] },
    });
    expect(boardRes.status(), await boardRes.text()).toBe(200);
    const board = await boardRes.json();
    expect(board.columns).toEqual(['todo', 'in_progress', 'review', 'done']);

    try {
      const boards = await api.get('/api/v1/kanban/boards');
      expect(boards.status()).toBe(200);
      const boardsBody = await boards.json();
      const boardList = Array.isArray(boardsBody) ? boardsBody : boardsBody.boards;
      expect(boardList.map((b: { id: string }) => b.id)).toContain(board.id);

      const taskRes = await api.post('/api/v1/kanban/tasks', {
        data: { board_id: board.id, title: uniq('Task'), priority: 'high', task_type: 'clinical', status: 'todo', tags: ['e2e'] },
      });
      expect(taskRes.status(), await taskRes.text()).toBe(200);
      const task = await taskRes.json();
      expect(task).toEqual(expect.objectContaining({ id: expect.any(String), board_id: board.id, status: 'todo', priority: 'high' }));

      const moved = await api.post(`/api/v1/kanban/tasks/${task.id}/move`, { data: { status: 'in_progress', position: 0 } });
      expect(moved.status(), await moved.text()).toBe(200);
      expect((await api.get(`/api/v1/kanban/tasks/${task.id}`).then((r) => r.json())).status).toBe('in_progress');

      const comment = await api.post(`/api/v1/kanban/tasks/${task.id}/comments`, { data: { content: 'e2e comment' } });
      expect([200, 422], await comment.text()).toContain(comment.status());
      if (comment.ok()) {
        const comments = await api.get(`/api/v1/kanban/tasks/${task.id}/comments`);
        expect(comments.status()).toBe(200);
      }

      const updated = await api.put(`/api/v1/kanban/tasks/${task.id}`, { data: { priority: 'urgent', status: 'done' } });
      expect(updated.status(), await updated.text()).toBe(200);

      const listed = await api.get('/api/v1/kanban/tasks', { params: { board_id: board.id } });
      expect(listed.status()).toBe(200);

      const stats = await api.get('/api/v1/kanban/dashboard/stats');
      expect(stats.status()).toBe(200);

      const delTask = await api.delete(`/api/v1/kanban/tasks/${task.id}`);
      expect(delTask.status()).toBe(200);
      expect((await api.get(`/api/v1/kanban/tasks/${task.id}`)).status()).toBe(404);
    } finally {
      const delBoard = await api.delete(`/api/v1/kanban/boards/${board.id}`);
      expect(delBoard.status()).toBe(200);
    }
  });

  test('notifications endpoints respond', async ({ api }) => {
    const list = await api.get('/api/v1/kanban/notifications');
    expect(list.status()).toBe(200);
    const markAll = await api.post('/api/v1/kanban/notifications/mark-all-read');
    expect(markAll.status()).toBe(200);
  });
});
