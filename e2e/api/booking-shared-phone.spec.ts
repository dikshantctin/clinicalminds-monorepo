import { APIRequestContext } from '@playwright/test';
import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { uniq } from '../src/env';

/**
 * Several people can book on one phone (a parent booking for a child). After the phone is verified, the booking
 * page lists the clinic's patients on that number (full names) and the person booking must choose one of them or
 * "someone else"; only "someone else" creates a new patient. A booking that makes no choice while patients exist
 * on the number is refused, so a second record is never created by accident.
 */
const TEST_PHONE = '+919876543210'; // VERIFICATION_TEST_PHONES: no phone.email round-trip
const inDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
type Listed = { id: string; first_name: string; last_name: string };

async function setup(anon: APIRequestContext, api: APIRequestContext, firmCode: string) {
  const svc = await api.post('/api/v1/catalog/services', { data: { name: uniq('SharedPhone'), duration_minutes: 50, price: 0, currency: 'INR' } });
  expect(svc.status(), await svc.text()).toBe(201);
  const service = await svc.json();
  const info = await (await anon.get(`/api/v1/public/booking/${firmCode}`)).json();
  const practitioner = info.practitioners[0];
  const { slots } = await (await anon.get(`/api/v1/public/booking/${firmCode}/slots`, {
    params: { practitioner_id: practitioner.id, service_id: service.id, date: inDays(10) },
  })).json();
  expect(slots.length).toBeGreaterThanOrEqual(5); // 30-min slots, 50-min sessions: book every other slot
  return { service, practitioner, slots: slots as string[] };
}

test.describe('public booking on a shared phone number', () => {
  requireApi();
  requireAuth();

  test('the verified phone lists its patients; the booker picks one or "someone else"; no choice → 409', async ({ anon, api, auth }) => {
    const { service, practitioner, slots } = await setup(anon, api, auth.firmCode);
    const book = (extra: Record<string, unknown>, slot: string) => anon.post(`/api/v1/public/booking/${auth.firmCode}`, {
      data: { service_id: service.id, practitioner_id: practitioner.id, scheduled_at: slot, ...extra },
    });
    const sessions: string[] = [];
    const patients = new Set<string>();
    try {
      // a parent already registered on the number
      const asha = { first_name: uniq('Asha'), last_name: 'Kapoor' };
      const first = await book({ patient: { ...asha, phone: TEST_PHONE }, new_patient: true }, slots[slots.length - 1]);
      expect(first.status(), await first.text()).toBe(200);
      const a = await first.json();
      sessions.push(a.session_id); patients.add(a.patient_id);

      const lookup = await anon.post(`/api/v1/public/booking/${auth.firmCode}/patients`, { data: { phone: TEST_PHONE } });
      expect(lookup.status(), await lookup.text()).toBe(200);
      const listed: Listed[] = (await lookup.json()).patients;
      expect(listed).toContainEqual({ id: a.patient_id, first_name: asha.first_name, last_name: 'Kapoor' });

      // no choice while patients exist on the number → refused, nothing created
      const vague = await book({ patient: { first_name: 'Asha', last_name: 'K', phone: TEST_PHONE } }, slots[slots.length - 3]);
      expect(vague.status()).toBe(409);
      expect((await vague.json()).message).toBe('Choose who this booking is for');

      // "I'm Asha": books for the existing record, whatever was typed
      const again = await book({ patient: { phone: TEST_PHONE }, patient_id: a.patient_id }, slots[slots.length - 3]);
      expect(again.status(), await again.text()).toBe(200);
      const b = await again.json();
      sessions.push(b.session_id);
      expect(b.patient_id).toBe(a.patient_id);

      // "Someone else": Devesh gets his own record on the same phone
      const devesh = { first_name: uniq('Devesh'), last_name: 'Kapoor' };
      const other = await book({ patient: { ...devesh, phone: TEST_PHONE }, new_patient: true }, slots[slots.length - 5]);
      expect(other.status(), await other.text()).toBe(200);
      const c = await other.json();
      sessions.push(c.session_id); patients.add(c.patient_id);
      expect(c.patient_id).not.toBe(a.patient_id);
      const record = await (await api.get(`/api/v1/patients/${c.patient_id}`)).json();
      expect([record.first_name, record.last_name, record.phone]).toEqual([devesh.first_name, 'Kapoor', TEST_PHONE]);
      const after: Listed[] = (await (await anon.post(`/api/v1/public/booking/${auth.firmCode}/patients`, { data: { phone: TEST_PHONE } })).json()).patients;
      expect(after.map((p) => p.id)).toEqual(expect.arrayContaining([a.patient_id, c.patient_id]));
    } finally {
      for (const id of sessions) await api.post(`/api/v1/sessions/${id}/cancel`, { data: { reason: 'e2e cleanup' } });
      for (const id of patients) await api.delete(`/api/v1/patients/${id}`);
      await api.delete(`/api/v1/catalog/services/${service.id}`);
    }
  });

  test('a patient id from another number → 400; "someone else" without a name → 422; an unverified phone → 400', async ({ anon, api, auth }) => {
    const { service, practitioner, slots } = await setup(anon, api, auth.firmCode);
    const elsewhere = await (await api.post('/api/v1/patients/', { data: { first_name: uniq('Elsewhere'), last_name: 'Patient', phone: '+919811100000' } })).json();
    try {
      const wrong = await anon.post(`/api/v1/public/booking/${auth.firmCode}`, {
        data: { service_id: service.id, practitioner_id: practitioner.id, scheduled_at: slots[slots.length - 1], patient: { phone: TEST_PHONE }, patient_id: elsewhere.id },
      });
      expect(wrong.status()).toBe(400);
      expect((await wrong.json()).message).toBe('That patient is not registered on this phone number');

      const nameless = await anon.post(`/api/v1/public/booking/${auth.firmCode}`, {
        data: { service_id: service.id, practitioner_id: practitioner.id, scheduled_at: slots[slots.length - 1], patient: { phone: TEST_PHONE }, new_patient: true },
      });
      expect(nameless.status()).toBe(422);

      const unverified = await anon.post(`/api/v1/public/booking/${auth.firmCode}/patients`, { data: { phone: '+919000000001' } });
      expect(unverified.status()).toBe(400);
      expect((await unverified.json()).message).toBe('Phone verification required');
    } finally {
      await api.delete(`/api/v1/patients/${elsewhere.id}`);
      await api.delete(`/api/v1/catalog/services/${service.id}`);
    }
  });
});
