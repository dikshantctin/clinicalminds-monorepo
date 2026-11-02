import { test, expect, requireWeb, requireAuth } from '../src/fixtures';
import { uniq } from '../src/env';

/** Patient detail shows the clinical record it already receives, and staff can edit the patient in place. */
test.describe('patient detail: clinical record and edit', () => {
  requireWeb();
  requireAuth();

  test('the Clinical tab shows diagnoses, risk factors, intake notes, medications and safety plan; no Activity tab', async ({ page, api }) => {
    const created = await api.post('/api/v1/patients/', {
      data: {
        first_name: uniq('Clinical'), last_name: 'Record',
        primary_diagnosis: 'Generalised anxiety disorder', secondary_diagnoses: ['Insomnia'],
        risk_factors: ['Recent bereavement'], intake_notes: 'Referred by GP for work stress.',
        medications: [{ name: 'Sertraline', dose: '50 mg', frequency: 'daily' }],
        safety_plan: { warning_signs: 'Not sleeping', contacts: 'Sister' },
        emergency_contact: { name: 'Meera Rao', phone: '+919800000001', relationship: 'Sister' },
      },
    });
    const id: string = (await created.json()).id;
    try {
      await page.goto(`/dashboard/patients/${id}`);
      await expect(page.getByTestId('patient-emergency-contact')).toContainText('Meera Rao');
      await expect(page.getByRole('tab', { name: 'Activity' })).toHaveCount(0);
      await page.getByRole('tab', { name: 'Clinical Data' }).click();
      const clinical = page.getByTestId('patient-clinical');
      for (const text of ['Generalised anxiety disorder', 'Insomnia', 'Recent bereavement', 'Referred by GP for work stress.', 'Sertraline', '50 mg', 'Not sleeping', 'Sister']) {
        await expect(clinical).toContainText(text);
      }
      await expect(page.getByText(/coming soon/i)).toHaveCount(0);
    } finally {
      await api.delete(`/api/v1/patients/${id}`);
    }
  });

  test('Edit saves demographics, status and clinical fields; a too-long phone is refused and nothing changes', async ({ page, api }) => {
    const first = uniq('Editable');
    const created = await api.post('/api/v1/patients/', { data: { first_name: first, last_name: 'Before', phone: '+919811111111' } });
    const id: string = (await created.json()).id;
    try {
      await page.goto(`/dashboard/patients/${id}`);
      await page.getByTestId('patient-edit').click();
      const dialog = page.getByTestId('patient-edit-dialog');
      await dialog.getByTestId('patient-edit-phone').fill('+91 98765 43210 ext 12345');
      await dialog.getByTestId('patient-edit-save').click();
      await expect(page.getByTestId('patient-edit-error')).toBeVisible();
      expect((await (await api.get(`/api/v1/patients/${id}`)).json()).phone).toBe('+919811111111');

      await dialog.getByTestId('patient-edit-phone').fill('+919822222222');
      await dialog.getByTestId('patient-edit-last_name').fill('After');
      await dialog.getByTestId('patient-edit-date_of_birth').fill('1988-02-29');
      await dialog.getByTestId('patient-edit-status').selectOption('discharged');
      await dialog.getByTestId('patient-edit-primary_diagnosis').fill('Panic disorder');
      await dialog.getByTestId('patient-edit-risk_factors').fill('Lives alone, Recent job loss');
      await dialog.getByTestId('patient-edit-intake_notes').fill('Second referral.');
      await dialog.getByTestId('patient-edit-save').click();
      await expect(page.getByText('Patient updated')).toBeVisible();
      await expect(dialog).toBeHidden();
      await expect(page.getByRole('heading', { name: `${first} After` })).toBeVisible();

      const row = await (await api.get(`/api/v1/patients/${id}`)).json();
      expect(row).toEqual(expect.objectContaining({
        last_name: 'After', phone: '+919822222222', date_of_birth: '1988-02-29', status: 'discharged',
        primary_diagnosis: 'Panic disorder', risk_factors: ['Lives alone', 'Recent job loss'], intake_notes: 'Second referral.',
      }));
    } finally {
      await api.delete(`/api/v1/patients/${id}`);
    }
  });
});
