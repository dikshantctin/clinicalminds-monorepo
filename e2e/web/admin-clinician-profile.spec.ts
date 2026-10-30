import { request as pwRequest } from '@playwright/test';
import { test, expect, requireWeb, requireApi, requireAuth } from '../src/fixtures';
import { env, uniq, DEMO_PSYCHOLOGIST } from '../src/env';
import { demoClinicianIds } from '../src/catalog';

test.describe('admin edits a clinician\'s booking profile (Settings → Users & Permissions)', () => {
  requireWeb();
  requireApi();
  requireAuth();

  test('the admin opens a clinician, saves a bio, and it is stored on that clinician', async ({ page, api }) => {
    const [, smith] = await demoClinicianIds(); // the psychologist: web/clinician-profile.spec.ts edits Jane's own
    const path = `/api/v1/users/${smith}/clinician-profile`;
    const before = (await (await api.get(path)).json()).profile;
    const bio = `Written by the admin ${uniq('bio')}`;
    try {
      await page.goto('/dashboard/settings');
      await page.getByRole('tab', { name: 'Users & Permissions' }).click();
      await page.getByTestId(`edit-clinician-profile-${smith}`).click();
      const dialog = page.getByTestId('clinician-profile-dialog');
      await expect(dialog).toBeVisible();
      await dialog.getByTestId('clinician-profile-bio').fill(bio);
      await dialog.getByTestId('clinician-profile-languages').fill('English, Marathi');
      await dialog.getByTestId('clinician-profile-save').click();
      await expect(page.getByText(/Booking profile of .* saved/)).toBeVisible();
      await expect(dialog).toBeHidden();

      const saved = (await (await api.get(path)).json()).profile;
      expect(saved).toEqual(expect.objectContaining({ bio, languages: ['English', 'Marathi'] }));

      await page.getByTestId(`edit-clinician-profile-${smith}`).click(); // reopening shows the saved values
      await expect(page.getByTestId('clinician-profile-bio')).toHaveValue(bio);
    } finally {
      if (before) await api.put(path, { data: before });
      else {
        const login = await (await (await pwRequest.newContext({ baseURL: env.API_URL })).post('/api/v1/auth/login', { data: DEMO_PSYCHOLOGIST })).json();
        const own = await pwRequest.newContext({ baseURL: env.API_URL, extraHTTPHeaders: { Authorization: `Bearer ${login.access_token}` } });
        await own.put('/api/v1/users/me', { data: { profile: null } });
        await own.dispose();
      }
    }
  });
});
