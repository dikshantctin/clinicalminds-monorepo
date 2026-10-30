import { test, expect, requireWeb, requireApi, requireAuth } from '../src/fixtures';
import { uniq } from '../src/env';
import { cleanupServices, createService } from '../src/catalog';

/** /admin/services and /admin/locations, as the E2E admin. */

const created: string[] = [];

test.describe('admin Services page', () => {
  requireWeb();
  requireApi();
  requireAuth();
  test.afterEach(async ({ api }) => cleanupServices(api, created));

  test('the sidebar links to Services and Locations', async ({ page }) => {
    await page.goto('/dashboard');
    await page.getByRole('link', { name: 'Services' }).first().click();
    await expect(page).toHaveURL(/\/admin\/services$/);
    await expect(page.getByRole('heading', { name: 'Services', level: 1 })).toBeVisible();
    await page.getByRole('link', { name: 'Locations' }).first().click();
    await expect(page).toHaveURL(/\/admin\/locations$/);
  });

  test('add (with validation), search, edit, deactivate and delete a service', async ({ page, api }) => {
    const name = uniq('Catalog web');
    await page.goto('/admin/services');

    // add: the form refuses a blank name and a negative price before calling the API
    await page.getByTestId('service-add').click();
    const dialog = page.getByTestId('service-form-dialog');
    await dialog.getByTestId('service-form-price').fill('-5');
    await dialog.getByTestId('service-form-save').click();
    await expect(dialog.getByText('Name is required')).toBeVisible();
    await expect(dialog.getByText('Price cannot be negative')).toBeVisible();
    await dialog.getByTestId('service-form-name').fill(name);
    await dialog.getByTestId('service-form-duration').fill('45');
    await dialog.getByTestId('service-form-price').fill('1500.50');
    await dialog.getByTestId('service-form-save').click();
    await expect(dialog).toBeHidden();

    // search (server side) finds exactly this row; the price shows in rupees
    await page.getByTestId('service-search').fill(name);
    const row = page.getByTestId('services-table').getByRole('row', { name: new RegExp(name) });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('45 min');
    await expect(row).toContainText('₹1,500.50');
    const listed = await (await api.get('/api/v1/catalog/services', { params: { search: name } })).json();
    expect(listed.total).toBe(1);
    created.push(listed.services[0].id);

    // edit
    await row.getByTestId('service-edit').click();
    await expect(dialog.getByTestId('service-form-name')).toHaveValue(name);
    await dialog.getByTestId('service-form-price').fill('2000');
    await dialog.getByTestId('service-form-save').click();
    await expect(dialog).toBeHidden();
    await expect(row).toContainText('₹2,000');

    // deactivate, with confirmation
    await row.getByTestId('service-deactivate').click();
    await page.getByTestId('service-deactivate-dialog').getByRole('button', { name: 'Deactivate' }).click();
    await expect(row).toContainText('Inactive');
    await expect(row.getByTestId('service-activate')).toBeVisible();
    const after = await (await api.get('/api/v1/catalog/services', { params: { search: name } })).json();
    expect(after.services[0]).toEqual(expect.objectContaining({ is_active: false, price: 2000 }));

    // the status filter: Active hides it
    await page.getByRole('button', { name: 'Filters' }).click();
    await page.getByTestId('service-status-filter').selectOption('true');
    await expect(row).toHaveCount(0);
    await page.getByTestId('service-status-filter').selectOption('false');
    await expect(row).toHaveCount(1);

    // delete, with confirmation; Cancel keeps it
    await row.getByTestId('service-delete').click();
    await page.getByTestId('service-delete-dialog').getByRole('button', { name: 'Cancel' }).click();
    await expect(row).toHaveCount(1);
    await row.getByTestId('service-delete').click();
    await page.getByTestId('service-delete-dialog').getByRole('button', { name: 'Delete' }).click();
    await expect(row).toHaveCount(0);
    expect((await (await api.get('/api/v1/catalog/services', { params: { search: name } })).json()).total).toBe(0);
  });

  test('pages through the server results', async ({ page, api }) => {
    const prefix = uniq('Catalog paging');
    // the page size is 20 (APP_CONFIG.PAGE_SIZE): 21 rows make a second page
    for (let i = 1; i <= 21; i += 1) await createService(api, created, { name: `${prefix} ${String(i).padStart(2, '0')}` });
    await page.goto('/admin/services');
    await page.getByTestId('service-search').fill(prefix);
    await expect(page.getByText('Showing 1–20 of 21')).toBeVisible();
    await page.getByRole('button', { name: /next/i }).click();
    await expect(page.getByText('Showing 21–21 of 21')).toBeVisible();
    await expect(page.getByTestId('services-table').getByRole('row', { name: new RegExp(`${prefix} 21`) })).toBeVisible();
  });
});

test.describe('admin Locations page', () => {
  requireWeb();
  requireApi();
  requireAuth();

  test('add with an address, search, edit, deactivate and delete a location', async ({ page, api }) => {
    const name = uniq('Catalog room');
    await page.goto('/admin/locations');
    await page.getByTestId('location-add').click();
    const dialog = page.getByTestId('location-form-dialog');
    await dialog.getByTestId('location-form-save').click();
    await expect(dialog.getByText('Name is required')).toBeVisible();
    await dialog.getByTestId('location-form-name').fill(name);
    await dialog.getByTestId('location-form-line1').fill('12 MG Road');
    await dialog.getByTestId('location-form-city').fill('Bengaluru');
    await dialog.getByTestId('location-form-postal-code').fill('560001');
    await dialog.getByTestId('location-form-save').click();
    await expect(dialog).toBeHidden();

    await page.getByTestId('location-search').fill(name);
    const row = page.getByTestId('locations-table').getByRole('row', { name: new RegExp(name) });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('12 MG Road, Bengaluru, 560001');
    await expect(row).toContainText('In person');
    const { locations } = await (await api.get('/api/v1/catalog/locations', { params: { search: name } })).json();
    const id: string = locations[0].id;
    try {
      expect(locations[0].address).toEqual(
        expect.objectContaining({ line1: '12 MG Road', city: 'Bengaluru', postal_code: '560001', country: 'India' }),
      );

      await row.getByTestId('location-edit').click();
      await dialog.getByTestId('location-form-line1').fill('14 MG Road');
      await dialog.getByTestId('location-form-save').click();
      await expect(dialog).toBeHidden();
      await expect(row).toContainText('14 MG Road');

      await row.getByTestId('location-deactivate').click();
      await page.getByTestId('location-deactivate-dialog').getByRole('button', { name: 'Deactivate' }).click();
      await expect(row).toContainText('Inactive');

      await row.getByTestId('location-delete').click();
      await page.getByTestId('location-delete-dialog').getByRole('button', { name: 'Delete' }).click();
      await expect(row).toHaveCount(0);
    } finally {
      await api.delete(`/api/v1/catalog/locations/${id}`); // no-op (404) when the UI delete worked
    }
  });
});
