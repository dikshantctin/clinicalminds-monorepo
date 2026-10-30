import { request as pwRequest, APIRequestContext } from '@playwright/test';
import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { env, uniq, DEMO_THERAPIST } from '../src/env';

/**
 * The daily schedule is the clinic's local day (platform_firms.timezone, default Asia/Kolkata):
 * a 10:00 IST booking sits in the 10:00 slot, and a 00:30 IST booking (18:30 UTC the day before)
 * belongs to the IST day it happens on.
 */

const CLINIC_TZ = 'Asia/Kolkata';
/** "YYYY-MM-DD" of `d` in the clinic's zone. */
const clinicDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: CLINIC_TZ }).format(d);
const shiftDay = (ymd: string, days: number) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

async function loginAs(creds: { email: string; password: string }): Promise<APIRequestContext> {
  const anon = await pwRequest.newContext({ baseURL: env.API_URL });
  const res = await anon.post('/api/v1/auth/login', { data: creds });
  const text = await res.text();
  await anon.dispose();
  expect(res.status(), `login as ${creds.email}: ${text}`).toBe(200);
  const body = JSON.parse(text);
  return pwRequest.newContext({
    baseURL: env.API_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${body.access_token}`, 'X-Tenant-ID': body.tenant.id },
  });
}

test.describe('/api/v1/schedules/daily in the clinic time zone', () => {
  requireApi();
  requireAuth();

  test('a 10:00 IST session is in the 10:00 slot of its IST day; 00:30 IST is not on the UTC day', async ({ api, anon }) => {
    const day = clinicDate(new Date(Date.now() + 3 * 86_400_000));
    const patient = await (await api.post('/api/v1/patients/', { data: { first_name: uniq('TzSched'), last_name: 'Patient' } })).json();
    const name = `${patient.first_name} Patient`;
    try {
      for (const at of [`${day}T10:00:00+05:30`, `${day}T00:30:00+05:30`]) {
        const res = await api.post('/api/v1/sessions/', { data: { patient_id: patient.id, scheduled_at: at, duration_minutes: 50 } });
        expect(res.status(), await res.text()).toBe(200);
      }

      const res = await api.get('/api/v1/schedules/daily', { params: { schedule_date: day } });
      expect(res.status(), await res.text()).toBe(200);
      const body = await res.json();
      expect(body).toEqual(expect.objectContaining({ date: day, timezone: CLINIC_TZ, viewScope: 'all' }));
      const mine = body.sessions.filter((s: { patientName: string }) => s.patientName === name);
      expect(mine.map((s: { time: string }) => s.time)).toEqual(['00:30', '10:00']);

      // the 00:30 IST session is 19:00 UTC on the previous day; it must not appear there
      const before = await (await api.get('/api/v1/schedules/daily', { params: { schedule_date: shiftDay(day, -1) } })).json();
      expect(before.sessions.filter((s: { patientName: string }) => s.patientName === name)).toEqual([]);

      // the therapist sees only their own sessions (these belong to the admin who booked them)
      const therapist = await loginAs(DEMO_THERAPIST);
      try {
        const own = await (await therapist.get('/api/v1/schedules/daily', { params: { schedule_date: day } })).json();
        expect(own.viewScope).toBe('personal');
        expect(own.sessions.filter((s: { patientName: string }) => s.patientName === name)).toEqual([]);
      } finally {
        await therapist.dispose();
      }

      expect((await anon.get('/api/v1/schedules/daily', { params: { schedule_date: day } })).status()).toBe(401);
    } finally {
      await api.delete(`/api/v1/patients/${patient.id}`);
    }
  });

  test('without schedule_date it is today in the clinic zone', async ({ api }) => {
    const res = await api.get('/api/v1/schedules/daily');
    expect(res.status(), await res.text()).toBe(200);
    expect((await res.json()).date).toBe(clinicDate(new Date()));
  });

  test('/auth/me carries the clinic zone the forms use for offsets', async ({ api }) => {
    const res = await api.get('/api/v1/auth/me');
    expect(res.status()).toBe(200);
    expect((await res.json()).timezone).toBe(CLINIC_TZ);
  });
});
