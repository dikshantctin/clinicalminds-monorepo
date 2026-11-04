import { request as pwRequest, type APIRequestContext } from '@playwright/test';
import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { env, uniq } from '../src/env';
import { E2E_CLINIC, deleteClinic } from '../src/clinics';

/**
 * Who sees a follow-up card. CLINICAL_DIRECTOR (and ADMIN) see the clinic's whole queue; PSYCHOLOGIST,
 * THERAPIST and INTERN only cards for patients assigned to them or that they have sessions with; other
 * staff none. One rule on every path that returns, counts or notifies about a follow-up card; another
 * clinician's card is 404 (its existence is not revealed).
 *
 * A fresh clinic of its own, so every count is exact:
 *   mine     assigned to the therapist, her session, flagged      → therapist
 *   seen     her session, flagged, then reassigned to the psych   → therapist (session) and psych (assignment)
 *   theirs   assigned to the psychologist, his session, flagged   → psych
 *   intern   assigned to the intern, the intern's session, flagged → intern
 * The director sees all four.
 */
const PASSWORD = 'Password123!';
const PHONE = '+919876543211'; // VERIFICATION_TEST_PHONES: onboarding skips phone.email

type Who = 'director' | 'therapist' | 'psych' | 'intern' | 'support';
type Key = 'mine' | 'seen' | 'theirs' | 'intern';
type Ctx = { ctx: APIRequestContext; userId: string };
type Card = { id: string; related_patient_id: string };

const ok = async <T>(res: Awaited<ReturnType<APIRequestContext['get']>>): Promise<T> => {
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
};

test.describe('follow-up cards are scoped to the clinician', () => {
  requireApi();
  requireAuth();
  test.describe.configure({ mode: 'serial' });

  const slug = uniq('scope').toLowerCase();
  const email = (who: Who) => `${who}.${slug}@example.com`;
  const as = {} as Record<Who, Ctx>;
  const patients = {} as Record<Key, string>;
  const cards = {} as Record<Key, string>;
  const names = {} as Record<Key, string>;
  let queue: string;

  test.beforeAll(async () => {
    const anon = await pwRequest.newContext({ baseURL: env.API_URL });
    const member = (who: Who, role: string) => ({
      email: email(who), first_name: who, last_name: 'Scope', role, phone: PHONE,
      temporary_password: PASSWORD, send_invitation: false,
      ...(role === 'SUPPORT_STAFF' ? {} : { license_number: `LIC-${who}-${slug}`, license_type: 'RCI' }),
    });
    const onboarded = await anon.post('/api/v1/onboarding/complete', {
      data: {
        organization: {
          name: `${E2E_CLINIC} ${slug}`, type: 'clinic', contact_email: `${slug}@example.com`, contact_phone: PHONE,
          address_line1: '1 MG Road', city: 'Pune', state: 'MH', postal_code: '411001',
        },
        plan: { plan_type: 'basic', max_users: 10, max_patients: 100, max_sessions_per_month: 500 },
        admin: { email: email('director'), password: PASSWORD, first_name: 'Director', last_name: 'Scope', phone: PHONE },
        admin_role: 'CLINICAL_DIRECTOR',
        team_members: [
          member('therapist', 'THERAPIST'), member('psych', 'PSYCHOLOGIST'),
          member('intern', 'INTERN'), member('support', 'SUPPORT_STAFF'),
        ],
        timezone: 'Asia/Kolkata',
      },
    });
    expect(onboarded.status(), await onboarded.text()).toBe(200);
    for (const who of ['director', 'therapist', 'psych', 'intern', 'support'] as Who[]) {
      const body = await ok<{ access_token: string; user: { id: string }; tenant: { id: string } }>(
        await anon.post('/api/v1/auth/login', { data: { email: email(who), password: PASSWORD } }),
      );
      as[who] = {
        ctx: await pwRequest.newContext({
          baseURL: env.API_URL,
          extraHTTPHeaders: { Authorization: `Bearer ${body.access_token}`, 'X-Tenant-ID': body.tenant.id },
        }),
        userId: body.user.id,
      };
    }
    await anon.dispose();

    const d = as.director.ctx;
    let hour = 0; // one clinician's sessions must not overlap
    const setup = async (key: Key, owner: Who) => {
      hour += 2;
      names[key] = `${slug}${key}`;
      const patient = await ok<{ id: string }>(await d.post('/api/v1/patients/', {
        data: { first_name: names[key], last_name: 'Patient', assigned_therapist_id: as[owner].userId },
      }));
      patients[key] = patient.id;
      const session = await ok<{ id: string }>(await as[owner].ctx.post('/api/v1/sessions/', {
        data: { patient_id: patient.id, scheduled_at: new Date(Date.now() + 2 * 86_400_000 + hour * 3_600_000).toISOString(), duration_minutes: 50 },
      }));
      await ok(await d.put(`/api/v1/sessions/${session.id}`, { data: { risk_flag: true, risk_level: 'high' } }));
    };
    await setup('mine', 'therapist');
    await setup('seen', 'therapist');
    await setup('theirs', 'psych');
    await setup('intern', 'intern');
    await ok(await d.put(`/api/v1/patients/${patients.seen}`, { data: { assigned_therapist_id: as.psych.userId } }));
    await ok(await d.post('/api/v1/kanban/followups/sync'));

    const all = await ok<{ items: Card[] }>(await d.get('/api/v1/kanban/followups', { params: { per_page: 100 } }));
    expect(all.items).toHaveLength(4);
    for (const key of Object.keys(patients) as Key[]) {
      cards[key] = all.items.find((i) => i.related_patient_id === patients[key])!.id;
    }
    const boards = await ok<{ boards: Array<{ id: string; name: string }> }>(
      await d.get('/api/v1/kanban/boards', { params: { include_auto: 'true' } }),
    );
    queue = boards.boards.find((b) => b.name === 'Follow-up queue')!.id;
  });

  test.afterAll(async () => {
    for (const who of Object.keys(as) as Who[]) await as[who].ctx.dispose();
    await deleteClinic(email('director'));
  });

  const ids = (list: Card[]) => list.map((c) => c.id).sort();
  const expected = (...keys: Key[]) => keys.map((k) => cards[k]).sort();
  const sees: Record<Exclude<Who, 'support'>, Key[]> = {
    director: ['mine', 'seen', 'theirs', 'intern'],
    therapist: ['mine', 'seen'],
    psych: ['seen', 'theirs'],
    intern: ['intern'],
  };

  test('GET /kanban/followups: items, total and reason counts', async () => {
    for (const [who, keys] of Object.entries(sees) as Array<[Who, Key[]]>) {
      const res = await ok<{ items: Card[]; total: number; by_reason: Record<string, number> }>(
        await as[who].ctx.get('/api/v1/kanban/followups'),
      );
      expect({ who, ids: ids(res.items), total: res.total, risk: res.by_reason.risk_flag })
        .toEqual({ who, ids: expected(...keys), total: keys.length, risk: keys.length });
    }
  });

  test('GET /tasks, /boards/{id} and /boards/{id}/view on the queue board', async () => {
    for (const [who, keys] of Object.entries(sees) as Array<[Who, Key[]]>) {
      const c = as[who].ctx;
      const tasks = await ok<{ tasks: Card[]; total: number }>(await c.get('/api/v1/kanban/tasks', { params: { board_id: queue } }));
      expect({ who, ids: ids(tasks.tasks), total: tasks.total }).toEqual({ who, ids: expected(...keys), total: keys.length });

      const board = await ok<{ tasks: Card[] }>(await c.get(`/api/v1/kanban/boards/${queue}`));
      expect({ who, ids: ids(board.tasks) }).toEqual({ who, ids: expected(...keys) });

      const view = await ok<{ cells: Array<{ total: number; tasks: Card[] }> }>(await c.get(`/api/v1/kanban/boards/${queue}/view`));
      expect({ who, ids: ids(view.cells.flatMap((cell) => cell.tasks)), total: view.cells.reduce((n, cell) => n + cell.total, 0) })
        .toEqual({ who, ids: expected(...keys), total: keys.length });
    }
  });

  test("another clinician's card is 404 on every card path; one's own is 200", async () => {
    const t = as.therapist.ctx;
    const card = `/api/v1/kanban/tasks/${cards.theirs}`;
    expect((await t.get(card)).status()).toBe(404);
    expect((await t.put(card, { data: { title: 'not mine' } })).status()).toBe(404);
    expect((await t.post(`${card}/move`, { data: { status: 'in_progress', position: 0 } })).status()).toBe(404);
    expect((await t.get(`${card}/comments`)).status()).toBe(404);
    expect((await t.post(`${card}/comments`, { data: { content: 'not mine' } })).status()).toBe(404);
    expect((await t.delete(card)).status()).toBe(404);
    expect((await as.intern.ctx.get(`/api/v1/kanban/tasks/${cards.mine}`)).status()).toBe(404);

    expect((await t.get(`/api/v1/kanban/tasks/${cards.mine}`)).status()).toBe(200);
    expect((await t.get(`/api/v1/kanban/tasks/${cards.seen}/comments`)).status()).toBe(200);
    expect((await as.psych.ctx.get(card)).status()).toBe(200);
    expect((await as.director.ctx.get(card)).status()).toBe(200);
  });

  test('dashboard/stats, the overview tile and /patients/stats count only what the caller may see', async () => {
    for (const [who, keys] of Object.entries(sees) as Array<[Who, Key[]]>) {
      const c = as[who].ctx;
      const stats = await ok<{ total_tasks: number }>(await c.get('/api/v1/kanban/dashboard/stats', { params: { board_id: queue } }));
      const tile = await ok<{ patients_needing_followup: number }>(await c.get('/api/v1/analytics/overview'));
      const patientStats = await ok<{ patients_needing_follow_up: number }>(await c.get('/api/v1/patients/stats'));
      expect({ who, stats: stats.total_tasks, tile: tile.patients_needing_followup, patients: patientStats.patients_needing_follow_up })
        .toEqual({ who, stats: keys.length, tile: keys.length, patients: keys.length });
    }
    const support = await ok<{ patients_needing_followup: number }>(await as.support.ctx.get('/api/v1/analytics/overview'));
    expect(support.patients_needing_followup).toBe(0);
  });

  test('POST /followups/sync tells a clinician only about their own cards', async () => {
    const mine = await ok<Record<string, unknown>>(await as.therapist.ctx.post('/api/v1/kanban/followups/sync'));
    expect(mine.open).toBe(2);
    expect((mine.by_reason as Record<string, number>).risk_flag).toBe(2);
    expect(mine).not.toHaveProperty('created');
    expect(mine).not.toHaveProperty('archived');

    const clinic = await ok<Record<string, unknown>>(await as.director.ctx.post('/api/v1/kanban/followups/sync'));
    expect(clinic.open).toBe(4);
    expect(clinic.created).toBe(0);
  });

  test("notifications about a follow-up card reach only those who may see it, without the patient's name", async () => {
    const d = as.director.ctx;
    const comment = await d.post(`/api/v1/kanban/tasks/${cards.theirs}/comments`, {
      data: { content: 'please look', mentions: [as.therapist.userId, as.psych.userId, as.support.userId] },
    });
    expect(comment.status(), await comment.text()).toBe(200);
    await ok(await d.put(`/api/v1/kanban/tasks/${cards.theirs}`, { data: { assigned_to_user: as.intern.userId } }));

    const about = async (who: Who) => {
      const list = await ok<Array<{ task_id: string; type: string; message: string }>>(await as[who].ctx.get('/api/v1/kanban/notifications'));
      return list.filter((n) => n.task_id === cards.theirs);
    };
    expect(await about('therapist')).toEqual([]);
    expect(await about('support')).toEqual([]);
    expect(await about('intern')).toEqual([]);
    const psych = await about('psych');
    // the sync assigned the card to him, so the reassignment tells him too
    expect(psych.map((n) => n.type).sort()).toEqual(['mentioned', 'unassigned']);
    for (const n of psych) {
      expect(n.message).toContain('a follow-up card');
      expect(n.message).not.toContain(names.theirs);
    }
  });
});
