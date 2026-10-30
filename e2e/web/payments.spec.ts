import { test, expect, requireWeb, requireApi, requireAuth } from '../src/fixtures';
import { RAZORPAY, uniq } from '../src/env';
import { cleanupServices, createService } from '../src/catalog';

const created: string[] = [];

/**
 * Per-clinic payments in the browser. The booking flow uses whatever Razorpay account the DEMO CLINIC
 * already has stored (connect it once in Settings → Payments, or via backend/scripts/connect_demo_razorpay.py);
 * no secret is needed here. The actual payment (test card / success@razorpay UPI) is a manual check — see
 * e2e/README.md. E2E_RAZORPAY_* stays optional: it only drives the "type a fresh secret" write test.
 */
const TEST_PHONE = '+919876543210';
const haveSecret = Boolean(RAZORPAY.keyId && RAZORPAY.keySecret);
const NO_GATEWAY = 'the demo clinic has no Razorpay account connected — connect one in Settings → Payments (or run backend/scripts/connect_demo_razorpay.py)';

// a dedicated day so this browser booking never contends with the api payment specs (day+3) or booking/journey (day+2)
const bookingDate = () => {
  const d = new Date();
  d.setDate(d.getDate() + 4);
  return d.toISOString().slice(0, 10);
};

async function gatewayReady(api: any): Promise<boolean> {
  const cfg = await (await api.get('/api/v1/payments/config')).json();
  return Boolean(cfg.platform_enabled && cfg.configured && cfg.enabled);
}

test.describe('Settings → Payments (clinic admin)', () => {
  requireWeb();
  requireApi();
  requireAuth();

  test('the Payments tab renders for the admin with the connection status and the key form', async ({ page }) => {
    await page.goto('/dashboard/settings');
    await page.getByRole('tab', { name: 'Payments' }).click();
    await expect(page.getByTestId('payments-status')).toBeVisible();
    await expect(page.getByTestId('payments-status')).toContainText(/Connected|Not connected/);
    await expect(page.getByTestId('payments-key-id')).toBeVisible();
    await expect(page.getByTestId('payments-key-secret')).toHaveAttribute('type', 'password');
  });

  test('a connected clinic shows its key id and a masked hint, never the secret', async ({ page, api }) => {
    test.skip(!(await gatewayReady(api)), NO_GATEWAY);
    const cfg = await (await api.get('/api/v1/payments/config')).json();
    await page.goto('/dashboard/settings');
    await page.getByRole('tab', { name: 'Payments' }).click();
    await expect(page.getByTestId('payments-status')).toContainText('Connected');
    await expect(page.getByTestId('payments-status')).toContainText(cfg.key_id);
    await expect(page.getByTestId('payments-status')).toContainText(cfg.secret_hint);
  });

  test('typing a fresh secret connects it and never echoes it back [optional: E2E_RAZORPAY_*]', async ({ page }) => {
    test.skip(!haveSecret, 'set E2E_RAZORPAY_KEY_ID / E2E_RAZORPAY_KEY_SECRET to exercise the write path');
    await page.goto('/dashboard/settings');
    await page.getByRole('tab', { name: 'Payments' }).click();
    await page.getByTestId('payments-key-id').fill(RAZORPAY.keyId);
    await page.getByTestId('payments-key-secret').fill(RAZORPAY.keySecret);
    await page.getByTestId('payments-save').click();
    await expect(page.getByTestId('payments-status')).toContainText('Connected', { timeout: 20_000 });
    await expect(page.getByTestId('payments-key-secret')).toHaveValue('');
    expect(await page.content()).not.toContain(RAZORPAY.keySecret);
  });
});

test.describe('public booking pays the clinic', () => {
  requireWeb();
  requireApi();
  requireAuth();
  test.use({ storageState: { cookies: [], origins: [] } }); // a patient has no login
  test.afterEach(async ({ api }) => cleanupServices(api, created));

  test('a Rs 1 service reaches the pay step and opens Razorpay Checkout', async ({ page, api, auth }) => {
    test.skip(!(await gatewayReady(api)), NO_GATEWAY);
    const service = await createService(api, created, { name: uniq('Rs 1 test consult'), price: 1 });

    await page.goto(`/book/${auth.firmCode}`);
    await expect(page.getByTestId(`service-${service.id}`)).toContainText('50 min · ₹1');
    await page.getByTestId(`service-${service.id}`).click();
    await page.getByRole('radio', { name: /Jane Doe/ }).click();
    await page.getByTestId('booking-date').fill(bookingDate());
    const slotButtons = page.getByTestId('booking-slots').getByRole('radio');
    await expect(slotButtons.first()).toBeVisible({ timeout: 15_000 });
    await slotButtons.last().click();
    await page.getByTestId('booking-first-name').fill(uniq('Pay'));
    await page.getByTestId('booking-last-name').fill('Online');
    await page.getByTestId('booking-phone').fill(TEST_PHONE);
    await page.getByTestId('booking-submit').click();

    await expect(page.getByTestId('booking-payment')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('booking-pay')).toHaveText('Pay ₹1');
    const reference = (await page.getByTestId('booking-payment').innerText()).match(/Reference: ([0-9a-f-]{36})/)?.[1];
    expect(reference).toBeTruthy();
    try {
      await page.getByTestId('booking-pay').click();
      // Razorpay Checkout mounts its own iframe, opened with the clinic's key
      await expect(page.locator('iframe.razorpay-checkout-frame')).toBeAttached({ timeout: 20_000 });
      const row = (await (await api.get('/api/v1/sessions/', { params: { limit: 500 } })).json()).sessions.find((s: { id: string }) => s.id === reference);
      expect(row).toEqual(expect.objectContaining({ booked_via: 'web', payment_status: 'pending', amount_paise: 100 }));
    } finally {
      await api.post(`/api/v1/sessions/${reference}/cancel`, { data: { reason: 'e2e cleanup' } });
    }
  });
});
