import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { uniq } from '../src/env';

/** On VERIFICATION_TEST_PHONES → the backend skips the phone.email round-trip for this number. */
const TEST_PHONE = '+919876543210';
const DEMO_THERAPIST = { email: 'therapist.jane@democlinic.com', password: 'Password123!', name: 'Jane Doe' };

const dayAfterTomorrow = () => {
  const d = new Date();
  d.setDate(d.getDate() + 2);
  return d.toISOString().slice(0, 10);
};

async function ensureService(api: any) {
  const res = await api.post('/api/v1/catalog/services', {
    data: { name: uniq('Therapy'), description: 'e2e', duration_minutes: 50, price: 1500, currency: 'INR' },
  });
  expect(res.status(), await res.text()).toBe(201);
  return res.json();
}

test.describe('public self-booking (/api/v1/public/booking)', () => {
  requireApi();
  requireAuth();

  test('unknown clinic code → 404, no token needed', async ({ anon }) => {
    expect((await anon.get('/api/v1/public/booking/no-such-clinic')).status()).toBe(404);
  });

  test('the booking page info lists services and clinicians (never admins)', async ({ anon, api, auth }) => {
    await ensureService(api);
    const res = await anon.get(`/api/v1/public/booking/${auth.firmCode}`);
    expect(res.status(), await res.text()).toBe(200);
    const info = await res.json();
    expect(info.clinic.firm_code).toBe(auth.firmCode);
    expect(info.services.length).toBeGreaterThan(0);
    expect(info.practitioners.length).toBeGreaterThan(0);
    expect(info.practitioners.map((p: { role: string }) => p.role)).not.toContain('ADMIN');
  });

  test('a booking becomes a session on the clinic and the therapist calendars; the slot is gone; double-booking is refused', async ({ anon, api, auth }) => {
    await ensureService(api);
    const info = await (await anon.get(`/api/v1/public/booking/${auth.firmCode}`)).json();
    const service = info.services[0];
    const practitioner = info.practitioners.find((p: { name: string }) => p.name === DEMO_THERAPIST.name);
    expect(practitioner, 'seeded therapist must be bookable').toBeTruthy();
    const date = dayAfterTomorrow();
    const slotParams = { practitioner_id: practitioner.id, service_id: service.id, date };

    const slotsRes = await anon.get(`/api/v1/public/booking/${auth.firmCode}/slots`, { params: slotParams });
    expect(slotsRes.status(), await slotsRes.text()).toBe(200);
    const { slots } = await slotsRes.json();
    expect(slots.length).toBeGreaterThan(0);
    const slot: string = slots[slots.length - 1]; // last slot of the day: least likely to collide with other specs

    const body = {
      service_id: service.id,
      practitioner_id: practitioner.id,
      scheduled_at: slot,
      patient: { first_name: uniq('Book'), last_name: 'Patient', phone: TEST_PHONE, email: 'booking@example.com' },
      notes: 'e2e booking',
    };
    const booked = await anon.post(`/api/v1/public/booking/${auth.firmCode}`, { data: body });
    expect(booked.status(), await booked.text()).toBe(200);
    const conf = await booked.json();
    expect(conf).toEqual(expect.objectContaining({ practitioner_name: DEMO_THERAPIST.name, service_name: service.name, duration_minutes: 50 }));

    try {
      // the slot is no longer offered
      const after = await (await anon.get(`/api/v1/public/booking/${auth.firmCode}/slots`, { params: slotParams })).json();
      expect(after.slots).not.toContain(slot);
      // nobody else can take it either
      expect((await anon.post(`/api/v1/public/booking/${auth.firmCode}`, { data: body })).status()).toBe(409);

      // clinic view (admin): the session exists, flagged as booked online (the list is newest-first: scope it to
      // the booked day, or sessions other runs left on later days push this one past any page size)
      const dayParams = { date_from: date, date_to: date, limit: 500 };
      const clinic = await (await api.get('/api/v1/sessions/', { params: dayParams })).json();
      const row = clinic.sessions.find((s: { id: string }) => s.id === conf.session_id);
      expect(row).toBeTruthy();
      expect(row.booked_via).toBe('web');
      expect(row.therapist_id).toBe(practitioner.id);

      // therapist view: Jane logs in and sees it in HER list (therapists only see their own sessions)
      const login = await (await anon.post('/api/v1/auth/login', { data: { email: DEMO_THERAPIST.email, password: DEMO_THERAPIST.password } })).json();
      const mine = await (
        await anon.get('/api/v1/sessions/', {
          params: dayParams,
          headers: { Authorization: `Bearer ${login.access_token}`, 'X-Tenant-ID': login.tenant.id },
        })
      ).json();
      expect(mine.sessions.map((s: { id: string }) => s.id)).toContain(conf.session_id);
      for (const s of mine.sessions) expect(s.therapist_id).toBe(practitioner.id);
    } finally {
      // cancelling a booked session must work (its treatment_modality is null)
      const cancelled = await api.post(`/api/v1/sessions/${conf.session_id}/cancel`, { data: { reason: 'e2e cleanup' } });
      expect(cancelled.status(), await cancelled.text()).toBe(200);
    }
  });

  test('one slot, booked by several patients at once: exactly one booking wins, the rest are 409', async ({ anon, api, auth }) => {
    const service = await ensureService(api);
    const info = await (await anon.get(`/api/v1/public/booking/${auth.firmCode}`)).json();
    const practitioner = info.practitioners.find((p: { name: string }) => p.name === DEMO_THERAPIST.name);
    // a day no other spec books on, so the only contention is the one this test creates
    const d = new Date();
    d.setDate(d.getDate() + 7);
    const slotParams = { practitioner_id: practitioner.id, service_id: service.id, date: d.toISOString().slice(0, 10) };
    const { slots } = await (await anon.get(`/api/v1/public/booking/${auth.firmCode}/slots`, { params: slotParams })).json();
    expect(slots.length).toBeGreaterThan(0);
    const book = (slot: string) =>
      anon.post(`/api/v1/public/booking/${auth.firmCode}`, {
        data: { service_id: service.id, practitioner_id: practitioner.id, scheduled_at: slot, patient: { first_name: uniq('Race'), last_name: 'Patient', phone: TEST_PHONE } },
      });
    // walk the free slots: a slot a parallel copy of this test took first answers 409 to all four — try the next
    for (const slot of slots) {
      const results = await Promise.all([book(slot), book(slot), book(slot), book(slot)]);
      const won = results.filter((r) => r.status() === 200);
      try {
        if (won.length === 0 && results.every((r) => r.status() === 409)) continue;
        expect(results.map((r) => r.status()).sort()).toEqual([200, 409, 409, 409]);
        for (const r of results.filter((x) => x.status() === 409)) expect((await r.json()).message).toBe('That slot is no longer available');
        return;
      } finally {
        for (const r of won) await api.post(`/api/v1/sessions/${(await r.json()).session_id}/cancel`, { data: { reason: 'e2e cleanup' } });
      }
    }
    throw new Error('every slot of the day was taken by parallel specs');
  });

  test('a phone that is not test-listed needs phone.email proof', async ({ anon, api, auth }) => {
    await ensureService(api);
    const info = await (await anon.get(`/api/v1/public/booking/${auth.firmCode}`)).json();
    const { slots } = await (
      await anon.get(`/api/v1/public/booking/${auth.firmCode}/slots`, {
        params: { practitioner_id: info.practitioners[0].id, service_id: info.services[0].id, date: dayAfterTomorrow() },
      })
    ).json();
    const data = {
      service_id: info.services[0].id,
      practitioner_id: info.practitioners[0].id,
      scheduled_at: slots[0],
      patient: { first_name: 'No', last_name: 'Proof', phone: '+919555555555' },
    };
    const res = await anon.post(`/api/v1/public/booking/${auth.firmCode}`, { data });
    expect(res.status()).toBe(400);
    expect((await res.json()).message).toBe('Phone verification required');
    // a forged user_json_url is rejected without leaking anything
    const forged = await anon.post(`/api/v1/public/booking/${auth.firmCode}`, { data: { ...data, user_json_url: 'https://evil.example.com/user_a.json' } });
    expect(forged.status()).toBe(400);
  });

  test('a time that is not on the slot grid is refused', async ({ anon, api, auth }) => {
    await ensureService(api);
    const info = await (await anon.get(`/api/v1/public/booking/${auth.firmCode}`)).json();
    const { slots } = await (
      await anon.get(`/api/v1/public/booking/${auth.firmCode}/slots`, {
        params: { practitioner_id: info.practitioners[0].id, service_id: info.services[0].id, date: dayAfterTomorrow() },
      })
    ).json();
    const offGrid = new Date(new Date(slots[0]).getTime() + 7 * 60_000).toISOString();
    const res = await anon.post(`/api/v1/public/booking/${auth.firmCode}`, {
      data: { service_id: info.services[0].id, practitioner_id: info.practitioners[0].id, scheduled_at: offGrid, patient: { first_name: 'Off', last_name: 'Grid', phone: TEST_PHONE } },
    });
    expect(res.status()).toBe(409);
  });
});
