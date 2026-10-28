import { Page, Locator } from '@playwright/test';

/** Sidebar entries from frontend/src/config/navigation.ts. */
export const NAV = {
  Overview: '/dashboard',
  Patients: '/dashboard/patients',
  Sessions: '/dashboard/sessions',
  Tasks: '/dashboard/tasks',
  Teams: '/dashboard/teams',
  'AI Assistant': '/dashboard/ai-assistant',
  'Crisis Management': '/dashboard/crisis',
  Analytics: '/dashboard/analytics',
  Settings: '/dashboard/settings',
} as const;

export type NavName = keyof typeof NAV;

/** Page headings rendered by each dashboard page (h1/h2 text). */
export const PAGE_HEADING: Partial<Record<NavName, string | RegExp>> = {
  Overview: /Welcome back,/,
  Patients: 'Patient Management',
  Sessions: 'Session Management',
  Tasks: 'Task Management',
  Teams: 'Team Management',
  'Crisis Management': 'Crisis Management',
  Analytics: 'Analytics',
};

export class DashboardPage {
  constructor(private readonly page: Page) {}

  /** Sidebar links are rendered as "<emoji><name>" (e.g. "📊Overview"), so anchor on the suffix. */
  navLink(name: NavName): Locator {
    return this.page.getByRole('link', { name: new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }).first();
  }

  heading(text: string | RegExp): Locator {
    return this.page.getByRole('heading', { name: text }).first();
  }

  async goto(path: string = NAV.Overview): Promise<void> {
    await this.page.goto(path);
  }
}
