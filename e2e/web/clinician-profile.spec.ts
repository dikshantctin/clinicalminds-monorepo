import { request as pwRequest } from '@playwright/test';
import { test, expect, requireWeb, requireApi, requireAuth } from '../src/fixtures';
import { env, uniq, DEMO_THERAPIST } from '../src/env';

test.describe('clinician profile', () => {
  requireWeb();
  requireApi();
  requireAuth();
  test.describe.configure({ mode: 'serial' });

  test('Settings → Profile saves bio, qualifications, languages and photo link', async ({ page, api }) => {
    const before = (await (await api.get('/api/v1/users/me')).json()).profile;
    const bio = `Profile ${uniq('bio')}`;
    try {
      await page.goto('/dashboard/settings');
      await page.getByRole('tab', { name: 'Profile' }).click();
      await page.getByTestId('profile-bio').fill(bio);
      await page.getByTestId('profile-qualifications').fill('M.Phil Clinical Psychology, RCI registered');
      await page.getByTestId('profile-languages').fill('English, Marathi');
      await page.getByTestId('profile-photo-url').fill('https://example.com/me.jpg');
      await page.getByTestId('profile-save').click();
      await expect(page.getByText('Profile Updated')).toBeVisible();

      await page.reload();
      await page.getByRole('tab', { name: 'Profile' }).click();
      await expect(page.getByTestId('profile-bio')).toHaveValue(bio);
      await expect(page.getByTestId('profile-languages')).toHaveValue('English, Marathi');
      expect((await (await api.get('/api/v1/users/me')).json()).profile).toEqual({
        bio,
        qualifications: ['M.Phil Clinical Psychology', 'RCI registered'],
        languages: ['English', 'Marathi'],
        photo_url: 'https://example.com/me.jpg',
      });
    } finally {
      await api.put('/api/v1/users/me', { data: { profile: before ?? null } });
    }
  });

  test('the booking page shows a clinician\'s profile on their card', async ({ browser, auth }) => {
    const anon = await pwRequest.newContext({ baseURL: env.API_URL });
    const login = await (await anon.post('/api/v1/auth/login', { data: DEMO_THERAPIST })).json();
    const jane = await pwRequest.newContext({ baseURL: env.API_URL, extraHTTPHeaders: { Authorization: `Bearer ${login.access_token}` } });
    const before = (await (await jane.get('/api/v1/users/me')).json()).profile;
    const bio = `Sees adults for anxiety ${uniq('x')}`;
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    try {
      const put = await jane.put('/api/v1/users/me', {
        data: { profile: { bio, qualifications: ['RCI registered'], languages: ['English', 'Hindi'], photo_url: 'https://example.com/jane.jpg' } },
      });
      expect(put.status(), await put.text()).toBe(200);
      const info = await (await anon.get(`/api/v1/public/booking/${auth.firmCode}`)).json();
      const serviceId = info.practitioners.find((p: { id: string }) => p.id === login.user.id).service_ids[0];

      const page = await context.newPage();
      await page.goto(`/book/${auth.firmCode}`);
      await page.getByTestId(`service-${serviceId}`).click();
      const card = page.getByTestId(`practitioner-${login.user.id}`);
      await expect(card).toContainText(bio);
      await expect(card).toContainText('RCI registered');
      await expect(card).toContainText('English, Hindi');
      await expect(card.getByRole('img', { name: 'Photo of Jane Doe' })).toHaveAttribute('src', 'https://example.com/jane.jpg');
    } finally {
      await jane.put('/api/v1/users/me', { data: { profile: before ?? null } });
      await context.close();
      await jane.dispose();
      await anon.dispose();
    }
  });
});
