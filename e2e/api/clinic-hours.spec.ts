import { request as pwRequest } from '@playwright/test';
import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { env, DEMO_THERAPIST, DEMO_PATIENT } from '../src/env';
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

  test('the notes buffer keeps the time after a booked session free, and a slot leaves it before the next', async () => {
    // saved hours from above: Mon–Fri 09:00–17:00, lunch 13:00–14:00, buffer 15
    const thursday = nextWeekday(4, 3);
    const patient = await (await clinic.api.post('/api/v1/patients/', { data: { first_name: 'Buffer', last_name: 'Patient' } })).json();
    for (const [time, minutes] of [['09:00', 60], ['16:00', 50]] as const) {
      const res = await clinic.api.post('/api/v1/sessions/', {
        data: { patient_id: patient.id, scheduled_at: `${thursday}T${time}:00+05:30`, duration_minutes: minutes },
      });
      expect(res.status(), await res.text()).toBe(200);
    }
    // 09:00–10:00 + 15 → free from 10:15; a slot before 16:00 must end by 15:45
    expect(await slots(thursday)).toEqual(['10:30', '11:00', '11:30', '12:00', '14:00', '14:30']);

    const hours = await (await clinic.api.get('/api/v1/clinic-hours')).json();
    expect((await clinic.api.put('/api/v1/clinic-hours', { data: { ...hours, buffer_minutes: 0 } })).status()).toBe(200);
    // a session keeps the buffer it was booked with (capacity slice d): 09:00–10:00 still holds until 10:15,
    // but a new slot no longer needs a buffer of its own, so 15:00–15:50 fits before 16:00
    expect(await slots(thursday)).toEqual(['10:30', '11:00', '11:30', '12:00', '14:00', '14:30', '15:00']);
  });

  test('invalid hours → 422 with the rule that failed, and nothing changes', async () => {
    const before = await (await clinic.api.get('/api/v1/clinic-hours')).json();
    const bad: [Record<string, unknown>, string][] = [
      [{ ...DEFAULTS, open: '18:00', close: '10:00' }, 'The clinic must close after it opens'],
      [{ ...DEFAULTS, breaks: [{ start: '09:00', end: '10:30' }] }, 'Each break must be inside the opening hours'],
      [{ ...DEFAULTS, breaks: [{ start: '14:00', end: '13:00' }] }, 'Each break must end after it starts'],
      [{ ...DEFAULTS, open_days: [0, 8] }, 'Open days are 1 (Monday) to 7 (Sunday)'],
      [{ ...DEFAULTS, open_days: [] }, 'Pick at least one open day'],
      [{ ...DEFAULTS, buffer_minutes: 120 }, 'The notes buffer is 0 to 60 minutes'],
      [{ ...DEFAULTS, open: '9am' }, 'Times are HH:MM, for example 09:30'],
      [{ ...DEFAULTS, breaks: [{ start: '1pm', end: '14:00' }] }, 'Times are HH:MM, for example 09:30'],
      [{ ...DEFAULTS, holidays: [{ date: '2027-01-26', name: 'A' }, { date: '2027-01-26', name: 'B' }] }, 'Each holiday date can be listed once'],
      [{ ...DEFAULTS, holidays: [{ date: '26/01/2027', name: 'A' }] }, 'Each holiday needs a date (YYYY-MM-DD) and a name of at most 100 characters'],
    ];
    for (const [body, message] of bad) {
      const res = await clinic.api.put('/api/v1/clinic-hours', { data: body });
      expect(res.status(), JSON.stringify(body)).toBe(422);
      expect((await res.json()).message, JSON.stringify(body)).toBe(message);
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

  test('a patient cannot read the clinic hours (403)', async ({ anon }) => {
    const login = await anon.post('/api/v1/auth/login', { data: { ...DEMO_PATIENT, audience: 'patient' } });
    expect(login.status(), await login.text()).toBe(200);
    const { access_token, tenant } = await login.json();
    const res = await anon.get('/api/v1/clinic-hours', { headers: { Authorization: `Bearer ${access_token}`, 'X-Tenant-ID': tenant.id } });
    expect(res.status()).toBe(403);
  });
});
