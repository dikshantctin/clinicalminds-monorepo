import { test, expect, expectNoCrash, requireWeb, requireAuth } from '../src/fixtures';
import { AddPatientPage } from '../src/pages/patients.page';
import { uniq } from '../src/env';

test.describe('patients UI', () => {
  requireWeb();
  requireAuth();

  test('list page renders', async ({ page }) => {
    await page.goto('/dashboard/patients');
    await expect(page.getByRole('heading', { name: 'Patient Management' })).toBeVisible();
  });

  test('add-patient form renders all fields', async ({ page }) => {
    const form = new AddPatientPage(page);
    await form.goto();
    for (const field of [form.firstName, form.lastName, form.email, form.phone, form.primaryDiagnosis, form.intakeNotes]) {
      await expect(field).toBeVisible();
    }
    await expect(form.primaryDiagnosis).toHaveAttribute('placeholder', /Generalized Anxiety Disorder/);
    await expect(form.submit).toBeVisible();
  });

  test('submitting an empty form does not leave the page', async ({ page }) => {
    const form = new AddPatientPage(page);
    await form.goto();
    await form.submit.click();
    await expect(page).toHaveURL(/\/dashboard\/patients\/new$/);
    await expect(page.getByText('Patient created successfully!')).toHaveCount(0);
  });

  test('creating a patient redirects to the list and shows a success toast', async ({ page, api }) => {
    const first = uniq('UI');
    const form = new AddPatientPage(page);
    await form.goto();
    await form.firstName.fill(first);
    await form.lastName.fill('Patient');
    await form.email.fill(`${first.toLowerCase()}@example.com`);
    await form.primaryDiagnosis.fill('Generalized Anxiety Disorder');
    await form.intakeNotes.fill('Created by the e2e web suite');
    await form.submit.click();

    await expect(page.getByText('Patient created successfully!')).toBeVisible();
    await expect(page).toHaveURL(/\/dashboard\/patients$/);
    await expect(page.getByText(`${first} Patient`)).toBeVisible(); // the email cell also contains `first`

    // cleanup through the API
    const list = await (await api.get('/api/v1/patients/')).json();
    const created = list.patients.find((p: { first_name: string }) => p.first_name === first);
    if (created) await api.delete(`/api/v1/patients/${created.id}`);
  });

  test('patient detail page opens from the list', async ({ page, api }) => {
    const first = uniq('Detail');
    const patient = await (await api.post('/api/v1/patients/', { data: { first_name: first, last_name: 'Patient' } })).json();
    try {
      await page.goto(`/dashboard/patients/${patient.id}`);
      await expect(page.getByText(first).first()).toBeVisible();
      await expectNoCrash(page);
    } finally {
      await api.delete(`/api/v1/patients/${patient.id}`);
    }
  });
});
