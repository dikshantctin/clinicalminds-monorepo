import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { RAZORPAY, uniq } from '../src/env';

/**
 * Per-clinic payments: each clinic connects its OWN Razorpay account (Settings → Payments); patients who
 * book online pay the clinic. The platform never holds merchant keys.
 *
 * These specs use whatever Razorpay account the DEMO CLINIC already has stored in the database — connect
 * it once in the app (Settings → Payments) or with `backend/scripts/connect_demo_razorpay.py`. No secret
 * is read here: the server signs with the stored (encrypted) secret; the suite only needs the public
 * key_id, which `GET /payments/config` returns. Specs skip (not fail) when the demo clinic has no gateway.
 * `E2E_RAZORPAY_*` stays optional: set it only to exercise the write path that validates a fresh pair.
 */
const TEST_PHONE = '+919876543210';
const DEMO_THERAPIST = { email: 'therapist.jane@democlinic.com', password: 'Password123!' };
const haveSecret = Boolean(RAZORPAY.keyId && RAZORPAY.keySecret);
const NO_GATEWAY = 'the demo clinic has no Razorpay account connected — connect one in Settings → Payments (or run backend/scripts/connect_demo_razorpay.py)';

// a dedicated day so these bookings never contend with booking.spec / journey (day+2) or web payments (day+4)
const bookingDate = () => {
  const d = new Date();
  d.setDate(d.getDate() + 3);
  return d.toISOString().slice(0, 10);
};

/** The demo clinic's stored gateway, read from the API (no secret). */
async function gateway(api: any): Promise<{ ready: boolean; keyId: string | null; platformEnabled: boolean }> {
  const cfg = await (await api.get('/api/v1/payments/config')).json();
  return { ready: Boolean(cfg.platform_enabled && cfg.configured && cfg.enabled), keyId: cfg.key_id ?? null, platformEnabled: Boolean(cfg.platform_enabled) };
}

async function service(api: any, price: number) {
  const res = await api.post('/api/v1/catalog/services', {
    data: { name: uniq(price ? 'Paid consult' : 'Free intro'), description: 'e2e', duration_minutes: 50, price, currency: 'INR' },
  });
  expect(res.status(), await res.text()).toBe(201);
  return res.json();
}

// Walk the day's free slots from the end, retrying on 409 (another parallel spec may grab the same one).
async function bookASlot(anon: any, firmCode: string, serviceId: string) {
  const date = bookingDate();
  const info = await (await anon.get(`/api/v1/public/booking/${firmCode}`)).json();
  const practitioner = info.practitioners[0];
  const { slots } = await (
    await anon.get(`/api/v1/public/booking/${firmCode}/slots`, { params: { practitioner_id: practitioner.id, service_id: serviceId, date } })
  ).json();
  expect(slots.length, 'free slots to book').toBeGreaterThan(0);
  for (const slot of [...slots].reverse()) {
    const res = await anon.post(`/api/v1/public/booking/${firmCode}`, {
      data: { service_id: serviceId, practitioner_id: practitioner.id, scheduled_at: slot, patient: { first_name: uniq('Pay'), last_name: 'Patient', phone: TEST_PHONE } },
    });
    if (res.status() === 409) continue; // slot taken by a parallel spec — try the next one
    expect(res.status(), await res.text()).toBe(200);
    return { conf: await res.json(), slot, practitioner, date };
  }
  throw new Error('no free slot could be booked (all taken by parallel specs)');
}

test.describe('/api/v1/payments/config — the clinic\'s own Razorpay account', () => {
  requireApi();
  requireAuth();

  test('needs a token, and a clinic manager role', async ({ anon, api }) => {
    expect((await anon.get('/api/v1/payments/config')).status()).toBe(401);
    const login = await (await anon.post('/api/v1/auth/login', { data: DEMO_THERAPIST })).json();
    const headers = { Authorization: `Bearer ${login.access_token}`, 'X-Tenant-ID': login.tenant.id };
    expect((await anon.get('/api/v1/payments/config', { headers })).status()).toBe(403);
    expect((await anon.put('/api/v1/payments/config', { headers, data: { key_id: 'rzp_test_abcdefghij', key_secret: 'secret-secret' } })).status()).toBe(403);
    expect((await api.get('/api/v1/payments/config')).status()).toBe(200);
  });

  test('a malformed key id is a 422; a pair Razorpay does not accept is a 400 and nothing is stored', async ({ api }) => {
    const before = await (await api.get('/api/v1/payments/config')).json();
    test.skip(!before.platform_enabled, 'PAYMENTS_ENABLED is off on this backend');
    expect((await api.put('/api/v1/payments/config', { data: { key_id: 'not_a_razorpay_key', key_secret: 'secret-secret' } })).status()).toBe(422);
    const wrong = await api.put('/api/v1/payments/config', { data: { key_id: 'rzp_test_000000000000ab', key_secret: 'definitely-wrong-secret' } });
    expect(wrong.status(), await wrong.text()).toBe(400);
    expect((await wrong.json()).message).toBe('Razorpay rejected these credentials');
    const after = await (await api.get('/api/v1/payments/config')).json();
    expect(after.key_id).toBe(before.key_id); // the bad pair did not overwrite the stored account
  });

  test('the stored gateway exposes the key id and a masked hint, never the secret', async ({ api }) => {
    const { ready, platformEnabled } = await gateway(api);
    test.skip(!platformEnabled, 'PAYMENTS_ENABLED is off on this backend');
    test.skip(!ready, NO_GATEWAY);
    const cfg = await (await api.get('/api/v1/payments/config')).json();
    expect(cfg.key_id).toMatch(/^rzp_(test|live)_/);
    expect(cfg.secret_hint).toMatch(/^••••.{4}$/);
    expect(JSON.stringify(cfg)).not.toContain('key_secret');
  });

  test('a fresh pair is validated with Razorpay before it is stored [optional: E2E_RAZORPAY_*]', async ({ api }) => {
    test.skip(!haveSecret, 'set E2E_RAZORPAY_KEY_ID / E2E_RAZORPAY_KEY_SECRET to exercise the write path');
    const res = await api.put('/api/v1/payments/config', { data: { key_id: RAZORPAY.keyId, key_secret: RAZORPAY.keySecret, enabled: true } });
    expect(res.status(), await res.text()).toBe(200);
    const cfg = await res.json();
    expect(cfg).toEqual(expect.objectContaining({ configured: true, enabled: true, key_id: RAZORPAY.keyId, secret_hint: '••••' + RAZORPAY.keySecret.slice(-4) }));
    expect(JSON.stringify(cfg)).not.toContain(RAZORPAY.keySecret);
  });
});

test.describe('public booking paid into the clinic\'s Razorpay account', () => {
  requireApi();
  requireAuth();

  test('a Rs 1 service creates an order on the clinic\'s account, holds the slot and shows as pending; forged signatures are refused', async ({ anon, api, auth }) => {
    const { ready, keyId } = await gateway(api);
    test.skip(!ready, NO_GATEWAY);
    const svc = await service(api, 1);
    const info = await (await anon.get(`/api/v1/public/booking/${auth.firmCode}`)).json();
    expect(info.payments_enabled).toBe(true);
    const { conf, slot, practitioner, date } = await bookASlot(anon, auth.firmCode, svc.id);
    try {
      expect(conf.payment_status).toBe('pending');
      expect(conf.payment).toEqual(expect.objectContaining({ amount_paise: 100, currency: 'INR', key_id: keyId }));
      expect(conf.payment.order_id).toMatch(/^order_/);
      expect(new Date(conf.payment.hold_expires_at).getTime()).toBeGreaterThan(Date.now() + 10 * 60_000);

      // the slot is held while the patient pays
      const after = await (
        await anon.get(`/api/v1/public/booking/${auth.firmCode}/slots`, { params: { practitioner_id: practitioner.id, service_id: svc.id, date } })
      ).json();
      expect(after.slots).not.toContain(slot);

      // the clinic sees the payment state on the session
      const clinic = await (await api.get('/api/v1/sessions/', { params: { limit: 500 } })).json();
      const row = clinic.sessions.find((s: { id: string }) => s.id === conf.session_id);
      expect(row).toEqual(expect.objectContaining({ booked_via: 'web', payment_status: 'pending', amount_paise: 100 }));
      const detail = await (await api.get(`/api/v1/sessions/${conf.session_id}`)).json();
      expect(detail.payment_status).toBe('pending');

      // Checkout's result is verified with the clinic's secret: a forged signature changes nothing
      const forged = await anon.post(`/api/v1/public/booking/${auth.firmCode}/payments/verify`, {
        data: { razorpay_order_id: conf.payment.order_id, razorpay_payment_id: 'pay_forged000000', razorpay_signature: 'deadbeef'.repeat(8) },
      });
      expect(forged.status()).toBe(400);
      expect((await forged.json()).message).toBe('Payment could not be verified');
      const unknown = await anon.post(`/api/v1/public/booking/${auth.firmCode}/payments/verify`, {
        data: { razorpay_order_id: 'order_doesnotexist', razorpay_payment_id: 'pay_x', razorpay_signature: 'x' },
      });
      expect(unknown.status()).toBe(404);
      const still = await (await api.get(`/api/v1/sessions/${conf.session_id}`)).json();
      expect(still.payment_status).toBe('pending');
    } finally {
      await api.put(`/api/v1/sessions/${conf.session_id}`, { data: { status: 'cancelled', cancellation_reason: 'e2e cleanup' } });
    }
  });

  test('a free service needs no payment even when the clinic takes payments', async ({ anon, api, auth }) => {
    const { ready } = await gateway(api);
    test.skip(!ready, NO_GATEWAY);
    const svc = await service(api, 0);
    const { conf } = await bookASlot(anon, auth.firmCode, svc.id);
    try {
      expect(conf.payment).toBeNull();
      expect(conf.payment_status).toBeNull();
    } finally {
      await api.put(`/api/v1/sessions/${conf.session_id}`, { data: { status: 'cancelled', cancellation_reason: 'e2e cleanup' } });
    }
  });

  // NB: the "clinic disabled its gateway → priced bookings are not charged" path is NOT tested here.
  // It would have to flip the demo clinic's single shared gateway off/on, which races every other
  // booking under fullyParallel. The server rule is small — `_gateway` returns None when is_enabled is
  // false, so create_booking skips the order — and the `is_enabled` column is covered by the model.
});
