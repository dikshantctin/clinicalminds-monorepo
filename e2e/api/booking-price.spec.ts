import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { uniq } from '../src/env';

/**
 * The catalog stores a service price in rupees; a booking charges `round(price * 100)` paise, and only
 * when that is at least Razorpay's ₹1 minimum. The public booking page info therefore carries the
 * charged amount itself (`price_paise`) and whether booking will take payment (`paid_at_booking`),
 * so the page never re-derives either from the rupee float.
 */
const TEST_PHONE = '+919876543210'; // test-listed: no phone.email round-trip

// a day no other spec books on (booking/journey day+2, api payments day+3, web payments day+4)
const bookingDate = () => {
  const d = new Date();
  d.setDate(d.getDate() + 6);
  return d.toISOString().slice(0, 10);
};

async function createService(api: any, price: number) {
  const res = await api.post('/api/v1/catalog/services', {
    data: { name: uniq('Priced consult'), description: 'e2e', duration_minutes: 50, price, currency: 'INR' },
  });
  expect(res.status(), await res.text()).toBe(201);
  return res.json();
}

// Walk the day's free slots from the end, retrying on 409 (a parallel spec may take the same one).
async function book(anon: any, firmCode: string, serviceId: string) {
  const info = await (await anon.get(`/api/v1/public/booking/${firmCode}`)).json();
  const practitioner = info.practitioners[0];
  const { slots } = await (
    await anon.get(`/api/v1/public/booking/${firmCode}/slots`, {
      params: { practitioner_id: practitioner.id, service_id: serviceId, date: bookingDate() },
    })
  ).json();
  expect(slots.length, 'free slots to book').toBeGreaterThan(0);
  for (const slot of [...slots].reverse()) {
    const res = await anon.post(`/api/v1/public/booking/${firmCode}`, {
      data: { service_id: serviceId, practitioner_id: practitioner.id, scheduled_at: slot, patient: { first_name: uniq('Price'), last_name: 'Patient', phone: TEST_PHONE } },
    });
    if (res.status() === 409) continue;
    expect(res.status(), await res.text()).toBe(200);
    return res.json();
  }
  throw new Error('no free slot could be booked');
}

test.describe('public booking prices: what the page shows is what is charged', () => {
  requireApi();
  requireAuth();

  test('a ₹1,500.50 service is listed as 150050 paise, and a booking charges exactly 150050', async ({ anon, api, auth }) => {
    const service = await createService(api, 1500.5);
    let sessionId: string | undefined;
    try {
      expect(service.price).toBe(1500.5);
      const info = await (await anon.get(`/api/v1/public/booking/${auth.firmCode}`)).json();
      const listed = info.services.find((s: { id: string }) => s.id === service.id);
      expect(listed).toEqual({
        id: service.id, name: service.name, description: 'e2e', duration_minutes: 50,
        price: 1500.5, price_paise: 150050, currency: 'INR', paid_at_booking: info.payments_enabled,
      });

      test.skip(!info.payments_enabled, 'the demo clinic has no Razorpay account connected: order amount not exercised');
      const conf = await book(anon, auth.firmCode, service.id);
      sessionId = conf.session_id;
      expect(conf.payment_status).toBe('pending');
      expect(conf.payment.amount_paise).toBe(150050);
      expect(conf.payment.currency).toBe('INR');
    } finally {
      if (sessionId) await api.post(`/api/v1/sessions/${sessionId}/cancel`, { data: { reason: 'e2e cleanup' } });
      await api.delete(`/api/v1/catalog/services/${service.id}`);
    }
  });

  test('₹0.50 is below the ₹1 minimum: listed as 50 paise, not paid at booking, no order', async ({ anon, api, auth }) => {
    const service = await createService(api, 0.5);
    let sessionId: string | undefined;
    try {
      const info = await (await anon.get(`/api/v1/public/booking/${auth.firmCode}`)).json();
      const listed = info.services.find((s: { id: string }) => s.id === service.id);
      expect(listed.price_paise).toBe(50);
      expect(listed.paid_at_booking).toBe(false); // even when the clinic has a gateway

      test.skip(!info.payments_enabled, 'the demo clinic has no Razorpay account connected: "no order" is trivially true');
      const conf = await book(anon, auth.firmCode, service.id);
      sessionId = conf.session_id;
      expect(conf.payment).toBeNull();
      expect(conf.payment_status).toBeNull();
    } finally {
      if (sessionId) await api.post(`/api/v1/sessions/${sessionId}/cancel`, { data: { reason: 'e2e cleanup' } });
      await api.delete(`/api/v1/catalog/services/${service.id}`);
    }
  });

  test('a free service is listed as 0 paise and not paid at booking', async ({ anon, api, auth }) => {
    const service = await createService(api, 0);
    try {
      const info = await (await anon.get(`/api/v1/public/booking/${auth.firmCode}`)).json();
      const listed = info.services.find((s: { id: string }) => s.id === service.id);
      expect(listed.price_paise).toBe(0);
      expect(listed.paid_at_booking).toBe(false);
    } finally {
      await api.delete(`/api/v1/catalog/services/${service.id}`);
    }
  });
});
