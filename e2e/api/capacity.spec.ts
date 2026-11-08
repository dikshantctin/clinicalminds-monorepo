import { request as pwRequest } from '@playwright/test';
import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { env, DEMO_PATIENT } from '../src/env';
import { deleteClinic } from '../src/clinics';
import { addDays } from '../src/days';
import { CapacityWeek, buildCapacityWeek } from '../src/capacity';

/**
 * Capacity slice f: GET /capacity?week= — one row per clinician for a clinic week (Mon–Sun):
 * available = their hours ∩ the clinic's, minus breaks, blocked time, approved leave and holidays;
 * used = sessions + their buffers inside those hours (no-shows included, and shown on their own);
 * extra = session time outside them; free = available − used; overloaded above 85 %.
 * Admin and director see every clinician, a clinician their own row, the front desk free time only.
 * The week and its numbers: src/capacity.ts.
 */
test.describe('clinician time (GET /capacity)', () => {
  requireApi();
  requireAuth();
  test.describe.configure({ mode: 'serial' });

  let w: CapacityWeek;
  test.beforeAll(async () => {
    w = await buildCapacityWeek('capacity');
  });
  test.afterAll(async () => {
    for (const m of w?.clinic.members ?? []) await m.api.dispose();
    await w?.clinic.api.dispose();
    if (w) await deleteClinic(w.clinic.adminEmail);
  });

  const THERAPIST_ROW = {
    name: 'Team Member 0',
    available_minutes: 5 * 480 - 60, // Mon, Wed–Sat 10–18, less the supervision hour (Tuesday is leave)
    used_minutes: 150,
    no_show_minutes: 60,
    free_minutes: 2340 - 150,
    extra_minutes: 70,
    percent_used: 6,
    overloaded: false,
  };
  const DIRECTOR_ROW = {
    name: 'Hema Hours',
    available_minutes: 60,
    used_minutes: 55,
    no_show_minutes: 0,
    free_minutes: 5,
    extra_minutes: 0,
    percent_used: 92,
    overloaded: true,
  };

  test('the director sees every clinician of the week; any day of it names the same week', async () => {
    const res = await w.clinic.api.get('/api/v1/capacity', { params: { week: addDays(w.monday, 2) } });
    expect(res.status(), await res.text()).toBe(200);
    expect(await res.json()).toEqual({
      week_start: w.monday,
      overload_percent: 85,
      rows: [
        { clinician_id: w.clinic.user.id, ...DIRECTOR_ROW },
        { clinician_id: w.therapist.user.id, ...THERAPIST_ROW },
      ],
    });
  });

  test('a clinician sees only their own row', async () => {
    const res = await w.therapist.api.get('/api/v1/capacity', { params: { week: w.monday } });
    expect(res.status()).toBe(200);
    expect((await res.json()).rows).toEqual([{ clinician_id: w.therapist.user.id, ...THERAPIST_ROW }]);
  });

  test('the front desk sees free time only', async () => {
    const res = await w.desk.api.get('/api/v1/capacity', { params: { week: w.monday } });
    expect(res.status()).toBe(200);
    expect((await res.json()).rows).toEqual([
      { clinician_id: w.clinic.user.id, name: 'Hema Hours', free_minutes: 5 },
      { clinician_id: w.therapist.user.id, name: 'Team Member 0', free_minutes: 2190 },
    ]);
  });

  test('a bad week → 422; a patient → 403; no token → 401', async () => {
    const bad = await w.clinic.api.get('/api/v1/capacity', { params: { week: '2026-13-01' } });
    expect(bad.status()).toBe(422);
    expect((await bad.json()).message).toBe('week must be a date (YYYY-MM-DD)');
    const anon = await pwRequest.newContext({ baseURL: env.API_URL });
    try {
      expect((await anon.get('/api/v1/capacity')).status()).toBe(401);
      const login = await (await anon.post('/api/v1/auth/login', { data: { ...DEMO_PATIENT, audience: 'patient' } })).json();
      const res = await anon.get('/api/v1/capacity', { headers: { Authorization: `Bearer ${login.access_token}`, 'X-Tenant-ID': login.tenant.id } });
      expect(res.status()).toBe(403);
    } finally {
      await anon.dispose();
    }
  });
});
