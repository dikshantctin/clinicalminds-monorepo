import { request as pwRequest } from '@playwright/test';
import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { env, DEMO_THERAPIST } from '../src/env';
import { OwnClinic, deleteClinic, onboardOwnClinic } from '../src/clinics';
import { nextWeekday } from '../src/days';

/**
 * Clinic hours (capacity slice b): open days, hours, breaks, the notes buffer and holidays, in
 * platform_firms.settings. Public booking offers slots only inside them; staff may still book outside.
 * A fresh clinic, so the demo clinic's hours (that other specs book against) never change.
 */

const DEFAULTS = { open_days: [1, 2, 3, 4, 5, 6], open: '10:00', close: '18:00', breaks: [], buffer_minutes: 10, holidays: [] };
const wall = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));

test.describe('clinic hours', () => {
  requireApi();
  requireAuth();
  test.describe.configure({ mode: 'serial' });

  let clinic: OwnClinic;
  test.beforeAll(async () => {
    clinic = await onboardOwnClinic('hours');
  });
  test.afterAll(async () => {
    await clinic?.api.dispose();
    if (clinic) await deleteClinic(clinic.adminEmail);
  });

  const slots = async (date: string) => {
    const anon = await pwRequest.newContext({ baseURL: env.API_URL });
    try {
      const res = await anon.get(`/api/v1/public/booking/${clinic.firmCode}/slots`, {
        params: { practitioner_id: clinic.user.id, service_id: clinic.serviceId, date },
      });
      expect(res.status(), await res.text()).toBe(200);
      return ((await res.json()).slots as string[]).map(wall);
    } finally {
      await anon.dispose();
    }
  };

  test('a clinic that set nothing: Mon–Sat 10:00–18:00, closed on Sunday', async () => {
    const res = await clinic.api.get('/api/v1/clinic-hours');
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual(DEFAULTS);

    expect(await slots(nextWeekday(7, 3))).toEqual([]);
    const monday = await slots(nextWeekday(1, 3));
    expect(monday[0]).toBe('10:00');
    expect(monday[monday.length - 1]).toBe('17:00'); // 17:00–17:50 is the last 50 minutes that fit
  });

  test('saved hours, a lunch break and a holiday shape the public slots', async () => {
    const tuesday = nextWeekday(2, 3);
    const holiday = nextWeekday(3, 3);
    const hours = {
      open_days: [1, 2, 3, 4, 5],
      open: '09:00',
      close: '17:00',
      breaks: [{ start: '13:00', end: '14:00' }],
      buffer_minutes: 15,
      holidays: [{ date: holiday, name: 'Clinic holiday' }],
    };
    const saved = await clinic.api.put('/api/v1/clinic-hours', { data: hours });
    expect(saved.status(), await saved.text()).toBe(200);
    expect(await saved.json()).toEqual(hours);
    expect(await (await clinic.api.get('/api/v1/clinic-hours')).json()).toEqual(hours);

    const day = await slots(tuesday);
    expect(day[0]).toBe('09:00');
    expect(day[day.length - 1]).toBe('16:00');
    expect(day).toContain('12:00'); // 12:00–12:50 ends before lunch
    for (const inLunch of ['12:30', '13:00', '13:30']) expect(day, inLunch).not.toContain(inLunch);
    expect(day).toContain('14:00');

    expect(await slots(holiday)).toEqual([]);
    expect(await slots(nextWeekday(6, 3))).toEqual([]); // Saturday is no longer an open day
  });

  test('staff may still book outside the hours', async () => {
    const patient = await (await clinic.api.post('/api/v1/patients/', { data: { first_name: 'Late', last_name: 'Patient' } })).json();
    const res = await clinic.api.post('/api/v1/sessions/', {
      data: { patient_id: patient.id, scheduled_at: `${nextWeekday(7, 3)}T20:00:00+05:30`, duration_minutes: 50 },
    });
    expect(res.status(), await res.text()).toBe(200);
  });

  test('invalid hours → 422 and nothing changes', async () => {
    const before = await (await clinic.api.get('/api/v1/clinic-hours')).json();
    const bad = [
      { ...DEFAULTS, open: '18:00', close: '10:00' }, // closes before it opens
      { ...DEFAULTS, breaks: [{ start: '09:00', end: '10:30' }] }, // break outside the hours
      { ...DEFAULTS, breaks: [{ start: '14:00', end: '13:00' }] }, // break ends before it starts
      { ...DEFAULTS, open_days: [0, 8] }, // weekdays are 1 (Monday) … 7 (Sunday)
      { ...DEFAULTS, buffer_minutes: 120 }, // 0–60
      { ...DEFAULTS, open: '9am' },
      { ...DEFAULTS, holidays: [{ date: '2027-01-26', name: 'A' }, { date: '2027-01-26', name: 'B' }] }, // same day twice
    ];
    for (const body of bad) {
      expect((await clinic.api.put('/api/v1/clinic-hours', { data: body })).status(), JSON.stringify(body)).toBe(422);
    }
    expect(await (await clinic.api.get('/api/v1/clinic-hours')).json()).toEqual(before);
  });

  test('a therapist reads the hours but cannot change them (403); no token → 401', async ({ anon }) => {
    const login = await (await anon.post('/api/v1/auth/login', { data: { ...DEMO_THERAPIST, audience: 'staff' } })).json();
    const jane = await pwRequest.newContext({
      baseURL: env.API_URL,
      extraHTTPHeaders: { Authorization: `Bearer ${login.access_token}`, 'X-Tenant-ID': login.tenant.id },
    });
    try {
      expect((await jane.get('/api/v1/clinic-hours')).status()).toBe(200);
      expect((await jane.put('/api/v1/clinic-hours', { data: DEFAULTS })).status()).toBe(403);
    } finally {
      await jane.dispose();
    }
    expect((await anon.get('/api/v1/clinic-hours')).status()).toBe(401);
  });
});
