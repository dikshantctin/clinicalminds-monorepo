import { Page, Locator } from '@playwright/test';

/** /auth/login and /portal/login — LoginPage → LoginSection → LoginForm. */
export class LoginPage {
  readonly email: Locator;
  readonly password: Locator;
  readonly submit: Locator;
  readonly heading: Locator;
  readonly registerLink: Locator;
  readonly forgotLink: Locator;

  constructor(private readonly page: Page, readonly path: '/auth/login' | '/portal/login' = '/auth/login') {
    this.email = page.locator('#email');
    this.password = page.locator('#password');
    this.submit = page.getByRole('button', { name: 'Sign in' });
    this.heading = page.getByRole('heading', { name: 'Welcome back', exact: true });
    this.registerLink = page.getByRole('link', { name: 'Register your organization' });
    this.forgotLink = page.getByRole('link', { name: 'Forgot password?' });
  }

  async goto(): Promise<void> {
    await this.page.goto(this.path);
  }

  async login(email: string, password: string): Promise<void> {
    await this.email.fill(email);
    await this.password.fill(password);
    await this.submit.click();
  }
}
