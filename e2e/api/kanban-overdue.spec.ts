import { request as pwRequest } from '@playwright/test';
import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { env, uniq, DEMO_PATIENT } from '../src/env';

/**
 * Overdue = due before today in the clinic's time zone, and not done or archived. A card due later
 * today is not overdue yet; a closed card never is. GET /kanban/dashboard/stats used to count every
 * non-done card past its due instant, archived ones included.
 */

/** UTC instant of 00:00 today in `timeZone`. */
const startOfToday = (timeZone: string, now = new Date()): Date => {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone }).format(now); // YYYY-MM-DD
  const wall = (d: Date) => {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      }).formatToParts(d).map((x) => [x.type, x.value]),
    );
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  };
  const naive = new Date(`${day}T00:00:00Z`);
  return new Date(naive.getTime() - (wall(naive) - naive.getTime()));
};

test.describe('/api/v1/kanban overdue', () => {
  requireApi();
  requireAuth();

  test('dashboard/stats counts only open cards due before today in clinic time', async ({ api }) => {
    const me = await (await api.get('/api/v1/auth/me')).json();
    const zone: string = me.timezone;
    expect(zone).toBeTruthy();
    const today = startOfToday(zone);
    const yesterday = new Date(today.getTime() - 60 * 60_000).toISOString(); // 23:00 yesterday, clinic time
    const laterToday = new Date(today.getTime() + 60_000).toISOString(); // 00:01 today: past, but today

    const board = await (await api.post('/api/v1/kanban/boards', { data: { name: uniq('Overdue Board') } })).json();
    try {
      const mk = async (status: string, due_date?: string) => {
        const res = await api.post('/api/v1/kanban/tasks', {
          data: { board_id: board.id, title: uniq(`Overdue ${status}`), status, due_date },
        });
        expect(res.status(), await res.text()).toBe(200);
      };
      await mk('todo', yesterday); // overdue
      await mk('in_progress', yesterday); // overdue too
      await mk('review', laterToday); // due today: not overdue
      await mk('done', yesterday);
      await mk('archived', yesterday);
      await mk('todo'); // no due date

      const res = await api.get('/api/v1/kanban/dashboard/stats', { params: { board_id: board.id } });
      expect(res.status(), await res.text()).toBe(200);
      const stats = await res.json();
      expect(stats.total_tasks).toBe(6);
      expect(stats.overdue_tasks).toBe(2);
    } finally {
      expect((await api.delete(`/api/v1/kanban/boards/${board.id}`)).status()).toBe(200);
    }
  });

  test('dashboard/stats needs a staff token', async ({ anon }) => {
    expect((await anon.get('/api/v1/kanban/dashboard/stats')).status()).toBe(401);

    const login = await anon.post('/api/v1/auth/login', { data: { ...DEMO_PATIENT, audience: 'patient' } });
    expect(login.status(), await login.text()).toBe(200);
    const body = await login.json();
    const patient = await pwRequest.newContext({
      baseURL: env.API_URL,
      extraHTTPHeaders: { Authorization: `Bearer ${body.access_token}`, 'X-Tenant-ID': body.tenant.id },
    });
    expect((await patient.get('/api/v1/kanban/dashboard/stats')).status()).toBe(403);
    await patient.dispose();
  });
});
