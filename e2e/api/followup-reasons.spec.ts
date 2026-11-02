import { APIRequestContext } from '@playwright/test';
import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { uniq } from '../src/env';

/**
 * Follow-up reasons beyond "missed session" (followups.spec.ts) and "risk flag" (sessions.spec.ts):
 *   no-show  → a missed_session card at once (no 15-minute grace), kept open across syncs
 *   inactive → last completed session 30+ days ago and nothing booked ahead → inactive_patient (medium);
 *              booking a future session resolves it on the next sync
 *   cancelled sessions never produce a card.
 * "No first session" needs a patient created 3+ days ago, which the API cannot backdate: unit-tested only
 * (backend/tests/test_followup_rules.py::test_no_first_session_after_three_days_only).
 */
type Card = { reason: string; priority: string; related_patient_id: string | null; related_session_id: string | null };
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

async function cardsFor(api: APIRequestContext, patientId: string): Promise<Card[]> {
  expect((await api.post('/api/v1/kanban/followups/sync')).status()).toBe(200);
  const queue = await (await api.get('/api/v1/kanban/followups')).json();
  return queue.items.filter((c: Card) => c.related_patient_id === patientId);
}

async function patientWithSession(api: APIRequestContext, label: string) {
  const patient = await (await api.post('/api/v1/patients/', { data: { first_name: uniq(label), last_name: 'Patient' } })).json();
  const res = await api.post('/api/v1/sessions/', { data: { patient_id: patient.id, scheduled_at: iso(2 * HOUR), duration_minutes: 50 } });
  expect(res.status(), await res.text()).toBe(200);
  return { patient, session: await res.json() };
}

test.describe('follow-up reasons', () => {
  requireApi();
  requireAuth();

  test('a no-show becomes a missed_session card straight away and stays a single open card', async ({ api }) => {
    const { patient, session } = await patientWithSession(api, 'NoShowCard');
    try {
      expect((await api.post(`/api/v1/sessions/${session.id}/no-show`, { data: { reason: 'did not attend' } })).status()).toBe(200);
      const cards = await cardsFor(api, patient.id);
      expect(cards).toEqual([expect.objectContaining({ reason: 'missed_session', priority: 'high', related_session_id: session.id })]);
      expect(await cardsFor(api, patient.id)).toHaveLength(1);
    } finally {
      await api.delete(`/api/v1/patients/${patient.id}`);
    }
  });

  test('30+ days since the last completed session with nothing booked → inactive card; booking ahead resolves it', async ({ api }) => {
    const { patient, session } = await patientWithSession(api, 'Inactive');
    let next: { id: string } | undefined;
    try {
      expect((await api.put(`/api/v1/sessions/${session.id}`, { data: { scheduled_at: iso(-35 * DAY) } })).status()).toBe(200);
      expect((await api.post(`/api/v1/sessions/${session.id}/complete`)).status()).toBe(200);
      expect(await cardsFor(api, patient.id)).toEqual([expect.objectContaining({ reason: 'inactive_patient', priority: 'medium', related_session_id: null })]);

      const booked = await api.post('/api/v1/sessions/', { data: { patient_id: patient.id, scheduled_at: iso(3 * DAY), duration_minutes: 50 } });
      expect(booked.status()).toBe(200);
      next = await booked.json();
      expect(await cardsFor(api, patient.id)).toEqual([]);
    } finally {
      if (next) await api.post(`/api/v1/sessions/${next.id}/cancel`, { data: {} });
      await api.delete(`/api/v1/patients/${patient.id}`);
    }
  });

  test('a cancelled session in the past produces no card', async ({ api }) => {
    const { patient, session } = await patientWithSession(api, 'Cancelled');
    try {
      // past its end + grace, so it would be "missed" if it were still scheduled
      expect((await api.put(`/api/v1/sessions/${session.id}`, { data: { scheduled_at: iso(-3 * HOUR) } })).status()).toBe(200);
      expect((await api.post(`/api/v1/sessions/${session.id}/cancel`, { data: { reason: 'patient rescheduled' } })).status()).toBe(200);
      const cards = await cardsFor(api, patient.id);
      expect(cards.filter((c) => c.reason === 'missed_session')).toEqual([]);
    } finally {
      await api.delete(`/api/v1/patients/${patient.id}`);
    }
  });
});
