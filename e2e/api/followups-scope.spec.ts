import { request as pwRequest, type APIRequestContext } from '@playwright/test';
import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { env, uniq, DEMO_THERAPIST, DEMO_PSYCHOLOGIST } from '../src/env';
import { bookSession } from '../src/sessions';

/**
 * Who sees a follow-up card. ADMIN and CLINICAL_DIRECTOR see the clinic's whole queue. PSYCHOLOGIST,
 * THERAPIST and INTERN see only cards for patients assigned to them or that they have sessions with.
 * One rule, on every path that returns a follow-up card or counts them. Another clinician's card is 404
 * (its existence is not revealed).
 *
 *   mine     assigned to the therapist, her session, flagged      → she sees it (assignment)
 *   seen     her session, flagged, then reassigned to the psych   → she sees it (session)
 *   theirs   assigned to the psychologist, his session, flagged   → she doesn't; he and the admin do
 */
type Ctx = { ctx: APIRequestContext; userId: string };
type Card = { id: string; related_patient_id: string };

async function login(creds: { email: string; password: string }): Promise<Ctx> {
  const anon = await pwRequest.newContext({ baseURL: env.API_URL });
  const res = await anon.post('/api/v1/auth/login', { data: { ...creds, audience: 'staff' } });
  const text = await res.text();
  await anon.dispose();
  expect(res.status(), `login as ${creds.email}: ${text}`).toBe(200);
  const body = JSON.parse(text);
  const ctx = await pwRequest.newContext({
    baseURL: env.API_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${body.access_token}`, 'X-Tenant-ID': body.tenant.id },
  });
  return { ctx, userId: body.user.id };
}

const ok = async <T>(res: Awaited<ReturnType<APIRequestContext['get']>>): Promise<T> => {
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
};

test.describe('follow-up cards are scoped to the clinician', () => {
  requireApi();
  requireAuth();

  let therapist: Ctx;
  let psych: Ctx;
  let tag: string;
  const patients: Record<'mine' | 'seen' | 'theirs', string> = { mine: '', seen: '', theirs: '' };
  const cards: Record<'mine' | 'seen' | 'theirs', string> = { mine: '', seen: '', theirs: '' };
  const sessions: Array<[APIRequestContext, string]> = [];
  let queue: string;

  test.beforeAll(async () => {
    therapist = await login(DEMO_THERAPIST);
    psych = await login(DEMO_PSYCHOLOGIST);
  });

  test.afterAll(async () => {
    await therapist.ctx.dispose();
    await psych.ctx.dispose();
  });

  test.beforeEach(async ({ api }) => {
    tag = uniq('Scope');
    sessions.length = 0;
    const setup = async (key: keyof typeof patients, owner: Ctx) => {
      const patient = await ok<{ id: string }>(await api.post('/api/v1/patients/', {
        data: { first_name: `${tag} ${key}`, last_name: 'Patient', assigned_therapist_id: owner.userId },
      }));
      patients[key] = patient.id;
      const booked = await bookSession(owner.ctx, {
        patient_id: patient.id, scheduled_at: new Date(Date.now() + 2 * 86_400_000).toISOString(), duration_minutes: 50,
      });
      const session = await ok<{ id: string }>(booked);
      sessions.push([owner.ctx, session.id]);
      await ok(await api.put(`/api/v1/sessions/${session.id}`, { data: { risk_flag: true, risk_level: 'high' } }));
    };
    await setup('mine', therapist);
    await setup('seen', therapist);
    await setup('theirs', psych);
    await ok(await api.put(`/api/v1/patients/${patients.seen}`, { data: { assigned_therapist_id: psych.userId } }));
    await ok(await api.post('/api/v1/kanban/followups/sync'));

    for (const key of Object.keys(patients) as Array<keyof typeof patients>) {
      const list = await ok<{ items: Card[] }>(await api.get('/api/v1/kanban/followups', { params: { related_patient_id: patients[key] } }));
      expect(list.items, `${key} has one card`).toHaveLength(1);
      cards[key] = list.items[0].id;
    }
    const boards = await ok<{ boards: Array<{ id: string; name: string }> }>(
      await api.get('/api/v1/kanban/boards', { params: { include_auto: 'true', per_page: 100 } }),
    );
    queue = boards.boards.find((b) => b.name === 'Follow-up queue')!.id;
  });

  test.afterEach(async ({ api }) => {
    for (const [ctx, id] of sessions) await ctx.post(`/api/v1/sessions/${id}/cancel`, { data: { reason: 'e2e cleanup' } });
    for (const id of Object.values(patients)) await api.delete(`/api/v1/patients/${id}`);
  });

  const ours = (ids: string[]) => ids.filter((id) => Object.values(cards).includes(id)).sort();
  const expected = (...keys: Array<keyof typeof cards>) => keys.map((k) => cards[k]).sort();

  test('GET /kanban/followups: list and reason counts', async ({ api }) => {
    const seenBy = async (ctx: APIRequestContext) => {
      const res = await ok<{ items: Card[]; total: number; by_reason: Record<string, number> }>(
        await ctx.get('/api/v1/kanban/followups', { params: { search: tag } }),
      );
      return { ids: ours(res.items.map((i) => i.id)), total: res.total, risk: res.by_reason.risk_flag };
    };
    expect(await seenBy(therapist.ctx)).toEqual({ ids: expected('mine', 'seen'), total: 2, risk: 2 });
    expect(await seenBy(psych.ctx)).toEqual({ ids: expected('seen', 'theirs'), total: 2, risk: 2 });
    expect(await seenBy(api)).toEqual({ ids: expected('mine', 'seen', 'theirs'), total: 3, risk: 3 });
  });

  test('GET /tasks, /boards/{id} and /boards/{id}/view on the queue board', async ({ api }) => {
    const tasks = await ok<{ tasks: Card[]; total: number }>(
      await therapist.ctx.get('/api/v1/kanban/tasks', { params: { board_id: queue, search: tag } }),
    );
    expect(ours(tasks.tasks.map((t) => t.id))).toEqual(expected('mine', 'seen'));
    expect(tasks.total).toBe(2);

    const board = await ok<{ tasks: Card[] }>(await therapist.ctx.get(`/api/v1/kanban/boards/${queue}`));
    expect(ours(board.tasks.map((t) => t.id))).toEqual(expected('mine', 'seen'));

    const view = await ok<{ cells: Array<{ total: number; tasks: Card[] }> }>(
      await therapist.ctx.get(`/api/v1/kanban/boards/${queue}/view`, { params: { search: tag } }),
    );
    expect(ours(view.cells.flatMap((c) => c.tasks.map((t) => t.id)))).toEqual(expected('mine', 'seen'));
    expect(view.cells.reduce((n, c) => n + c.total, 0)).toBe(2);

    const all = await ok<{ total: number }>(await api.get('/api/v1/kanban/tasks', { params: { board_id: queue, search: tag } }));
    expect(all.total).toBe(3);
  });

  test("another clinician's card is 404 on every card path; her own is 200", async () => {
    const t = therapist.ctx;
    const card = `/api/v1/kanban/tasks/${cards.theirs}`;
    expect((await t.get(card)).status()).toBe(404);
    expect((await t.put(card, { data: { title: 'not mine' } })).status()).toBe(404);
    expect((await t.post(`${card}/move`, { data: { status: 'in_progress', position: 0 } })).status()).toBe(404);
    expect((await t.get(`${card}/comments`)).status()).toBe(404);
    expect((await t.post(`${card}/comments`, { data: { content: 'not mine' } })).status()).toBe(404);
    expect((await t.delete(card)).status()).toBe(404);

    expect((await t.get(`/api/v1/kanban/tasks/${cards.mine}`)).status()).toBe(200);
    expect((await t.get(`/api/v1/kanban/tasks/${cards.seen}/comments`)).status()).toBe(200);
    expect((await psych.ctx.get(card)).status()).toBe(200);
  });

  test('dashboard/stats and the overview tile count only what the clinician can see', async ({ api }) => {
    const stats = await ok<{ total_tasks: number }>(await therapist.ctx.get('/api/v1/kanban/dashboard/stats', { params: { board_id: queue } }));
    const visible = await ok<{ total: number }>(await therapist.ctx.get('/api/v1/kanban/tasks', { params: { board_id: queue, per_page: 1 } }));
    expect(stats.total_tasks).toBe(visible.total);
    const clinic = await ok<{ total_tasks: number }>(await api.get('/api/v1/kanban/dashboard/stats', { params: { board_id: queue } }));
    expect(clinic.total_tasks).toBeGreaterThan(stats.total_tasks);

    // the tile counts distinct patients with an open follow-up card, over the cards she can see
    const patientsSeen = new Set<string>();
    for (let page = 1; ; page += 1) {
      const res = await ok<{ items: Card[]; total_pages: number }>(
        await therapist.ctx.get('/api/v1/kanban/followups', { params: { per_page: 100, page } }),
      );
      res.items.forEach((i) => patientsSeen.add(i.related_patient_id));
      if (page >= res.total_pages) break;
    }
    const tile = await ok<{ patients_needing_followup: number; scope: string }>(await therapist.ctx.get('/api/v1/analytics/overview'));
    expect(tile.scope).toBe('mine');
    expect(tile.patients_needing_followup).toBe(patientsSeen.size);
    expect(patientsSeen.has(patients.theirs)).toBe(false);
  });
});
