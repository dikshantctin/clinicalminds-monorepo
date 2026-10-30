import { APIRequestContext } from '@playwright/test';
import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { uniq } from '../src/env';

/**
 * Several people can book on one phone (a parent booking for a child, a couple sharing a number).
 * A booking attaches to an existing patient on that phone only when the typed first and last name match
 * (case and surrounding spaces ignored); otherwise it creates a new patient. Before, it attached to the
 * newest patient on the number and threw the typed name away.
 */
const TEST_PHONE = '+919876543210'; // VERIFICATION_TEST_PHONES: no phone.email round-trip
const inDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

test.describe('public booking on a shared phone number', () => {
  requireApi();
  requireAuth();

  test('a different name on the same phone is a new patient; the same name (any case) is the same patient', async ({ anon, api, auth }) => {
    const svc = await api.post('/api/v1/catalog/services', { data: { name: uniq('SharedPhone'), duration_minutes: 50, price: 0, currency: 'INR' } });
    expect(svc.status(), await svc.text()).toBe(201);
    const service = await svc.json();
    const info = await (await anon.get(`/api/v1/public/booking/${auth.firmCode}`)).json();
    const practitioner = info.practitioners[0];
    const slotsRes = await anon.get(`/api/v1/public/booking/${auth.firmCode}/slots`, {
      params: { practitioner_id: practitioner.id, service_id: service.id, date: inDays(9) },
    });
    const { slots } = await slotsRes.json();
    expect(slots.length).toBeGreaterThanOrEqual(5); // 30-min slots, 50-min sessions: book every other slot

    const parent = { first_name: uniq('Asha'), last_name: 'Kapoor' };
    const child = { first_name: uniq('Rohan'), last_name: 'Kapoor' };
    const book = async (who: { first_name: string; last_name: string }, slot: string) => {
      const res = await anon.post(`/api/v1/public/booking/${auth.firmCode}`, {
        data: { service_id: service.id, practitioner_id: practitioner.id, scheduled_at: slot, patient: { ...who, phone: TEST_PHONE } },
      });
      expect(res.status(), await res.text()).toBe(200);
      return res.json() as Promise<{ session_id: string; patient_id: string }>;
    };

    const sessions: string[] = [];
    const patients = new Set<string>();
    try {
      const first = await book(parent, slots[slots.length - 1]);
      const second = await book(child, slots[slots.length - 3]);
      const third = await book({ first_name: `  ${parent.first_name.toUpperCase()} `, last_name: 'kapoor' }, slots[slots.length - 5]);
      sessions.push(first.session_id, second.session_id, third.session_id);
      [first, second, third].forEach((b) => patients.add(b.patient_id));

      expect(second.patient_id).not.toBe(first.patient_id);
      expect(third.patient_id).toBe(first.patient_id);
      const childRecord = await (await api.get(`/api/v1/patients/${second.patient_id}`)).json();
      expect([childRecord.first_name, childRecord.last_name]).toEqual([child.first_name, child.last_name]);
      expect(childRecord.phone).toBe(TEST_PHONE);
    } finally {
      for (const id of sessions) await api.post(`/api/v1/sessions/${id}/cancel`, { data: { reason: 'e2e cleanup' } });
      for (const id of patients) await api.delete(`/api/v1/patients/${id}`);
      await api.delete(`/api/v1/catalog/services/${service.id}`);
    }
  });

  test('a phone that is not verified is still refused (400)', async ({ anon, auth }) => {
    const info = await (await anon.get(`/api/v1/public/booking/${auth.firmCode}`)).json();
    const res = await anon.post(`/api/v1/public/booking/${auth.firmCode}`, {
      data: {
        service_id: info.services[0].id, practitioner_id: info.practitioners[0].id, scheduled_at: new Date(Date.now() + 9 * 86400_000).toISOString(),
        patient: { first_name: 'Not', last_name: 'Verified', phone: '+919000000001' },
      },
    });
    expect(res.status()).toBe(400);
  });
});
