import type { Page } from '@playwright/test';
import { test, expect, requireWeb, requireAuth } from '../src/fixtures';
import { uniq } from '../src/env';
import { bookSession, uniqueDay } from '../src/sessions';

/**
 * The UI calls each API route by its exact path. A path off by a trailing slash gets FastAPI's 307 to an
 * absolute URL built from the Host it sees: behind a same-origin proxy that is the backend's own origin,
 * behind TLS termination an http:// URL, and the browser drops the request (the list shows "No sessions
 * found"). So no /api response the UI receives may be a redirect.
 */
function recordRedirects(page: Page): string[] {
  const redirects: string[] = [];
  page.on('response', (res) => {
    const url = new URL(res.url());
    if (url.pathname.startsWith('/api/') && res.status() >= 300 && res.status() < 400) {
      redirects.push(`${res.request().method()} ${url.pathname} → ${res.status()}`);
    }
  });
  return redirects;
}

test.describe('API paths the UI calls', () => {
  requireWeb();
  requireAuth();

  test('patients list, sessions search and scheduling get no redirects', async ({ page, api }) => {
    const first = uniq('Paths');
    const patient = await (await api.post('/api/v1/patients/', { data: { first_name: first, last_name: 'Patient' } })).json();
    try {
      const booked = await bookSession(api, { patient_id: patient.id, scheduled_at: new Date(Date.now() + 86_400_000).toISOString() });
      expect(booked.status(), await booked.text()).toBe(200);
      const redirects = recordRedirects(page);

      await page.goto('/dashboard/patients');
      await page.getByRole('searchbox', { name: 'Search patients' }).fill(first);
      await expect(page.getByText(`${first} Patient`)).toBeVisible();

      await page.goto('/dashboard/sessions');
      await page.getByRole('searchbox', { name: 'Search sessions' }).fill(first);
      await expect(page.locator('tr', { hasText: first })).toHaveCount(1);

      await page.goto(`/dashboard/sessions/new?patient_id=${patient.id}`);
      // the patient <select> is `required` and its options come from GET /patients: wait until the patient is chosen,
      // or a click before that list arrives fails native validation silently (no POST)
      await expect(page.getByRole('combobox', { name: 'Patient', exact: true })).toHaveValue(patient.id);
      await page.getByLabel('Date & Time').fill(`${uniqueDay()}T11:00`);
      await page.getByRole('button', { name: 'Schedule Session' }).click();
      await expect(page).toHaveURL(/\/dashboard\/sessions$/);
      await page.getByRole('searchbox', { name: 'Search sessions' }).fill(first);
      await expect(page.locator('tr', { hasText: first })).toHaveCount(2);

      expect(redirects).toEqual([]);
    } finally {
      await api.delete(`/api/v1/patients/${patient.id}`);
    }
  });

  test('the list routes still need a token: no token → 401', async ({ anon }) => {
    expect((await anon.get('/api/v1/sessions/', { params: { limit: 1 } })).status()).toBe(401);
    expect((await anon.get('/api/v1/patients/', { params: { limit: 1 } })).status()).toBe(401);
  });
});
