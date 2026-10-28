import { test, expect, requireWeb, requireApi, requireAuth } from '../src/fixtures';
import { uniq } from '../src/env';

const TEST_PHONE = '+919876543210'; // test-listed: no phone.email round-trip needed

const dayAfterTomorrow = () => {
  const d = new Date();
  d.setDate(d.getDate() + 2);
  return d.toISOString().slice(0, 10);
};

test.describe('public booking page (/book/<firmCode>)', () => {
  requireWeb();
  requireApi();
  requireAuth();
  test.use({ storageState: { cookies: [], origins: [] } }); // a patient has no login

  test('a patient books a slot; the clinic sees it as booked online', async ({ page, api, auth, browser }) => {
    const svc = await api.post('/api/v1/catalog/services', {
      data: { name: uniq('Walk-in consult'), description: 'e2e', duration_minutes: 50, price: 1200, currency: 'INR' },
    });
    expect(svc.status(), await svc.text()).toBe(201);
    const service = await svc.json();

    await page.goto(`/book/${auth.firmCode}`);
    await expect(page.getByTestId('booking-page')).toBeVisible();
    await page.getByTestId(`service-${service.id}`).click();
    await page.getByRole('button', { name: /Jane Doe/ }).click();
    await page.getByTestId('booking-date').fill(dayAfterTomorrow());
    const slotButtons = page.getByTestId('booking-slots').getByRole('button');
    await expect(slotButtons.first()).toBeVisible({ timeout: 15_000 });
    await slotButtons.last().click();

    const first = uniq('Web');
    await page.getByTestId('booking-first-name').fill(first);
    await page.getByTestId('booking-last-name').fill('Booker');
    await page.getByTestId('booking-phone').fill(TEST_PHONE);
    await expect(page.getByTestId('phone-email-phone')).toBeAttached(); // vendor widget host rendered
    await page.getByTestId('booking-submit').click();

    await expect(page.getByTestId('booking-confirmation')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('booking-confirmation')).toContainText('Jane Doe');
    const reference = (await page.getByTestId('booking-confirmation').innerText()).match(/Reference: ([0-9a-f-]{36})/)?.[1];
    expect(reference).toBeTruthy();

    // the clinic's sessions page (admin storage state) shows the booking link and the "Booked online" badge
    const clinic = await browser.newContext({ storageState: '.auth/state.json' });
    try {
      const clinicPage = await clinic.newPage();
      await clinicPage.goto('/dashboard/sessions');
      await expect(clinicPage.getByTestId('booking-link')).toContainText(`/book/${auth.firmCode}`);
      await expect(clinicPage.getByTestId('booked-online').first()).toBeVisible({ timeout: 15_000 });
    } finally {
      await clinic.close();
      await api.put(`/api/v1/sessions/${reference}`, { data: { status: 'cancelled', cancellation_reason: 'e2e cleanup' } });
    }
  });

  test('an unknown clinic code shows a friendly message', async ({ page }) => {
    await page.goto('/book/no-such-clinic');
    await expect(page.getByRole('heading', { name: 'Clinic not found' })).toBeVisible();
  });
});
