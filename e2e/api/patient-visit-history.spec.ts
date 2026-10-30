import { APIRequestContext } from '@playwright/test';
import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { uniq } from '../src/env';

/**
 * GET /patients/ carries each listed patient's visit history from real sessions:
 *   visit_counts[id]      = completed sessions
 *   last_sessions[id]     = scheduled_at of the latest completed session
 *   upcoming_sessions[id] = scheduled_at of the earliest future session still scheduled
 * Cancelled and no-show sessions count for neither. They used to be empty objects, so every row read "0 visits".
 */
const day = (n: number) => new Date(Date.now() + n * 86400_000).toISOString().replace(/\.\d+Z$/, 'Z');

async function session(api: APIRequestContext, patientId: string, inDays: number): Promise<{ id: string; scheduled_at: string }> {
  const res = await api.post('/api/v1/sessions/', { data: { patient_id: patientId, scheduled_at: day(inDays), duration_minutes: 50 } });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

async function listed(api: APIRequestContext, name: string) {
  const res = await api.get('/api/v1/patients/', { params: { search: name } });
  expect(res.status()).toBe(200);
  return res.json();
}

test.describe('/api/v1/patients/ visit history', () => {
  requireApi();
  requireAuth();

  test('counts completed sessions, last completed and next scheduled; ignores cancelled and no-show', async ({ api }) => {
    const name = uniq('Visits');
    const created = await api.post('/api/v1/patients/', { data: { first_name: name, last_name: 'Patient' } });
    expect(created.status()).toBe(200);
    const patientId: string = (await created.json()).id;
    try {
      const done = await session(api, patientId, 1);
      expect((await api.post(`/api/v1/sessions/${done.id}/start`)).status()).toBe(200);
      expect((await api.post(`/api/v1/sessions/${done.id}/complete`, { data: {} })).status()).toBe(200);

      const cancelled = await session(api, patientId, 2);
      expect((await api.post(`/api/v1/sessions/${cancelled.id}/cancel`, { data: {} })).status()).toBe(200);
      const noShow = await session(api, patientId, 4);
      expect((await api.post(`/api/v1/sessions/${noShow.id}/no-show`, { data: {} })).status()).toBe(200);
      const next = await session(api, patientId, 3);
      await session(api, patientId, 6);

      const body = await listed(api, name);
      expect(body.patients.map((p: { id: string }) => p.id)).toEqual([patientId]);
      expect(body.visit_counts[patientId]).toBe(1);
      expect(new Date(body.last_sessions[patientId]).getTime()).toBe(new Date(done.scheduled_at).getTime());
      expect(new Date(body.upcoming_sessions[patientId]).getTime()).toBe(new Date(next.scheduled_at).getTime());
    } finally {
      await api.delete(`/api/v1/patients/${patientId}`);
    }
  });

  test('a patient with no sessions has 0 visits and no dates', async ({ api }) => {
    const name = uniq('NoVisits');
    const created = await api.post('/api/v1/patients/', { data: { first_name: name, last_name: 'Patient' } });
    const patientId: string = (await created.json()).id;
    try {
      const body = await listed(api, name);
      expect(body.visit_counts[patientId]).toBe(0);
      expect(body.last_sessions[patientId]).toBeNull();
      expect(body.upcoming_sessions[patientId]).toBeNull();
    } finally {
      await api.delete(`/api/v1/patients/${patientId}`);
    }
  });

  test('without a token → 401', async ({ anon }) => {
    expect((await anon.get('/api/v1/patients/')).status()).toBe(401);
  });
});
