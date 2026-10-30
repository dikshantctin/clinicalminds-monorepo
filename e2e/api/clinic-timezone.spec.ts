import { request as pwRequest, APIRequestContext } from '@playwright/test';
import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { env, uniq } from '../src/env';

/**
 * Every clinic-local day is the clinic's own zone (platform_firms.timezone), not Asia/Kolkata:
 * public booking slots, the dashboard's week / month boundaries, and the schedule stats and
 * availability windows. A clinic onboarded in America/New_York checks it; the demo clinic
 * (Asia/Kolkata) checks nothing changed there.
 */

const NY = 'America/New_York';
const IST = 'Asia/Kolkata';
const ALLOW_LISTED_PHONE = '+919876543211'; // VERIFICATION_TEST_PHONES: onboarding and booking skip phone.email

const fmt = (tz: string, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, ...opts });
/** "HH:MM" wall clock of an instant in `tz`. */
const wallClock = (iso: string, tz: string) => fmt(tz, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
/** "YYYY-MM-DD" of an instant in `tz`. */
const localDate = (at: string | Date, tz: string) => fmt(tz, {}).format(new Date(at));
const weekday = (iso: string, tz: string) => new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(new Date(iso));
/** "-05:00": the zone's UTC offset at noon UTC of `ymd`. */
const offsetOn = (ymd: string, tz: string) => {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
    .formatToParts(new Date(`${ymd}T12:00:00Z`))
    .find((p) => p.type === 'timeZoneName')!.value;
  return name === 'GMT' ? '+00:00' : name.slice(3);
};

interface Clinic { api: APIRequestContext; firmCode: string; practitionerId: string; serviceId: string }

/** A fresh clinic in America/New_York whose CLINICAL_DIRECTOR admin is also its bookable clinician. */
async function onboardNewYorkClinic(): Promise<Clinic> {
  const slug = uniq('tz').toLowerCase();
  const anon = await pwRequest.newContext({ baseURL: env.API_URL });
  try {
    const onboarded = await anon.post('/api/v1/onboarding/complete', {
      data: {
        organization: {
          name: `NY Clinic ${slug}`, type: 'clinic', contact_email: `${slug}@example.com`, contact_phone: ALLOW_LISTED_PHONE,
          address_line1: '1 Broadway', city: 'New York', state: 'NY', postal_code: '10004',
        },
        plan: { plan_type: 'basic', max_users: 5, max_patients: 100, max_sessions_per_month: 500 },
        admin: { email: `admin.${slug}@example.com`, password: 'Password123!', first_name: 'Nora', last_name: 'York', phone: ALLOW_LISTED_PHONE },
        admin_role: 'CLINICAL_DIRECTOR',
        team_members: [],
        timezone: NY,
      },
    });
    expect(onboarded.status(), await onboarded.text()).toBe(200);
    const login = await anon.post('/api/v1/auth/login', { data: { email: `admin.${slug}@example.com`, password: 'Password123!' } });
    expect(login.status(), await login.text()).toBe(200);
    const { access_token, user, tenant } = await login.json();
    const api = await pwRequest.newContext({
      baseURL: env.API_URL,
      extraHTTPHeaders: { Authorization: `Bearer ${access_token}`, 'X-Tenant-ID': tenant.id },
    });
    const service = await api.post('/api/v1/catalog/services', {
      data: { name: 'Therapy', description: 'e2e', duration_minutes: 50, price: 0, currency: 'USD' },
    });
    expect(service.status(), await service.text()).toBe(201);
    return { api, firmCode: tenant.firm_code, practitionerId: user.id, serviceId: (await service.json()).id };
  } finally {
    await anon.dispose();
  }
}

test.describe('clinic time zone (platform_firms.timezone) everywhere', () => {
  requireApi();
  requireAuth();
  test.describe.configure({ mode: 'serial' });

  let ny: Clinic;
  // clinic-local days well past the booking lead time
  const day = localDate(new Date(Date.now() + 8 * 86_400_000), NY);
  const laterDay = localDate(new Date(Date.now() + 9 * 86_400_000), NY);

  test.beforeAll(async () => {
    ny = await onboardNewYorkClinic();
  });
  test.afterAll(async () => {
    await ny?.api.dispose();
  });

  test('the New York clinic reports its zone', async () => {
    const me = await ny.api.get('/api/v1/auth/me');
    expect(me.status()).toBe(200);
    expect((await me.json()).timezone).toBe(NY);
  });

  test('public booking slots are 10:00–17:00 New York time on the requested New York day', async ({ anon }) => {
    const res = await anon.get(`/api/v1/public/booking/${ny.firmCode}/slots`, {
      params: { practitioner_id: ny.practitionerId, service_id: ny.serviceId, date: day },
    });
    expect(res.status(), await res.text()).toBe(200);
    const { slots } = (await res.json()) as { slots: string[] };
    expect(slots.map((s) => wallClock(s, NY))).toEqual([
      '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30',
      '14:00', '14:30', '15:00', '15:30', '16:00', '16:30', '17:00', // 17:00 + 50 min ends by 18:00
    ]);
    for (const s of slots) expect(localDate(s, NY)).toBe(day);
  });

  test('booking the 10:00 New York slot succeeds and takes the slot', async ({ anon }) => {
    const params = { practitioner_id: ny.practitionerId, service_id: ny.serviceId, date: day };
    const { slots } = await (await anon.get(`/api/v1/public/booking/${ny.firmCode}/slots`, { params })).json();
    const tenAm = `${day}T10:00:00${offsetOn(day, NY)}`;
    expect(new Date(slots[0]).getTime()).toBe(new Date(tenAm).getTime());

    const data = {
      service_id: ny.serviceId,
      practitioner_id: ny.practitionerId,
      scheduled_at: tenAm,
      patient: { first_name: uniq('Tz'), last_name: 'Patient', phone: ALLOW_LISTED_PHONE },
    };
    const booked = await anon.post(`/api/v1/public/booking/${ny.firmCode}`, { data });
    expect(booked.status(), await booked.text()).toBe(200);
    const after = await (await anon.get(`/api/v1/public/booking/${ny.firmCode}/slots`, { params })).json();
    expect(after.slots.map((s: string) => wallClock(s, NY))).not.toContain('10:00');
    // the same slot again is refused
    expect((await anon.post(`/api/v1/public/booking/${ny.firmCode}`, { data })).status()).toBe(409);
  });

  test('a time outside New York working hours is refused (409)', async ({ anon }) => {
    // 10:00 IST on that day is the middle of the New York night
    const data = {
      service_id: ny.serviceId,
      practitioner_id: ny.practitionerId,
      scheduled_at: `${laterDay}T10:00:00+05:30`,
      patient: { first_name: uniq('Tz'), last_name: 'Patient', phone: ALLOW_LISTED_PHONE },
    };
    const res = await anon.post(`/api/v1/public/booking/${ny.firmCode}`, { data });
    expect(res.status()).toBe(409);
    expect((await res.json()).message).toBe('That slot is no longer available');
  });

  test('the dashboard week starts Monday 00:00 and the month on the 1st, New York time', async () => {
    const res = await ny.api.get('/api/v1/analytics/overview');
    expect(res.status(), await res.text()).toBe(200);
    const { week_start, month_start } = await res.json();
    expect([weekday(week_start, NY), wallClock(week_start, NY)]).toEqual(['Mon', '00:00']);
    expect(wallClock(month_start, NY)).toBe('00:00');
    expect(localDate(month_start, NY)).toBe(`${localDate(new Date(), NY).slice(0, 7)}-01`);
  });

  test('a 22:00 New York session counts on its New York day in availability and stats', async () => {
    const patient = await ny.api.post('/api/v1/patients/', { data: { first_name: uniq('TzAvail'), last_name: 'Patient' } });
    expect(patient.status(), await patient.text()).toBe(200);
    const created = await ny.api.post('/api/v1/sessions/', {
      data: { patient_id: (await patient.json()).id, scheduled_at: `${laterDay}T22:00:00${offsetOn(laterDay, NY)}`, duration_minutes: 50 },
    });
    expect(created.status(), await created.text()).toBe(200);

    const avail = async (target_date: string) => {
      const res = await ny.api.get('/api/v1/schedules/availability', { params: { target_date } });
      expect(res.status(), await res.text()).toBe(200);
      return res.json();
    };
    expect(await avail(laterDay)).toEqual(expect.objectContaining({ date: laterDay, session_count: 1, booked_minutes: 50 }));
    const nextDay = localDate(new Date(new Date(`${laterDay}T12:00:00Z`).getTime() + 86_400_000), 'UTC');
    expect(await avail(nextDay)).toEqual(expect.objectContaining({ session_count: 0, booked_minutes: 0 }));

    const stats = await ny.api.get('/api/v1/schedules/stats', { params: { date_from: laterDay, date_to: laterDay } });
    expect(stats.status(), await stats.text()).toBe(200);
    expect(await stats.json()).toEqual(expect.objectContaining({ totalSessions: 1, upcomingSessions: 1 }));
    const nextStats = await ny.api.get('/api/v1/schedules/stats', { params: { date_from: nextDay, date_to: nextDay } });
    expect((await nextStats.json()).totalSessions).toBe(0);
  });

  test('availability needs a token (401)', async ({ anon }) => {
    expect((await anon.get('/api/v1/schedules/availability', { params: { target_date: day } })).status()).toBe(401);
  });

  test('the Kolkata demo clinic is unchanged: slots and week in IST', async ({ anon, api, auth }) => {
    const service = await api.post('/api/v1/catalog/services', {
      data: { name: uniq('Therapy'), description: 'e2e', duration_minutes: 50, price: 0, currency: 'INR' },
    });
    expect(service.status(), await service.text()).toBe(201);
    const info = await (await anon.get(`/api/v1/public/booking/${auth.firmCode}`)).json();
    const istDay = localDate(new Date(Date.now() + 8 * 86_400_000), IST);
    const res = await anon.get(`/api/v1/public/booking/${auth.firmCode}/slots`, {
      params: { practitioner_id: info.practitioners[0].id, service_id: info.services[0].id, date: istDay },
    });
    expect(res.status(), await res.text()).toBe(200);
    const { slots } = (await res.json()) as { slots: string[] };
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) {
      expect(localDate(s, IST)).toBe(istDay);
      expect(wallClock(s, IST) >= '10:00' && wallClock(s, IST) <= '17:30').toBe(true);
    }

    const { week_start } = await (await api.get('/api/v1/analytics/overview')).json();
    expect([weekday(week_start, IST), wallClock(week_start, IST)]).toEqual(['Mon', '00:00']);
  });
});
