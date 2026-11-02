import { test, expect, expectNoCrash, requireWeb, requireAuth } from '../src/fixtures';
import type { Page } from '@playwright/test';

/**
 * GET /teams/teams pages at 50 (max 100). The Teams page and the kanban used to read page 1 only, so a
 * clinic's 51st team never showed. Creating 100+ teams in the shared DB is heavy, so the list endpoint
 * is answered here and the spec asserts the exact pages the client asks for and what it renders.
 */
const fakeTeam = (n: number) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  name: `Paged Team ${n}`,
  description: null,
  team_type: 'CLINICAL',
  color: '#3B82F6',
  member_count: 0,
  team_leader_id: null,
  is_active: true,
  created_at: '2026-10-30T00:00:00Z',
  members: [],
});

/** Answers the team list with `totalPages` pages (100 teams each, 1 on the last); records the query strings. */
const stubTeamList = async (page: Page, totalPages: number) => {
  const requests: Record<string, string>[] = [];
  await page.route(/\/api\/v1\/teams\/teams(\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const params = Object.fromEntries(new URL(route.request().url()).searchParams);
    requests.push(params);
    const p = Number(params.page ?? 1);
    const count = p < totalPages ? 100 : 1;
    const teams = Array.from({ length: count }, (_, i) => fakeTeam((p - 1) * 100 + i + 1));
    await route.fulfill({
      json: { teams, total: (totalPages - 1) * 100 + 1, page: p, per_page: 100, total_pages: totalPages },
    });
  });
  return requests;
};

test.describe('teams list: every page is loaded', () => {
  requireWeb();
  requireAuth();

  test('Teams page requests page 1 and 2 and shows the team from page 2', async ({ page }) => {
    const requests = await stubTeamList(page, 2);
    await page.goto('/dashboard/teams');
    await expect(page.getByTestId(`team-card-${fakeTeam(101).id}`)).toBeVisible();
    await expect(page.getByTestId(`team-card-${fakeTeam(1).id}`)).toBeVisible();
    expect(requests).toEqual([
      { page: '1', per_page: '100' },
      { page: '2', per_page: '100' },
    ]);
    await expectNoCrash(page);
  });

  test('a single page is requested once', async ({ page }) => {
    const requests = await stubTeamList(page, 1);
    await page.goto('/dashboard/teams');
    await expect(page.getByTestId(`team-card-${fakeTeam(1).id}`)).toBeVisible();
    await expect(page.getByTestId(`team-card-${fakeTeam(2).id}`)).toHaveCount(0);
    expect(requests).toEqual([{ page: '1', per_page: '100' }]);
  });

  test('the kanban also walks every team page', async ({ page }) => {
    const requests = await stubTeamList(page, 2);
    await page.goto('/dashboard/tasks');
    await expect.poll(() => requests.length).toBe(2);
    expect(requests).toEqual([
      { page: '1', per_page: '100' },
      { page: '2', per_page: '100' },
    ]);
  });
});
