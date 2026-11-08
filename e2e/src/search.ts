import { Locator, Page } from '@playwright/test';

/**
 * Type into a debounced search box (SearchInput: SEARCH_DEBOUNCE_MS) and wait until the list endpoint has answered
 * for exactly that text. Without the wait, an assert can pass on the still-unfiltered list (same count, same
 * summary, or a duplicate hidden on its page 2), and a click can land just before the filtered list re-renders.
 */
export async function searchFor(page: Page, box: Locator, text: string, listPath: string): Promise<void> {
  const answered = page.waitForResponse((r) => {
    const url = new URL(r.url());
    return url.pathname === listPath && r.request().method() === 'GET' && r.ok()
      && url.searchParams.get('search') === text;
  });
  await box.fill(text);
  await answered;
}

export const SESSIONS_LIST = '/api/v1/sessions/';
export const PATIENTS_LIST = '/api/v1/patients/';
export const SERVICES_LIST = '/api/v1/catalog/services';
export const FOLLOWUPS_LIST = '/api/v1/kanban/followups';
