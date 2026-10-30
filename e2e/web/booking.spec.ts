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

  test('a returning patient picks themselves from the people on their number; no new record is made', async ({ page, api, auth }) => {
    const svc = await api.post('/api/v1/catalog/services', { data: { name: uniq('Returning'), duration_minutes: 50, price: 0, currency: 'INR' } });
    expect(svc.status(), await svc.text()).toBe(201);
    const service = await svc.json();
    const asha = await (await api.post('/api/v1/patients/', { data: { first_name: uniq('Asha'), last_name: 'Kapoor', phone: TEST_PHONE } })).json();
    let reference: string | undefined;
    try {
      await page.goto(`/book/${auth.firmCode}`);
      await page.getByTestId(`service-${service.id}`).click();
      await page.getByRole('radio', { name: /Jane Doe/ }).click();
      await page.getByTestId('booking-date').fill(dayAfterTomorrow());
      const slotButtons = page.getByTestId('booking-slots').getByRole('radio');
      await expect(slotButtons.first()).toBeVisible({ timeout: 15_000 });
      await slotButtons.nth(1).click();
      await page.getByTestId('booking-phone').fill(TEST_PHONE);
      await page.getByTestId('booking-phone').blur();
      await page.getByTestId('booking-for').getByRole('radio', { name: `${asha.first_name} Kapoor` }).click();
      await expect(page.getByTestId('booking-first-name')).toHaveCount(0);
      await page.getByTestId('booking-submit').click();
      await expect(page.getByTestId('booking-confirmation')).toBeVisible({ timeout: 15_000 });
      reference = (await page.getByTestId('booking-confirmation').innerText()).match(/Reference: ([0-9a-f-]{36})/)?.[1];
      const session = await (await api.get(`/api/v1/sessions/${reference}`)).json();
      expect(session.patient_id).toBe(asha.id);
    } finally {
      if (reference) await api.post(`/api/v1/sessions/${reference}/cancel`, { data: { reason: 'e2e cleanup' } });
      await api.delete(`/api/v1/patients/${asha.id}`);
      await api.delete(`/api/v1/catalog/services/${service.id}`);
    }
  });

  test('a patient books a slot; the clinic sees it as booked online', async ({ page, api, auth, browser }) => {
    // free service: no payment step, whether or not the clinic has connected Razorpay (web/payments.spec.ts covers paid)
    const svc = await api.post('/api/v1/catalog/services', {
      data: { name: uniq('Walk-in consult'), description: 'e2e', duration_minutes: 50, price: 0, currency: 'INR' },
    });
    expect(svc.status(), await svc.text()).toBe(201);
    const service = await svc.json();

    await page.goto(`/book/${auth.firmCode}`);
    await expect(page.getByTestId('booking-page')).toBeVisible();
    await page.getByTestId(`service-${service.id}`).click();
    await page.getByRole('radio', { name: /Jane Doe/ }).click();
    await page.getByTestId('booking-date').fill(dayAfterTomorrow());
    const slotButtons = page.getByTestId('booking-slots').getByRole('radio');
    await expect(slotButtons.first()).toBeVisible({ timeout: 15_000 });
    await slotButtons.last().click();

    const first = uniq('Web');
    await page.getByTestId('booking-phone').fill(TEST_PHONE);
    await page.getByTestId('booking-phone').blur(); // a test-listed number is looked up at once (others after phone.email)
    await expect(page.getByTestId('phone-email-phone')).toBeAttached(); // vendor widget host rendered
    // the shared test phone already has patients: the booker must say who this is for before confirming
    await expect(page.getByTestId('booking-for')).toContainText('Who is this booking for?');
    await expect(page.getByTestId('booking-submit')).toBeDisabled();
    await page.getByTestId('booking-for-new').click();
    await page.getByTestId('booking-first-name').fill(first);
    await page.getByTestId('booking-last-name').fill('Booker');
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
      // the list is paged on the server: search narrows it to the booking's patient (the booking may
      // attach to an existing record with the same phone, so read the name back)
      const { patient_name } = await (await api.get(`/api/v1/sessions/${reference}`)).json();
      await clinicPage.getByRole('searchbox', { name: 'Search sessions' }).fill(patient_name);
      await expect(clinicPage.locator('tr', { hasText: patient_name }).getByTestId('booked-online').first()).toBeVisible();
    } finally {
      await clinic.close();
      await api.post(`/api/v1/sessions/${reference}/cancel`, { data: { reason: 'e2e cleanup' } });
    }
  });

  test('an unknown clinic code shows a friendly message', async ({ page }) => {
    await page.goto('/book/no-such-clinic');
    await expect(page.getByRole('heading', { name: 'Clinic not found' })).toBeVisible();
  });
});
