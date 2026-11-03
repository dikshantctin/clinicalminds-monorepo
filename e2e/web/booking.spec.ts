import { test, expect, requireWeb, requireApi, requireAuth } from '../src/fixtures';
import { uniq } from '../src/env';
import { assignDemoClinicians, cleanupServices, createService, demoClinicianIds } from '../src/catalog';

const created: string[] = [];

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
  test.afterEach(async ({ api }) => cleanupServices(api, created));

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

  test('a returning patient picks themselves from the people on their number; no new record is made', async ({ page, api, auth }) => {
    const service = await createService(api, created, { name: uniq('Returning'), price: 0 });
    await assignDemoClinicians(api, service.id);
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
    }
  });

  test('a patient books a slot; the clinic sees it as booked online', async ({ page, api, auth, browser }) => {
    // free service: no payment step, whether or not the clinic has connected Razorpay (web/payments.spec.ts covers paid)
    const service = await createService(api, created, { name: uniq('Walk-in consult'), price: 0 });
    await assignDemoClinicians(api, service.id);

    await page.goto(`/book/${auth.firmCode}`);
    await expect(page.getByTestId('booking-page')).toBeVisible();
    await expect(page.getByTestId(`service-${service.id}`)).toContainText('50 min · Free'); // catalog price is rupees
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

  test('choosing "Any available" books one of the clinicians who offer the service', async ({ page, api, auth }) => {
    const svc = await api.post('/api/v1/catalog/services', {
      data: { name: uniq('Any clinician'), duration_minutes: 50, price: 0, currency: 'INR' },
    });
    expect(svc.status(), await svc.text()).toBe(201);
    const service = await svc.json();
    await assignDemoClinicians(api, service.id);
    // someone already on the phone, so the page asks who the booking is for (whatever ran before)
    const existing = await (await api.post('/api/v1/patients/', { data: { first_name: uniq('Sibling'), last_name: 'Patient', phone: TEST_PHONE } })).json();
    let reference: string | undefined;
    let patientId: string | undefined;
    try {
      const day = new Date();
      day.setDate(day.getDate() + 4); // not day +2, which the other booking specs fill
      await page.goto(`/book/${auth.firmCode}`);
      await page.getByTestId(`service-${service.id}`).click();
      await page.getByTestId('practitioner-any').click();
      await page.getByTestId('booking-date').fill(day.toISOString().slice(0, 10));
      const slotButtons = page.getByTestId('booking-slots').getByRole('radio');
      await expect(slotButtons.first()).toBeVisible({ timeout: 15_000 });
      await slotButtons.last().click();

      await expect(page.getByText(/with any available clinician on/)).toBeVisible();
      await page.getByTestId('booking-phone').fill(TEST_PHONE);
      await page.getByTestId('booking-phone').blur();
      await page.getByTestId('booking-for-new').click();
      await page.getByTestId('booking-first-name').fill(uniq('Any'));
      await page.getByTestId('booking-last-name').fill('Booker');
      await page.getByTestId('booking-submit').click();

      const confirmation = page.getByTestId('booking-confirmation');
      await expect(confirmation).toBeVisible({ timeout: 15_000 });
      await expect(confirmation).toContainText(/Jane Doe|John Smith/);
      reference = (await confirmation.innerText()).match(/Reference: ([0-9a-f-]{36})/)?.[1];
      expect(reference).toBeTruthy();
      const session = await (await api.get(`/api/v1/sessions/${reference}`)).json();
      patientId = session.patient_id;
      expect(patientId).not.toBe(existing.id); // "someone new" made a new record
      expect(await demoClinicianIds()).toContain(session.therapist_id);
    } finally {
      if (reference) await api.post(`/api/v1/sessions/${reference}/cancel`, { data: { reason: 'e2e cleanup' } });
      if (patientId) await api.delete(`/api/v1/patients/${patientId}`);
      await api.delete(`/api/v1/patients/${existing.id}`);
      await api.delete(`/api/v1/catalog/services/${service.id}`);
    }
  });

  test('an unknown clinic code shows a friendly message', async ({ page }) => {
    await page.goto('/book/no-such-clinic');
    await expect(page.getByRole('heading', { name: 'Clinic not found' })).toBeVisible();
  });
});
