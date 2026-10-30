import { test, expect, requireWeb, requireApi, requireAuth } from '../src/fixtures';
import { uniq } from '../src/env';

/** The booking page shows the amount a booking charges (paise from the API), and a pay step only when it charges. */
test.describe('public booking page prices (/book/<firmCode>)', () => {
  requireWeb();
  requireApi();
  requireAuth();
  test.use({ storageState: { cookies: [], origins: [] } }); // a patient has no login

  test('₹1,500.50 is shown as ₹1,500.50; a ₹0.50 service (below the ₹1 minimum) has no pay step', async ({ page, api, anon, auth }) => {
    const create = async (price: number) => {
      const res = await api.post('/api/v1/catalog/services', {
        data: { name: uniq('Priced web consult'), description: 'e2e', duration_minutes: 50, price, currency: 'INR' },
      });
      expect(res.status(), await res.text()).toBe(201);
      return res.json();
    };
    const priced = await create(1500.5);
    const tiny = await create(0.5);
    try {
      const info = await (await anon.get(`/api/v1/public/booking/${auth.firmCode}`)).json();
      await page.goto(`/book/${auth.firmCode}`);
      await expect(page.getByTestId(`service-${priced.id}`)).toContainText('50 min · ₹1,500.50');
      await expect(page.getByTestId(`service-${tiny.id}`)).toContainText('50 min · ₹0.50');

      const progress = page.getByRole('navigation', { name: 'Booking progress' });
      await page.getByTestId(`service-${tiny.id}`).click();
      await expect(progress).toContainText('Clinician');
      await expect(progress).not.toContainText('Pay'); // before: shown whenever the clinic takes payments and price > 0

      await page.goto(`/book/${auth.firmCode}`);
      await page.getByTestId(`service-${priced.id}`).click();
      await expect(progress).toContainText('Clinician');
      if (info.payments_enabled) await expect(progress).toContainText('Pay');
      else await expect(progress).not.toContainText('Pay');
    } finally {
      await api.delete(`/api/v1/catalog/services/${priced.id}`);
      await api.delete(`/api/v1/catalog/services/${tiny.id}`);
    }
  });
});
