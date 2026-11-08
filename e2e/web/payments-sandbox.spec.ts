import type { Page, Request, Response } from '@playwright/test';
import { test, expect, requireWeb, requireApi, requireAuth } from '../src/fixtures';
import { uniq } from '../src/env';
import { assignDemoClinicians, cleanupServices, createService } from '../src/catalog';
import { openDay } from '../src/days';

/**
 * @razorpay-sandbox: a real Rs 1 payment through Razorpay Checkout in TEST mode, end to end: the public booking
 * page, the card form in Razorpay's iframe, the test bank page (Success / Failure), our verify call, the session.
 * It talks to Razorpay's servers, so it stays out of the PR/push gate: e2e.yml runs it nightly and on demand
 * (workflow_dispatch input razorpay_sandbox). It uses whatever account the demo clinic has connected and skips
 * until one is (backend/scripts/connect_demo_razorpay.py; CI connects it from the E2E_RAZORPAY_* secrets).
 */
// a trace records every fill() value and CI uploads failed traces: never let one capture anything typed here
test.use({ trace: 'off', storageState: { cookies: [], origins: [] } }); // a patient has no login

// Razorpay's documented domestic TEST debit card (public value; any future expiry, any CVV):
// https://razorpay.com/docs/payments/payments/test-card-details/
// Razorpay's test Checkout is slow to start (measured locally: ~30 s from Pay to a usable form, ~60 s to the bank
// page), so its steps get vendor-sized timeouts; our own steps keep the defaults
const CHECKOUT_TIMEOUT = 90_000;
const TEST_CARD = { number: '4100 2800 0000 1007', expiry: '12/30', cvv: '123' };
const TEST_PHONE = '+919876543210';
// Razorpay rejects the well-known dummy 9876543210 ("Please enter a valid mobile number"), so it ignores that prefill
// and asks for a number itself; this one is typed only into Checkout, never stored by us
const CHECKOUT_MOBILE = '9123456780';
const NO_GATEWAY = 'the demo clinic has no Razorpay account connected — connect one in Settings → Payments (or run backend/scripts/connect_demo_razorpay.py)';
// its own day: never contends with the api payment specs (day 3), booking/journey (day 2) or the other day-n specs
const bookingDate = () => openDay(8);

const created: string[] = [];
const onPhone: string[] = []; // patients put on TEST_PHONE so the page asks who the booking is for

type Booking = { sessionId: string; orderId: string; slot: string; serviceId: string; practitionerId: string };

async function gatewayReady(api: any): Promise<boolean> {
  const cfg = await (await api.get('/api/v1/payments/config')).json();
  return Boolean(cfg.platform_enabled && cfg.configured && cfg.enabled);
}

/** Book a Rs 1 service on the public page up to the Pay step; returns what our backend answered. */
async function bookToPayStep(page: Page, api: any, firmCode: string, slotIndex: 'first' | 'last'): Promise<Booking> {
  const service = await createService(api, created, { name: uniq('Rs 1 sandbox consult'), price: 1 });
  await assignDemoClinicians(api, service.id);
  // someone already on the phone, so the page offers "Someone else" (never rely on an earlier spec having booked with it)
  const sibling = await api.post('/api/v1/patients/', { data: { first_name: uniq('Sibling'), last_name: 'Patient', phone: TEST_PHONE } });
  expect(sibling.status(), await sibling.text()).toBe(200);
  onPhone.push((await sibling.json()).id);

  await page.goto(`/book/${firmCode}`);
  await page.getByTestId(`service-${service.id}`).click();
  await page.getByRole('radio', { name: /Jane Doe/ }).click();
  await page.getByTestId('booking-date').fill(bookingDate());
  const slotButtons = page.getByTestId('booking-slots').getByRole('radio');
  await expect(slotButtons.first()).toBeVisible({ timeout: 15_000 });
  await slotButtons[slotIndex]().click();
  await page.getByTestId('booking-phone').fill(TEST_PHONE);
  await page.getByTestId('booking-phone').blur();
  await page.getByTestId('booking-for-new').click();
  await page.getByTestId('booking-first-name').fill(uniq('Sandbox'));
  await page.getByTestId('booking-last-name').fill('Payer');

  const booked = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/v1/public/booking/${firmCode}`);
  await page.getByTestId('booking-submit').click();
  const res = await booked;
  expect(res.status()).toBe(200);
  const body = await res.json();
  const sent = res.request().postDataJSON();
  await expect(page.getByTestId('booking-pay')).toHaveText('Pay ₹1', { timeout: 15_000 });
  return { sessionId: body.session_id, orderId: body.payment.order_id, slot: sent.scheduled_at, serviceId: service.id, practitionerId: sent.practitioner_id };
}

/**
 * Pay with the test card in Razorpay's iframe and answer the bank step with `outcome`. Razorpay's test Checkout is
 * a vendor UI that varies between runs, so each step is a named test.step (a nightly failure names the Razorpay step
 * that stalled) and the flow Razorpay chose is logged and annotated:
 *  - "popup": the mock bank page in a popup with Success / Failure buttons;
 *  - "otp": an OTP screen inside Checkout (Razorpay docs: 4–10 digits succeed, fewer than 4 fail).
 * Before either, Razorpay may offer to save (tokenise) the card under RBI rules; "Maybe later" declines it.
 */
async function payWithTestCard(page: Page, outcome: 'Success' | 'Failure'): Promise<'popup' | 'otp'> {
  const checkout = page.frameLocator('iframe.razorpay-checkout-frame');
  await test.step('Razorpay: Checkout opens and takes the contact number', async () => {
    await page.getByTestId('booking-pay').click();
    // slow start: ~30 s from Pay to a usable form when measured, hence the vendor-sized timeout
    await checkout.getByPlaceholder('Mobile number').fill(CHECKOUT_MOBILE, { timeout: CHECKOUT_TIMEOUT });
    await checkout.getByRole('button', { name: 'Continue' }).last().click();
    // the contact dialog has closed before the card form takes clicks
    await expect(checkout.getByText(`Using as +91 ${CHECKOUT_MOBILE.slice(0, 5)} ${CHECKOUT_MOBILE.slice(5)}`)).toBeVisible({ timeout: CHECKOUT_TIMEOUT });
    await expect(checkout.getByPlaceholder('Mobile number')).toBeHidden();
  });
  await test.step('Razorpay: card details', async () => {
    await checkout.getByTestId('card').click();
    await checkout.getByPlaceholder('Card Number').fill(TEST_CARD.number);
    await checkout.getByPlaceholder('MM / YY').fill(TEST_CARD.expiry);
    await checkout.getByPlaceholder('CVV').fill(TEST_CARD.cvv);
  });

  let bankPage: Page | undefined;
  page.on('popup', (p) => { bankPage = p; });
  const otp = checkout.getByRole('textbox', { name: /otp/i }).or(checkout.getByPlaceholder(/otp/i)).first();
  const later = checkout.getByRole('button', { name: 'Maybe later' });
  const flow = await test.step('Razorpay: bank step appears (popup or in-Checkout OTP)', async () => {
    await checkout.getByRole('button', { name: 'Continue' }).click();
    // ~60 s from Pay to the bank step when measured; the save-card prompt shows on some runs, not others
    const deadline = Date.now() + CHECKOUT_TIMEOUT;
    for (;;) {
      if (bankPage) return 'popup' as const;
      if (await otp.isVisible()) return 'otp' as const;
      if (await later.isVisible()) await later.click({ timeout: 5_000 }).catch(() => undefined);
      if (Date.now() > deadline) throw new Error('Razorpay stalled after the card step: no bank popup, no OTP screen');
      await page.waitForTimeout(500);
    }
  });
  test.info().annotations.push({ type: 'razorpay-flow', description: flow });
  console.log(`[razorpay-sandbox] Razorpay chose the "${flow}" bank flow; answering ${outcome}`);

  await test.step(`Razorpay: ${outcome} on the ${flow} bank step`, async () => {
    if (flow === 'popup') {
      await bankPage!.getByRole('button', { name: outcome }).click({ timeout: CHECKOUT_TIMEOUT });
    } else {
      await otp.fill(outcome === 'Success' ? '123456' : '12');
      await otp.press('Enter');
    }
  });
  return flow;
}

/** The session's payment rows as staff see them (GET /sessions/{id}/payments): only the Razorpay order here. */
async function paymentRows(api: any, sessionId: string) {
  const res = await api.get(`/api/v1/sessions/${sessionId}/payments`);
  expect(res.status()).toBe(200);
  return res.json();
}

async function sessionRow(api: any, id: string) {
  const day = bookingDate();
  const list = await (await api.get('/api/v1/sessions/', { params: { date_from: day, date_to: day, limit: 500 } })).json();
  return list.sessions.find((s: { id: string }) => s.id === id);
}

test.describe('@razorpay-sandbox Razorpay Checkout pays with the test card', () => {
  requireWeb();
  requireApi();
  requireAuth();
  // retries: 1 for this file only: the vendor flow, not ours, is what varies (the log names the Razorpay step and flow)
  test.describe.configure({ mode: 'serial', timeout: 300_000, retries: 1 });
  test.afterEach(async ({ api }) => {
    await cleanupServices(api, created);
    for (const id of onPhone.splice(0)) await api.delete(`/api/v1/patients/${id}`);
  });

  test('Success on the bank page: "Payment received", verify answers paid with our order, the session is paid', async ({ page, api, auth }) => {
    test.skip(!(await gatewayReady(api)), NO_GATEWAY);
    const booking = await bookToPayStep(page, api, auth.firmCode, 'last');
    try {
      const verified = page.waitForResponse((r: Response) => new URL(r.url()).pathname === `/api/v1/public/booking/${auth.firmCode}/payments/verify`, { timeout: 0 }); // bounded by the test timeout
      await payWithTestCard(page, 'Success');
      const res = await verified;
      expect(res.status()).toBe(200);
      expect(await res.json()).toEqual({ status: 'paid', session_id: booking.sessionId, session_status: 'scheduled' });
      const sent = (res.request() as Request).postDataJSON();
      expect(sent.razorpay_order_id).toBe(booking.orderId);
      expect(sent.razorpay_payment_id).toMatch(/^pay_[A-Za-z0-9]+$/);

      await expect(page.getByText('Payment received')).toBeVisible();
      await expect(page.getByTestId('booking-paid')).toBeVisible();
      expect(await sessionRow(api, booking.sessionId)).toEqual(expect.objectContaining({
        status: 'scheduled', booked_via: 'web', payment_status: 'paid', amount_paise: 100,
      }));
      // the backend checked the signature over exactly this order id + payment id before storing them
      const rows = await paymentRows(api, booking.sessionId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(expect.objectContaining({ provider: 'razorpay', status: 'paid', amount_paise: 100, currency: 'INR', refunded_paise: 0 }));
      expect(rows[0].paid_at).not.toBeNull();
    } finally {
      await api.post(`/api/v1/sessions/${booking.sessionId}/cancel`, { data: { reason: 'e2e cleanup' } });
    }
  });

  test('Failure on the bank page: an error toast, no verify call, the session stays unpaid and its slot held', async ({ page, api, auth, anon }) => {
    test.skip(!(await gatewayReady(api)), NO_GATEWAY);
    const booking = await bookToPayStep(page, api, auth.firmCode, 'first');
    let verifyCalls = 0;
    page.on('request', (r) => { if (new URL(r.url()).pathname.endsWith('/payments/verify')) verifyCalls += 1; });
    try {
      await payWithTestCard(page, 'Failure');
      await expect(page.getByRole('status').filter({ hasText: /fail/i })).toBeVisible({ timeout: CHECKOUT_TIMEOUT });
      expect(verifyCalls).toBe(0);
      await expect(page.getByTestId('booking-paid')).toHaveCount(0);
      expect(await sessionRow(api, booking.sessionId)).toEqual(expect.objectContaining({
        status: 'scheduled', booked_via: 'web', payment_status: 'pending', amount_paise: 100,
      }));
      const rows = await paymentRows(api, booking.sessionId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(expect.objectContaining({ provider: 'razorpay', status: 'created', paid_at: null }));
      const { slots } = await (await anon.get(`/api/v1/public/booking/${auth.firmCode}/slots`, {
        params: { practitioner_id: booking.practitionerId, service_id: booking.serviceId, date: bookingDate() },
      })).json();
      expect(slots).not.toContain(booking.slot);
    } finally {
      await api.post(`/api/v1/sessions/${booking.sessionId}/cancel`, { data: { reason: 'e2e cleanup' } });
    }
  });
});
