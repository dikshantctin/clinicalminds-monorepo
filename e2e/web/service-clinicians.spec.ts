import { test, expect, requireWeb, requireApi, requireAuth } from '../src/fixtures';
import { uniq } from '../src/env';
import { adminApi, demoClinicianIds } from '../src/catalog';

/**
 * The admin chooses who offers a service in the service form. A service with nobody is not on the
 * public booking page (links are admin-only).
 */
const names: string[] = [];

test.describe('service form: who offers this service', () => {
  requireWeb();
  requireApi();
  requireAuth();

  test.afterAll(async () => {
    const api = await adminApi();
    for (const name of names) {
      const { services } = await (await api.get('/api/v1/catalog/services', { params: { search: name } })).json();
      for (const s of services ?? []) await api.delete(`/api/v1/catalog/services/${s.id}`);
    }
    await api.dispose();
  });

  test('adding a service with a clinician makes it bookable; editing changes who offers it', async ({ page, api, anon, auth }) => {
    const [janeId, smithId] = await demoClinicianIds();
    const name = uniq('Picker');
    names.push(name);

    await page.goto('/admin/services');
    await page.getByTestId('service-add').click();
    const dialog = page.getByTestId('service-form-dialog');
    await dialog.getByTestId('service-form-name').fill(name);
    await dialog.getByTestId('service-form-price').fill('0');
    await expect(dialog.getByTestId(`service-form-clinician-${janeId}`)).not.toBeChecked(); // a new service starts with nobody
    await dialog.getByTestId(`service-form-clinician-${janeId}`).check();
    await dialog.getByTestId('service-form-save').click();
    await expect(dialog).toBeHidden();

    const { services } = await (await api.get('/api/v1/catalog/services', { params: { search: name } })).json();
    const serviceId = services[0].id;
    expect((await (await api.get(`/api/v1/catalog/services/${serviceId}/clinicians`)).json()).clinician_ids).toEqual([janeId]);
    const info = await (await anon.get(`/api/v1/public/booking/${auth.firmCode}`)).json();
    expect(info.services.map((s: { id: string }) => s.id)).toContain(serviceId);

    await page.getByTestId('service-search').fill(name);
    const row = page.getByTestId('services-table').getByRole('row', { name: new RegExp(name) });
    await expect(row.getByTestId('service-clinician-count')).toHaveText('1');
    await row.getByTestId('service-edit').click();
    await expect(dialog.getByTestId(`service-form-clinician-${janeId}`)).toBeChecked();
    await expect(dialog.getByTestId(`service-form-clinician-${smithId}`)).not.toBeChecked();
    await dialog.getByTestId(`service-form-clinician-${janeId}`).uncheck();
    await dialog.getByTestId(`service-form-clinician-${smithId}`).check();
    await dialog.getByTestId('service-form-save').click();
    await expect(dialog).toBeHidden();
    expect((await (await api.get(`/api/v1/catalog/services/${serviceId}/clinicians`)).json()).clinician_ids).toEqual([smithId]);
  });

  test('a service saved with nobody is not on the booking page, and the table says so', async ({ page, api, anon, auth }) => {
    const name = uniq('Nobody');
    names.push(name);
    await page.goto('/admin/services');
    await page.getByTestId('service-add').click();
    const dialog = page.getByTestId('service-form-dialog');
    await dialog.getByTestId('service-form-name').fill(name);
    await dialog.getByTestId('service-form-save').click();
    await expect(dialog).toBeHidden();

    const { services } = await (await api.get('/api/v1/catalog/services', { params: { search: name } })).json();
    const info = await (await anon.get(`/api/v1/public/booking/${auth.firmCode}`)).json();
    expect(info.services.map((s: { id: string }) => s.id)).not.toContain(services[0].id);
    await page.getByTestId('service-search').fill(name);
    const row = page.getByTestId('services-table').getByRole('row', { name: new RegExp(name) });
    await expect(row.getByTestId('service-clinician-count')).toHaveText('None');
  });
});
