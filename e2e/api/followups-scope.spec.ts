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
const FROZEN = "A follow-up card's type and patient can't be changed, and no card can become a follow-up card";
const PHONE = '+919876543211'; // VERIFICATION_TEST_PHONES: onboarding skips phone.email

type Who = 'director' | 'therapist' | 'psych' | 'intern' | 'support';
type Key = 'mine' | 'seen' | 'theirs' | 'intern';
type Ctx = { ctx: APIRequestContext; userId: string };
type Card = { id: string; related_patient_id: string };

const ok = async <T>(res: Awaited<ReturnType<APIRequestContext['get']>>): Promise<T> => {
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as T;
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
  // /patients/stats counts over the caller's own patients: the therapist only sees 'seen' through a session
  const ownPatients: Record<Exclude<Who, 'support'>, Key[]> = { ...sees, therapist: ['mine'] };

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
    expect((await t.post(`${card}/move`, { data: { status: 'in_progress' } })).status()).toBe(404);
    expect((await t.get(`${card}/comments`)).status()).toBe(404);
    expect((await t.post(`${card}/comments`, { data: { content: 'not mine' } })).status()).toBe(404);
    expect((await t.delete(card)).status()).toBe(404);
    expect((await as.intern.ctx.get(`/api/v1/kanban/tasks/${cards.mine}`)).status()).toBe(404);

    expect((await t.get(`/api/v1/kanban/tasks/${cards.mine}`)).status()).toBe(200);
    expect((await t.get(`/api/v1/kanban/tasks/${cards.seen}/comments`)).status()).toBe(200);
    expect((await as.psych.ctx.get(card)).status()).toBe(200);
    expect((await as.director.ctx.get(card)).status()).toBe(200);
  });

  test('a card cannot be turned into or out of a follow-up card', async () => {
    // a follow-up card whose type changed would leave the scope, showing its title (the patient's name) to all staff
    const out = await as.therapist.ctx.put(`/api/v1/kanban/tasks/${cards.mine}`, { data: { task_type: 'other' } });
    expect(out.status(), await out.text()).toBe(422);
    expect((await out.json()).message).toBe(FROZEN);
    const byDirector = await as.director.ctx.put(`/api/v1/kanban/tasks/${cards.mine}`, { data: { task_type: 'other' } });
    expect(byDirector.status(), await byDirector.text()).toBe(422);
    expect((await ok<{ task_type: string }>(await as.director.ctx.get(`/api/v1/kanban/tasks/${cards.mine}`))).task_type).toBe('patient_followup');

    const board = await ok<{ id: string }>(await as.director.ctx.post('/api/v1/kanban/boards', { data: { name: `${slug} plain` } }));
    const plain = await ok<{ id: string }>(await as.director.ctx.post('/api/v1/kanban/tasks', { data: { board_id: board.id, title: 'Plain card' } }));
    const into = await as.director.ctx.put(`/api/v1/kanban/tasks/${plain.id}`, { data: { task_type: 'patient_followup' } });
    expect(into.status(), await into.text()).toBe(422);
    const made = await as.therapist.ctx.post('/api/v1/kanban/tasks', {
      data: { board_id: board.id, title: 'Hand-made follow-up', task_type: 'patient_followup', related_patient_id: patients.theirs },
    });
    expect(made.status(), await made.text()).toBe(422);
    expect((await made.json()).message).toBe(FROZEN);

    // the patient can't be swapped or cleared either (the scope keys off it)
    for (const related_patient_id of [patients.theirs, null]) {
      const res = await as.director.ctx.put(`/api/v1/kanban/tasks/${cards.mine}`, { data: { related_patient_id } });
      expect(res.status(), await res.text()).toBe(422);
      expect((await res.json()).message).toBe(FROZEN);
    }
    // unchanged values are fine
    const same = await as.director.ctx.put(`/api/v1/kanban/tasks/${cards.mine}`, {
      data: { task_type: 'patient_followup', related_patient_id: patients.mine },
    });
    expect(same.status(), await same.text()).toBe(200);

    // and after every attempt the card is still out of reach of an unrelated clinician
    expect((await as.intern.ctx.get(`/api/v1/kanban/tasks/${cards.mine}`)).status()).toBe(404);
    const list = await ok<{ tasks: Card[] }>(await as.intern.ctx.get('/api/v1/kanban/tasks', { params: { board_id: queue } }));
    expect(ids(list.tasks)).toEqual(expected('intern'));
  });

  test('dashboard/stats, the overview tile and /patients/stats count only what the caller may see', async () => {
    for (const [who, keys] of Object.entries(sees) as Array<[Who, Key[]]>) {
      const c = as[who].ctx;
      const stats = await ok<{ total_tasks: number }>(await c.get('/api/v1/kanban/dashboard/stats', { params: { board_id: queue } }));
      const tile = await ok<{ patients_needing_followup: number }>(await c.get('/api/v1/analytics/overview'));
      const patientStats = await ok<{ patients_needing_follow_up: number }>(await c.get('/api/v1/patients/stats'));
      expect({ who, stats: stats.total_tasks, tile: tile.patients_needing_followup, patients: patientStats.patients_needing_follow_up })
        .toEqual({ who, stats: keys.length, tile: keys.length, patients: ownPatients[who as Exclude<Who, 'support'>].length });
    }
  });

  test('the front desk has no task boards and counts no follow-ups', async () => {
    const s = as.support.ctx;
    const paths = [
      ['get', '/api/v1/kanban/followups'],
      ['get', '/api/v1/kanban/tasks'],
      ['get', `/api/v1/kanban/tasks/${cards.mine}`],
      ['get', `/api/v1/kanban/boards/${queue}`],
      ['get', `/api/v1/kanban/boards/${queue}/view`],
      ['get', '/api/v1/kanban/notifications'],
      ['post', '/api/v1/kanban/followups/sync'],
    ] as const;
    for (const [method, path] of paths) {
      expect({ path, status: (await s[method](path)).status() }).toEqual({ path, status: 403 });
    }
    const tile = await ok<{ patients_needing_followup: number }>(await s.get('/api/v1/analytics/overview'));
    expect(tile.patients_needing_followup).toBe(0);
    const patientStats = await ok<{ patients_needing_follow_up: number }>(await s.get('/api/v1/patients/stats'));
    expect(patientStats.patients_needing_follow_up).toBe(0);
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
    expect(await about('intern')).toEqual([]);
    const psych = await about('psych');
    // the sync assigned the card to the psychologist, so the reassignment tells them too
    expect(psych.map((n) => n.type).sort()).toEqual(['mentioned', 'unassigned']);
    for (const n of psych) {
      expect(n.message).toContain('a follow-up card');
      expect(n.message).not.toContain(names.theirs);
    }
  });
  test('GET /kanban/tasks/{id}/can-see/{user_id} says whether a staff member may see the card', async () => {
    // the assignee picker warns before giving a card to someone who could not open it
    const canSee = async (who: Who, card: string, userId: string) => {
      const res = await as[who].ctx.get(`/api/v1/kanban/tasks/${card}/can-see/${userId}`);
      expect(res.status(), await res.text()).toBe(200);
      return (await res.json()).can_see as boolean;
    };
    const d = 'director';
    expect({
      therapist: await canSee(d, cards.theirs, as.therapist.userId),
      psych: await canSee(d, cards.theirs, as.psych.userId),
      intern: await canSee(d, cards.theirs, as.intern.userId),
      director: await canSee(d, cards.theirs, as.director.userId),
      support: await canSee(d, cards.theirs, as.support.userId),
      seenByTherapist: await canSee(d, cards.seen, as.therapist.userId), // through a session
      unknown: await canSee(d, cards.theirs, '00000000-0000-4000-8000-000000000000'),
    }).toEqual({
      therapist: false, psych: true, intern: false, director: true, support: false, seenByTherapist: true, unknown: false,
    });
    // only someone who may change the assignee asks: the card's assignee may, another clinician who sees it may
    // not (403: else they would learn who else treats the patient); a card they can't see is 404 as everywhere
    await ok(await as.director.ctx.put(`/api/v1/kanban/tasks/${cards.seen}`, { data: { assigned_to_user: as.therapist.userId } }));
    expect(await canSee('therapist', cards.seen, as.psych.userId)).toBe(true);
    expect(await canSee('therapist', cards.seen, as.intern.userId)).toBe(false);
    const notAssignee = await as.psych.ctx.get(`/api/v1/kanban/tasks/${cards.seen}/can-see/${as.therapist.userId}`);
    expect(notAssignee.status(), await notAssignee.text()).toBe(403);
    expect((await notAssignee.json()).message).toBe('Only managers, the creator or the assignee can change this task');
    expect((await as.therapist.ctx.get(`/api/v1/kanban/tasks/${cards.theirs}/can-see/${as.psych.userId}`)).status()).toBe(404);
    expect((await as.director.ctx.get(`/api/v1/kanban/tasks/${cards.theirs}/can-see/not-a-uuid`)).status()).toBe(422);
    expect((await as.support.ctx.get(`/api/v1/kanban/tasks/${cards.theirs}/can-see/${as.psych.userId}`)).status()).toBe(403);
  });

  test('a cancelled session gives no access; a live one still does', async () => {
    // runs last: it adds a fifth flagged patient, which the exact counts above don't expect
    const d = as.director.ctx;
    const t = as.therapist.ctx;
    const patient = await ok<{ id: string }>(await d.post('/api/v1/patients/', {
      data: { first_name: `${slug}cancelled`, last_name: 'Patient', assigned_therapist_id: as.therapist.userId },
    }));
    const at = (h: number) => new Date(Date.now() + 5 * 86_400_000 + h * 3_600_000).toISOString();
    const booked = await ok<{ id: string }>(await t.post('/api/v1/sessions/', {
      data: { patient_id: patient.id, scheduled_at: at(0), duration_minutes: 50 },
    }));
    await ok(await t.post(`/api/v1/sessions/${booked.id}/cancel`, { data: { reason: 'patient asked' } }));
    await ok(await d.put(`/api/v1/patients/${patient.id}`, { data: { assigned_therapist_id: as.psych.userId } }));
    const flagged = await ok<{ id: string }>(await as.psych.ctx.post('/api/v1/sessions/', {
      data: { patient_id: patient.id, scheduled_at: at(3), duration_minutes: 50 },
    }));
    await ok(await d.put(`/api/v1/sessions/${flagged.id}`, { data: { risk_flag: true, risk_level: 'high' } }));
    await ok(await d.post('/api/v1/kanban/followups/sync'));

    const all = await ok<{ items: Card[] }>(await d.get('/api/v1/kanban/followups', { params: { per_page: 100 } }));
    const card = all.items.find((i) => i.related_patient_id === patient.id)!.id;
    expect((await as.psych.ctx.get(`/api/v1/kanban/tasks/${card}`)).status()).toBe(200);
    expect((await t.get(`/api/v1/kanban/tasks/${card}`)).status()).toBe(404);
    const theirs = await ok<{ items: Card[] }>(await t.get('/api/v1/kanban/followups'));
    expect(ids(theirs.items)).toEqual(expected('mine', 'seen')); // 'seen' still comes through a live session
  });
});
