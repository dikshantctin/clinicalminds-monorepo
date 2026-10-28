import { test, expect, requireWeb, requireApi, requireAuth } from '../src/fixtures';
import { RAZORPAY, uniq } from '../src/env';

/**
 * Per-clinic payments in the browser: the admin connects the clinic's Razorpay account in Settings,
 * a patient booking a priced service reaches the pay step and Razorpay Checkout opens. The payment
 * itself (test card / success@razorpay UPI) is a manual check — see e2e/README.md.
 */
const TEST_PHONE = '+919876543210';
const haveKeys = Boolean(RAZORPAY.keyId && RAZORPAY.keySecret);
const NO_KEYS = 'set E2E_RAZORPAY_KEY_ID / E2E_RAZORPAY_KEY_SECRET (Razorpay test mode) in e2e/.env';

const dayAfterTomorrow = () => {
  const d = new Date();
  d.setDate(d.getDate() + 2);
  return d.toISOString().slice(0, 10);
};

test.describe('Settings → Payments (clinic admin)', () => {
  requireWeb();
  requireApi();
  requireAuth();

  test('the Payments tab renders for the admin with the connection status and the key form', async ({ page }) => {
    await page.goto('/dashboard/settings');
    await page.getByRole('button', { name: 'Payments' }).click();
    await expect(page.getByTestId('payments-status')).toBeVisible();
    await expect(page.getByTestId('payments-status')).toContainText(/Connected|Not connected/);
    await expect(page.getByTestId('payments-key-id')).toBeVisible();
    await expect(page.getByTestId('payments-key-secret')).toHaveAttribute('type', 'password');
  });

  test('the admin connects the clinic\'s Razorpay keys; the secret never appears on the page', async ({ page }) => {
    test.skip(!haveKeys, NO_KEYS);
    await page.goto('/dashboard/settings');
    await page.getByRole('button', { name: 'Payments' }).click();
    await expect(page.getByTestId('payments-status')).toBeVisible();
    await page.getByTestId('payments-key-id').fill(RAZORPAY.keyId);
    await page.getByTestId('payments-key-secret').fill(RAZORPAY.keySecret);
    await page.getByTestId('payments-save').click();
    await expect(page.getByTestId('payments-status')).toContainText('Connected', { timeout: 20_000 });
    await expect(page.getByTestId('payments-status')).toContainText(RAZORPAY.keyId);
    await expect(page.getByTestId('payments-status')).toContainText('••••' + RAZORPAY.keySecret.slice(-4));
    await expect(page.getByTestId('payments-key-secret')).toHaveValue('');
    expect(await page.content()).not.toContain(RAZORPAY.keySecret);
  });
});

test.describe('public booking pays the clinic', () => {
  requireWeb();
  requireApi();
  requireAuth();
  test.skip(!haveKeys, NO_KEYS);
  test.use({ storageState: { cookies: [], origins: [] } }); // a patient has no login

  test('a Rs 1 service reaches the pay step and opens Razorpay Checkout', async ({ page, api, auth }) => {
    const connected = await api.put('/api/v1/payments/config', { data: { key_id: RAZORPAY.keyId, key_secret: RAZORPAY.keySecret, enabled: true } });
    expect(connected.status(), await connected.text()).toBe(200);
    const svc = await api.post('/api/v1/catalog/services', {
      data: { name: uniq('Rs 1 test consult'), description: 'e2e', duration_minutes: 50, price: 1, currency: 'INR' },
    });
    expect(svc.status(), await svc.text()).toBe(201);
    const service = await svc.json();

    await page.goto(`/book/${auth.firmCode}`);
    await page.getByTestId(`service-${service.id}`).click();
    await page.getByRole('button', { name: /Jane Doe/ }).click();
    await page.getByTestId('booking-date').fill(dayAfterTomorrow());
    const slotButtons = page.getByTestId('booking-slots').getByRole('button');
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
      // Razorpay Checkout mounts its own iframe; the clinic's key is what it was opened with
      await expect(page.locator('iframe.razorpay-checkout-frame')).toBeAttached({ timeout: 20_000 });
      // meanwhile the clinic sees the booking as payment pending
      const row = (await (await api.get('/api/v1/sessions/', { params: { limit: 500 } })).json()).sessions.find((s: { id: string }) => s.id === reference);
      expect(row).toEqual(expect.objectContaining({ booked_via: 'web', payment_status: 'pending', amount_paise: 100 }));
    } finally {
      await api.put(`/api/v1/sessions/${reference}`, { data: { status: 'cancelled', cancellation_reason: 'e2e cleanup' } });
    }
  });
});
