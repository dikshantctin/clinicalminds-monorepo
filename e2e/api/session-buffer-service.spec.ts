import { request as pwRequest } from '@playwright/test';
import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { env, DEMO_PATIENT } from '../src/env';
import { OwnClinic, OwnMember, deleteClinic, onboardOwnClinic } from '../src/clinics';
import { addDays, nextWeekday } from '../src/days';

/**
 * Capacity slice d. Each session keeps its own notes buffer (the clinic's 10 minutes unless the booking
 * sets one), and that buffer blocks the clinician's calendar for staff bookings and public slots alike.
 * A patient has a usual service; a staff booking that names a service takes its length.
 * A fresh clinic (Mon–Sat 10:00–18:00, buffer 10, one 50-minute service), so no other spec's sessions interfere.
 */
const wall = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));

test.describe('session buffer and usual service', () => {
  requireApi();
  requireAuth();
  test.describe.configure({ mode: 'serial' });

  let clinic: OwnClinic;
  let therapist: OwnMember;
  let desk: OwnMember;
  let patientId: string;
  let longServiceId: string;
  // one base, so the days stay Tue < Wed < Thu of one week whatever today is
  const tuesday = nextWeekday(2, 3);
  const wednesday = addDays(tuesday, 1);
  const thursday = addDays(tuesday, 2);
  const at = (day: string, hhmm: string) => `${day}T${hhmm}:00+05:30`;

  test.beforeAll(async () => {
    clinic = await onboardOwnClinic('buffer', ['THERAPIST', 'SUPPORT_STAFF']);
    [therapist, desk] = clinic.members;
    const patient = await clinic.api.post('/api/v1/patients/', { data: { first_name: 'Buffer', last_name: 'Patient' } });
    expect(patient.status(), await patient.text()).toBe(200);
    patientId = (await patient.json()).id;
    const long = await clinic.api.post('/api/v1/catalog/services', {
      data: { name: 'Long session', description: 'e2e', duration_minutes: 90, price: 0, currency: 'INR' },
    });
    expect(long.status(), await long.text()).toBe(201);
    longServiceId = (await long.json()).id;
  });
  test.afterAll(async () => {
    for (const m of clinic?.members ?? []) await m.api.dispose();
    await clinic?.api.dispose();
    if (clinic) await deleteClinic(clinic.adminEmail);
  });

  const book = (body: Record<string, unknown>) => clinic.api.post('/api/v1/sessions/', { data: { patient_id: patientId, ...body } });

  test('a session takes the clinic buffer unless the booking sets its own (0–60)', async () => {
    const plain = await book({ scheduled_at: at(thursday, '10:00') });
    expect(plain.status(), await plain.text()).toBe(200);
    const id = (await plain.json()).id;
    expect((await plain.json()).buffer_minutes).toBe(10);
    expect((await (await clinic.api.get(`/api/v1/sessions/${id}`)).json()).buffer_minutes).toBe(10);

    const none = await book({ scheduled_at: at(thursday, '12:00'), buffer_minutes: 0 });
    expect(none.status(), await none.text()).toBe(200);
    expect((await none.json()).buffer_minutes).toBe(0);
    const list = await (await clinic.api.get('/api/v1/sessions/', { params: { search: 'Buffer', limit: 50 } })).json();
    const byId = (sid: string) => list.sessions.find((s: { id: string }) => s.id === sid);
    expect(byId(id).buffer_minutes).toBe(10);
    expect(byId((await none.json()).id).buffer_minutes).toBe(0);

    expect((await book({ scheduled_at: at(thursday, '15:00'), buffer_minutes: 61 })).status()).toBe(422);
    expect((await book({ scheduled_at: at(thursday, '15:00'), buffer_minutes: -1 })).status()).toBe(422);
  });

  test('the buffer blocks the calendar for staff: after a session, and after the new booking itself', async () => {
    // 10:00–10:50 + the default 10 → busy until 11:00
    expect((await book({ scheduled_at: at(tuesday, '10:00') })).status()).toBe(200);
    const inBuffer = await book({ scheduled_at: at(tuesday, '10:55') });
    expect(inBuffer.status()).toBe(409);
    expect((await inBuffer.json()).message).toBe('The clinician already has a session at that time');
    // 11:00 with no buffer → busy 11:00–11:50, so 11:50 is free
    expect((await book({ scheduled_at: at(tuesday, '11:00'), buffer_minutes: 0 })).status()).toBe(200);
    expect((await book({ scheduled_at: at(tuesday, '11:50') })).status()).toBe(200);
    // 14:00 session; a 13:05 booking runs to 13:55, and its own 10-minute buffer to 14:05 → clash; with no buffer it fits
    expect((await book({ scheduled_at: at(tuesday, '14:00'), buffer_minutes: 0 })).status()).toBe(200);
    expect((await book({ scheduled_at: at(tuesday, '13:05') })).status()).toBe(409);
    expect((await book({ scheduled_at: at(tuesday, '13:05'), buffer_minutes: 0 })).status()).toBe(200);
  });

  test("public slots keep each session's own buffer clear", async () => {
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
    // a 25-minute session at 10:00: with no buffer the clinician is free at 10:30; with the default 10, not until 11:00
    const day1 = addDays(tuesday, 7);
    const day2 = addDays(tuesday, 8);
    expect((await book({ scheduled_at: at(day1, '10:00'), duration_minutes: 25, buffer_minutes: 0 })).status()).toBe(200);
    expect((await book({ scheduled_at: at(day2, '10:00'), duration_minutes: 25 })).status()).toBe(200);
    expect((await slots(day1)).slice(0, 2)).toEqual(['10:30', '11:00']);
    expect((await slots(day2)).slice(0, 2)).toEqual(['11:00', '11:30']);
  });

  test("a patient's usual service: set by staff (front desk too), shown on the record, refused when not this clinic's", async () => {
    const set = await desk.api.put(`/api/v1/patients/${patientId}`, { data: { usual_service_id: longServiceId } });
    expect(set.status(), await set.text()).toBe(200);
    expect((await set.json()).usual_service_id).toBe(longServiceId);
    expect((await (await clinic.api.get(`/api/v1/patients/${patientId}`)).json()).usual_service_id).toBe(longServiceId);
    const list = await (await clinic.api.get('/api/v1/patients/', { params: { search: 'Buffer' } })).json();
    expect(list.patients.find((p: { id: string }) => p.id === patientId).usual_service_id).toBe(longServiceId);

    const foreign = await clinic.api.put(`/api/v1/patients/${patientId}`, { data: { usual_service_id: '00000000-0000-4000-8000-000000000000' } });
    expect(foreign.status()).toBe(422);
    expect((await foreign.json()).message).toBe('Pick a service of this clinic');

    const cleared = await clinic.api.put(`/api/v1/patients/${patientId}`, { data: { usual_service_id: null } });
    expect(cleared.status(), await cleared.text()).toBe(200);
    expect((await cleared.json()).usual_service_id).toBeNull();
  });

  test('a booking that names a service takes its length; another clinic’s service → 422', async () => {
    const long = await book({ scheduled_at: at(wednesday, '10:00'), service_id: longServiceId });
    expect(long.status(), await long.text()).toBe(200);
    expect((await long.json()).duration_minutes).toBe(90);
    // 10:00–11:30 + 10 → busy until 11:40
    expect((await book({ scheduled_at: at(wednesday, '11:35') })).status()).toBe(409);
    const bad = await book({ scheduled_at: at(wednesday, '15:00'), service_id: '00000000-0000-4000-8000-000000000000' });
    expect(bad.status()).toBe(422);
    expect((await bad.json()).message).toBe('Pick a service of this clinic');
  });

  test('every staff member can read the services to book with; a patient cannot (403)', async () => {
    for (const who of [therapist, desk]) {
      const res = await who.api.get('/api/v1/catalog/services', { params: { is_active: true } });
      expect(res.status()).toBe(200);
      expect((await res.json()).services.map((s: { name: string }) => s.name).sort()).toEqual(['Long session', 'Therapy']);
    }
    expect((await therapist.api.post('/api/v1/catalog/services', { data: { name: 'x', duration_minutes: 30, price: 0 } })).status()).toBe(403);
    const anon = await pwRequest.newContext({ baseURL: env.API_URL });
    try {
      const login = await (await anon.post('/api/v1/auth/login', { data: { ...DEMO_PATIENT, audience: 'patient' } })).json();
      const res = await anon.get('/api/v1/catalog/services', {
        headers: { Authorization: `Bearer ${login.access_token}`, 'X-Tenant-ID': login.tenant.id },
      });
      expect(res.status()).toBe(403);
    } finally {
      await anon.dispose();
    }
  });
});
