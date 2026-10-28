import { Page, Locator } from '@playwright/test';

/** /dashboard/patients/new — AddPatientPage (field `name` attributes are camelCase). */
export class AddPatientPage {
  readonly firstName: Locator;
  readonly lastName: Locator;
  readonly email: Locator;
  readonly phone: Locator;
  readonly primaryDiagnosis: Locator;
  readonly intakeNotes: Locator;
  readonly submit: Locator;

  constructor(private readonly page: Page) {
    this.firstName = page.locator('[name="firstName"]');
    this.lastName = page.locator('[name="lastName"]');
    this.email = page.locator('[name="email"]');
    this.phone = page.locator('[name="phone"]');
    this.primaryDiagnosis = page.locator('[name="primaryDiagnosis"]');
    this.intakeNotes = page.locator('[name="intakeNotes"]');
    this.submit = page.locator('button[type="submit"]');
  }

  async goto(): Promise<void> {
    await this.page.goto('/dashboard/patients/new');
  }
}
