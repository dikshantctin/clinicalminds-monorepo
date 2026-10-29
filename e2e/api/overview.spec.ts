import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { uniq } from '../src/env';

/** GET /analytics/overview — the dashboard's four numbers, counted from real rows (overview_service.py). */
test.describe('/api/v1/analytics/overview', () => {
  requireApi();
  requireAuth();

  test('returns the four counters with their periods', async ({ api }) => {
    const res = await api.get('/api/v1/analytics/overview');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toEqual(
      expect.objectContaining({
        sessions_this_week: expect.any(Number),
        no_shows_this_week: expect.any(Number),
        revenue_collected_paise: expect.any(Number), // the demo user is an ADMIN, who sees money
        patients_needing_followup: expect.any(Number),
        week_start: expect.any(String),
        month_start: expect.any(String),
        scope: 'clinic',
      }),
    );
    expect(new Date(body.week_start).getTime()).toBeLessThanOrEqual(Date.now());
  });

  test('marking a session no-show moves it into no_shows_this_week; a no-show cannot then be cancelled', async ({ api }) => {
    // Other specs (and the 24 h sweep) also add no-shows in parallel, so assert "grew by at least one",
    // and prove this session's own state through its detail endpoint.
    const patientRes = await api.post('/api/v1/patients/', { data: { first_name: uniq('Overview'), last_name: 'Patient' } });
    expect(patientRes.status(), await patientRes.text()).toBe(200);
    const patient = await patientRes.json();
    const overview = async () => (await api.get('/api/v1/analytics/overview')).json();
    try {
      const before = await overview();
      const created = await api.post('/api/v1/sessions/', {
        data: { patient_id: patient.id, scheduled_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(), duration_minutes: 50 },
      });
      expect(created.status(), await created.text()).toBe(200);
      const session = await created.json();

      // status is not a PUT field any more (that bypassed the transition guards)
      const viaPut = await api.put(`/api/v1/sessions/${session.id}`, { data: { status: 'no_show' } });
      expect(viaPut.status()).toBe(400);
      expect((await (await api.get(`/api/v1/sessions/${session.id}`)).json()).status).toBe('scheduled');

      const marked = await api.post(`/api/v1/sessions/${session.id}/no-show`, { data: { reason: 'did not turn up' } });
      expect(marked.status(), await marked.text()).toBe(200);
      expect((await marked.json()).status).toBe('no_show');
      await expect.poll(async () => (await overview()).no_shows_this_week).toBeGreaterThanOrEqual(before.no_shows_this_week + 1);

      expect((await api.post(`/api/v1/sessions/${session.id}/no-show`)).status(), 'no-show twice').toBe(409);
      expect((await api.post(`/api/v1/sessions/${session.id}/cancel`)).status(), 'cancel a no-show').toBe(409);
      const detail = await (await api.get(`/api/v1/sessions/${session.id}`)).json();
      expect(detail.status).toBe('no_show');
      expect(detail.session_notes).toContain('did not turn up');
    } finally {
      await api.delete(`/api/v1/patients/${patient.id}`);
    }
  });

  test('a session still "scheduled" 24 h after its end is swept into no_show when the overview is read', async ({ api }) => {
    const patient = await (await api.post('/api/v1/patients/', { data: { first_name: uniq('Stale'), last_name: 'Patient' } })).json();
    try {
      const session = await (
        await api.post('/api/v1/sessions/', { data: { patient_id: patient.id, scheduled_at: new Date(Date.now() + 86_400_000).toISOString(), duration_minutes: 50 } })
      ).json();
      // the create endpoint refuses past times; the update endpoint does not
      const moved = await api.put(`/api/v1/sessions/${session.id}`, { data: { scheduled_at: new Date(Date.now() - 26 * 3_600_000).toISOString() } });
      expect(moved.status(), await moved.text()).toBe(200);

      expect((await api.get('/api/v1/analytics/overview')).status()).toBe(200);
      const swept = await (await api.get(`/api/v1/sessions/${session.id}`)).json();
      expect(swept.status).toBe('no_show');
      expect(swept.session_notes).toContain('Marked no-show automatically');

      // and the follow-up queue keeps a "Missed session" card for it (it still needs a rebook call)
      await api.post('/api/v1/kanban/followups/sync');
      const queue = await (await api.get('/api/v1/kanban/followups')).json();
      const card = queue.items.find((t: { related_session_id: string | null }) => t.related_session_id === session.id);
      expect(card, 'missed-session card survives the no_show status').toEqual(expect.objectContaining({ reason: 'missed_session' }));
    } finally {
      await api.delete(`/api/v1/patients/${patient.id}`);
    }
  });

  test('a payment recorded at the desk counts toward revenue collected this month', async ({ api }) => {
    const patient = await (await api.post('/api/v1/patients/', { data: { first_name: uniq('Cash'), last_name: 'Patient' } })).json();
    try {
      const session = await (
        await api.post('/api/v1/sessions/', { data: { patient_id: patient.id, scheduled_at: new Date(Date.now() + 2 * 86_400_000).toISOString() } })
      ).json();
      expect((await api.get(`/api/v1/sessions/${session.id}/payments`)).status()).toBe(200);
      expect(await (await api.get(`/api/v1/sessions/${session.id}/payments`)).json()).toEqual([]);

      const bad = await api.post(`/api/v1/sessions/${session.id}/payments`, { data: { amount_paise: 50000, method: 'bitcoin' } });
      expect(bad.status()).toBe(422);

      const rec = await api.post(`/api/v1/sessions/${session.id}/payments`, { data: { amount_paise: 50000, method: 'upi', reference: 'UPI-e2e-1' } });
      expect(rec.status(), await rec.text()).toBe(200);
      expect(await rec.json()).toEqual(expect.objectContaining({ provider: 'manual', method: 'upi', status: 'paid', amount_paise: 50000, reference: 'UPI-e2e-1' }));
      expect((await api.post(`/api/v1/sessions/${session.id}/payments`, { data: { amount_paise: 1, method: 'cash' } })).status(), 'already paid').toBe(409);

      // the session carries the payment state like an online booking does
      const detail = await (await api.get(`/api/v1/sessions/${session.id}`)).json();
      expect(detail).toEqual(expect.objectContaining({ payment_status: 'paid', amount_paise: 50000 }));

      // revenue this month == the sum of this month's paid rows across the clinic's sessions (parallel-safe:
      // computed from the same rows, not from a before/after delta)
      const overview = await (await api.get('/api/v1/analytics/overview')).json();
      const monthStart = new Date(overview.month_start).getTime();
      const all = await (await api.get('/api/v1/sessions/', { params: { limit: 10000 } })).json();
      let expected = 0;
      for (const s of all.sessions) {
        if (!s.payment_status || s.payment_status === 'pending' || s.payment_status === 'expired') continue;
        const rows = await (await api.get(`/api/v1/sessions/${s.id}/payments`)).json();
        for (const p of rows) {
          if ((p.status === 'paid' || p.status === 'refunded') && p.paid_at && new Date(p.paid_at).getTime() >= monthStart) expected += p.amount_paise;
          if (p.refunded_at && new Date(p.refunded_at).getTime() >= monthStart) expected -= p.refunded_paise;
        }
      }
      expect(overview.revenue_collected_paise).toBeGreaterThanOrEqual(50000);
      // other workers may record payments between the two reads, so allow their deltas but never less
      expect(expected).toBeGreaterThanOrEqual(overview.revenue_collected_paise);
    } finally {
      await api.delete(`/api/v1/patients/${patient.id}`);
    }
  });

  test('a clinician sees only their own week, and no revenue', async ({ anon, api }) => {
    const login = await anon.post('/api/v1/auth/login', { data: { email: 'dr.smith@democlinic.com', password: 'Password123!' } });
    test.skip(login.status() !== 200, `demo psychologist cannot log in (${login.status()}) — seed with scripts/setup_demo_data.py`);
    const body = await login.json();
    const headers = { Authorization: `Bearer ${body.access_token}`, 'X-Tenant-ID': body.tenant.id };
    const res = await anon.get('/api/v1/analytics/overview', { headers });
    test.skip(res.status() === 403, 'demo psychologist is blocked by the verification gate (not on VERIFICATION_TEST_EMAILS)');
    expect(res.status(), await res.text()).toBe(200);
    const mine = await res.json();
    expect(mine.scope).toBe('mine');
    expect(mine.revenue_collected_paise).toBeNull();
    // the same rule narrows the session list, so "my" tiles never sit above a clinic-wide list
    const list = await (await anon.get('/api/v1/sessions/', { params: { limit: 10000 }, headers })).json();
    for (const s of list.sessions) expect(s.therapist_id).toBe(body.user.id);
    // whereas the admin (the suite's user) sees the clinic
    expect((await (await api.get('/api/v1/analytics/overview')).json()).scope).toBe('clinic');
  });
});
