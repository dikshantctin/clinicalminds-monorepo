import { test, expect, requireWeb } from '../src/fixtures';
import { uniq } from '../src/env';
import type { Page } from '@playwright/test';

test.use({ storageState: { cookies: [], origins: [] } });

const stepHeading = (page: Page) => page.getByRole('heading', { level: 2 });
const next = (page: Page) => page.getByTestId('onboarding-next');

async function fillOrganization(page: Page, id: string) {
  await page.getByTestId('org-name').fill(`E2E ${id} Clinic`);
  await page.getByTestId('org-type').selectOption('clinic');
  await page.getByTestId('org-contact-email').fill(`${id}@example.com`);
  await page.getByTestId('org-contact-phone').fill('+91 98765 43210');
  await page.getByLabel('Address Line 1').fill('1 Main Street');
  await page.getByLabel('City').fill('Pune');
  await page.getByLabel('State/Province').fill('Maharashtra');
  await page.getByLabel('Postal Code').fill('411001');
}

test.describe('onboarding wizard validation', () => {
  requireWeb();

  test('step 1: bad email, bad phone and no type block Next with visible errors; valid input proceeds', async ({ page }) => {
    await page.goto('/auth/register');
    await expect(stepHeading(page)).toHaveText('Organization Details');
    await fillOrganization(page, uniq('onb-web'));
    await page.getByTestId('org-type').selectOption('');
    await page.getByTestId('org-contact-email').fill('not-an-email');
    await page.getByTestId('org-contact-phone').fill('12345abcde');
    await next(page).click();

    await expect(stepHeading(page)).toHaveText('Organization Details');
    await expect(page.getByText('Enter a valid email address')).toBeVisible();
    await expect(page.getByText('Enter a valid phone number (10-15 digits, optional leading +)')).toBeVisible();
    await expect(page.getByText('Select an organization type')).toBeVisible();
    await expect(page.getByTestId('org-contact-email')).toHaveAttribute('aria-invalid', 'true');

    await page.getByTestId('org-type').selectOption('clinic');
    await page.getByTestId('org-contact-email').fill('clinic@example.com');
    await page.getByTestId('org-contact-phone').fill('+91 98765 43210');
    await expect(page.getByText('Enter a valid email address')).toHaveCount(0); // clears as it is fixed
    await next(page).click();
    await expect(stepHeading(page)).toHaveText('Choose Your Plan');
  });

  test('step 2: plan cards show exact limits and no removed AI/crisis/analytics features', async ({ page }) => {
    await page.goto('/auth/register');
    await fillOrganization(page, uniq('onb-web'));
    await next(page).click();
    await expect(page.getByTestId('plan-trial-limits')).toHaveText('5 users · 100 patients · 500 sessions/mo');
    await expect(page.getByTestId('plan-basic-limits')).toHaveText('10 users · 300 patients · 1,200 sessions/mo');
    await expect(page.getByTestId('plan-enterprise-limits')).toHaveText('100 users · 5,000 patients · 20,000 sessions/mo');
    for (const removed of [/\bAI\b/, /crisis/i, /analytics/i]) {
      await expect(page.getByRole('radiogroup')).not.toContainText(removed);
    }
  });

  test('step 3: bad admin email/phone block Next; valid input proceeds; payload carries country and no AI flags', async ({ page }) => {
    const id = uniq('onb-web');
    await page.goto('/auth/register');
    await fillOrganization(page, id);
    await next(page).click();
    await page.getByTestId('plan-professional').click();
    await next(page).click();
    await expect(stepHeading(page)).toHaveText('Administrator Setup');

    await page.getByLabel('First Name').fill('E2E');
    await page.getByLabel('Last Name').fill('Admin');
    await page.getByTestId('admin-email').fill('admin-at-example');
    await page.getByTestId('admin-phone').fill('call me');
    await page.locator('input[autocomplete="new-password"]').fill('Password123!');
    await next(page).click();
    await expect(stepHeading(page)).toHaveText('Administrator Setup');
    await expect(page.getByText('Enter a valid email address')).toBeVisible();
    await expect(page.getByText('Enter a valid phone number (10-15 digits, optional leading +)')).toBeVisible();

    await page.getByTestId('admin-email').fill(`${id}-admin@example.com`);
    await page.getByTestId('admin-phone').fill('+919876543210');
    await next(page).click();
    await expect(stepHeading(page)).toHaveText('Verify Contact Information');
    await expect(page.getByText('No phone entered')).toHaveCount(0);

    // Reach Review with verification stubbed (phone.email is a third-party widget) and check the payload
    await page.route('**/api/v1/verification/status**', (route) =>
      route.fulfill({ json: { email_verified: true, phone_verified: true } }),
    );
    await page.getByRole('button', { name: 'Previous' }).click();
    await next(page).click();
    await expect(page.getByTestId('verify-phone')).toContainText('Verified');
    await next(page).click();
    await expect(stepHeading(page)).toHaveText('Team Members');

    // step 5: a team member with a bad email is not added
    await page.getByRole('button', { name: 'Add Team Member' }).click();
    await page.getByLabel('First Name').fill('Team');
    await page.getByLabel('Last Name').fill('Member');
    await page.getByTestId('member-email').fill('bad-email');
    await page.getByLabel('License Number').fill('LIC-1');
    await page.getByTestId('member-add').click();
    await expect(page.getByText('Enter a valid email address')).toBeVisible();
    await expect(page.getByText(/Team Members \(\d\)/)).toHaveCount(0);
    await page.getByTestId('member-email').fill(`${id}-team@example.com`);
    await page.getByTestId('member-add').click();
    await expect(page.getByText('Team Members (1)')).toBeVisible();

    await next(page).click(); // branding
    const validate = page.waitForRequest('**/api/v1/onboarding/validate');
    await next(page).click(); // review
    await expect(stepHeading(page)).toHaveText('Review & Complete');
    await expect(page.getByText('Country', { exact: true })).toBeVisible();
    await next(page).click(); // Complete Setup → validate first
    const body = (await validate).postDataJSON();
    expect(body.organization.country).toBe('India');
    expect(body.plan.features).not.toHaveProperty('ai_enabled');
    expect(body.plan.features).not.toHaveProperty('crisis_detection');
    expect(body.team_members[0]).not.toHaveProperty('phone'); // empty optional fields are left out
  });
});
