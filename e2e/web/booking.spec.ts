import { test, expect, requireWeb, requireApi, requireAuth } from '../src/fixtures';
import { uniq } from '../src/env';
import { assignDemoClinicians, demoClinicianIds } from '../src/catalog';

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

  test('after choosing a service, only the clinicians who offer it are listed', async ({ page, api, auth }) => {
    const svc = await api.post('/api/v1/catalog/services', {
      data: { name: uniq('Jane only'), duration_minutes: 50, price: 0, currency: 'INR' },
    });
    expect(svc.status(), await svc.text()).toBe(201);
    const service = await svc.json();
    try {
      const [janeId] = await demoClinicianIds(); // [therapist Jane, psychologist Smith]
      const put = await api.put(`/api/v1/catalog/services/${service.id}/clinicians`, { data: { clinician_ids: [janeId] } });
      expect(put.status(), await put.text()).toBe(200);

      await page.goto(`/book/${auth.firmCode}`);
      await page.getByTestId(`service-${service.id}`).click();
      await expect(page.getByRole('radio', { name: /Jane Doe/ })).toBeVisible();
      await expect(page.getByRole('radio', { name: /John Smith/ })).toHaveCount(0);
    } finally {
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
    await assignDemoClinicians(api, service.id);

    await page.goto(`/book/${auth.firmCode}`);
    await expect(page.getByTestId('booking-page')).toBeVisible();
    await page.getByTestId(`service-${service.id}`).click();
    await page.getByRole('radio', { name: /Jane Doe/ }).click();
    await page.getByTestId('booking-date').fill(dayAfterTomorrow());
    const slotButtons = page.getByTestId('booking-slots').getByRole('radio');
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
