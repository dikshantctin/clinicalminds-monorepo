import { APIRequestContext } from '@playwright/test';
import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { uniq } from '../src/env';
import { backdate, bookSession } from '../src/sessions';

/**
 * A session still "scheduled" cannot be completed, marked no-show or tagged attended / no-show before its
 * start time (409): that would count a session that has not happened. Starting early is fine, and a started
 * session can be completed or tagged attended at any time.
 */
const NOT_STARTED = 'A session that has not started cannot be marked attended or no-show';

async function future(api: APIRequestContext, patientId: string): Promise<string> {
  const res = await bookSession(api, { patient_id: patientId, scheduled_at: new Date(Date.now() + 2 * 86_400_000).toISOString() });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).id;
}

test.describe('closing a session before it starts', () => {
  requireApi();
  requireAuth();

  test('complete and no-show on a future scheduled session → 409; nothing changes', async ({ api }) => {
    const patient = await (await api.post('/api/v1/patients/', { data: { first_name: uniq('Early'), last_name: 'Patient' } })).json();
    try {
      const id = await future(api, patient.id);
      for (const action of ['complete', 'no-show']) {
        const res = await api.post(`/api/v1/sessions/${id}/${action}`, { data: {} });
        expect(res.status(), action).toBe(409);
        expect((await res.json()).message).toBe(NOT_STARTED);
      }
      expect(await (await api.get(`/api/v1/sessions/${id}`)).json()).toEqual(expect.objectContaining({ status: 'scheduled', outcome: null }));

      // once its time has come, both work
      await backdate(api, id);
      expect((await api.post(`/api/v1/sessions/${id}/no-show`, { data: {} })).status()).toBe(200);
      const other = await future(api, patient.id);
      await backdate(api, other, 120);
      expect((await api.post(`/api/v1/sessions/${other}/complete`, { data: {} })).status()).toBe(200);
    } finally {
      await api.delete(`/api/v1/patients/${patient.id}`);
    }
  });

  test('a session started early can be completed, or tagged attended, before its scheduled time', async ({ api }) => {
    const patient = await (await api.post('/api/v1/patients/', { data: { first_name: uniq('StartedEarly'), last_name: 'Patient' } })).json();
    try {
      const a = await future(api, patient.id);
      expect((await api.post(`/api/v1/sessions/${a}/start`)).status()).toBe(200);
      expect((await api.post(`/api/v1/sessions/${a}/complete`, { data: {} })).status()).toBe(200);
      expect(await (await api.get(`/api/v1/sessions/${a}`)).json()).toEqual(expect.objectContaining({ status: 'completed', outcome: 'attended' }));

      const b = await future(api, patient.id);
      expect((await api.post(`/api/v1/sessions/${b}/start`)).status()).toBe(200);
      const tagged = await api.put(`/api/v1/sessions/${b}/outcome`, { data: { outcome: 'attended' } });
      expect(tagged.status(), await tagged.text()).toBe(200);
      expect((await tagged.json()).status).toBe('completed');
    } finally {
      await api.delete(`/api/v1/patients/${patient.id}`);
    }
  });
});
