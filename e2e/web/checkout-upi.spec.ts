import { test, expect, requireWeb, requireApi, requireAuth } from '../src/fixtures';
import { uniq } from '../src/env';
import { assignDemoClinicians, cleanupServices, createService } from '../src/catalog';
import { openDay } from '../src/days';
import type { Page } from '@playwright/test';

/**
 * Which UPI flows the booking checkout offers. NPCI retired UPI Collect, so with a LIVE key the page hides it and
 * desktop shows the UPI QR. Razorpay TEST mode supports UPI only through Collect (success@razorpay), so with a
 * TEST key nothing is hidden. Checkout.js is stubbed and the booking answer carries the key, so both branches run
 * every time with no Razorpay account.
 */
const TEST_PHONE = '+919876543210'; // test-listed: no phone.email round-trip needed
const CHECKOUT_STUB = `window.Razorpay = function (options) { window.__rzpOptions = options; this.open = function () {}; this.on = function () {}; };`;

async function optionsPassedToCheckout(page: Page, api: import('@playwright/test').APIRequestContext, firmCode: string, keyId: string, slotIndex: number, created: string[]) {
  const service = await createService(api, created, { name: uniq('UPI flows'), price: 0 });
  await assignDemoClinicians(api, service.id);
  await page.route('https://checkout.razorpay.com/v1/checkout.js', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: CHECKOUT_STUB }),
  );
  let sessionId = '';
  // The free booking is real; its answer gains a payment as a priced one would, with the key under test
  await page.route(`**/api/v1/public/booking/${firmCode}`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const res = await route.fetch();
    const body = await res.json();
    sessionId = body.session_id;
    body.payment_status = 'pending';
    body.payment = { order_id: 'order_e2e', amount_paise: 100, currency: 'INR', key_id: keyId, hold_expires_at: new Date(Date.now() + 900_000).toISOString() };
    await route.fulfill({ response: res, json: body });
  });
  try {
    await page.goto(`/book/${firmCode}`);
    await page.getByTestId(`service-${service.id}`).click();
    await page.getByRole('radio', { name: /Jane Doe/ }).click();
    await page.getByTestId('booking-date').fill(openDay(5));
    const slotButtons = page.getByTestId('booking-slots').getByRole('radio');
    await expect(slotButtons.first()).toBeVisible({ timeout: 15_000 });
    await slotButtons.nth(slotIndex).click();
    await page.getByTestId('booking-phone').fill(TEST_PHONE);
    await page.getByTestId('booking-phone').blur();
    await page.getByTestId('booking-for-new').click(); // the shared test phone already has patients
    await page.getByTestId('booking-first-name').fill(uniq('Upi'));
    await page.getByTestId('booking-last-name').fill('Flows');
    await page.getByTestId('booking-submit').click();
    await expect(page.getByTestId('booking-pay')).toHaveText('Pay ₹1');
    await page.getByTestId('booking-pay').click();
    await expect.poll(() => page.evaluate(() => !!(window as unknown as { __rzpOptions?: unknown }).__rzpOptions)).toBe(true);
    return await page.evaluate(() => (window as unknown as { __rzpOptions: { key: string; config?: unknown } }).__rzpOptions);
  } finally {
    if (sessionId) await api.post(`/api/v1/sessions/${sessionId}/cancel`, { data: { reason: 'e2e cleanup' } });
  }
}

test.describe('booking checkout: UPI flows by key mode', () => {
  test.describe.configure({ mode: 'serial' }); // both book Jane Doe on the same day
  requireWeb();
  requireApi();
  requireAuth();
  test.use({ storageState: { cookies: [], origins: [] } }); // a patient has no login
  const created: string[] = [];
  test.afterEach(async ({ api }) => cleanupServices(api, created));

  test('a test key keeps UPI Collect, so success@razorpay works in test mode', async ({ page, api, auth }) => {
    const options = await optionsPassedToCheckout(page, api, auth.firmCode, 'rzp_test_e2e', 2, created);
    expect(options.key).toBe('rzp_test_e2e');
    expect(options.config).toBeUndefined();
  });

  test('a live key hides the retired UPI Collect flow, so desktop shows the UPI QR', async ({ page, api, auth }) => {
    const options = await optionsPassedToCheckout(page, api, auth.firmCode, 'rzp_live_e2e', 3, created);
    expect(options.key).toBe('rzp_live_e2e');
    expect(options.config).toEqual({ display: { hide: [{ method: 'upi', flows: ['collect'] }] } });
  });
});
