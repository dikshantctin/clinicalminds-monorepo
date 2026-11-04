import { request as pwRequest } from '@playwright/test';
import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { env, DEMO_PATIENT } from '../src/env';
import { OwnClinic, OwnMember, deleteClinic, onboardOwnClinic } from '../src/clinics';
import { nextWeekday } from '../src/days';

/**
 * Leave with approval (capacity slice c2). A clinician applies (pending: blocks nothing); an admin or
 * director approves (an admin or director may approve their own) or rejects; the applicant or an approver
 * cancels. Approval is refused while booked sessions fall inside the leave; approved leave removes public
 * slots. Staff booking is not blocked, but GET /clinicians/{id}/time-off says what a booking would overlap.
 * A fresh clinic: director (approver, the bookable clinician) + therapist + front desk.
 */

const at = (day: string, hhmm: string) => `${day}T${hhmm}:00+05:30`;
const wholeDay = (day: string) => ({ starts_at: at(day, '00:00'), ends_at: new Date(Date.parse(at(day, '00:00')) + 86_400_000).toISOString() });

test.describe('clinician leave', () => {
  requireApi();
  requireAuth();
  test.describe.configure({ mode: 'serial' });

  let clinic: OwnClinic;
  let therapist: OwnMember;
  let desk: OwnMember;
  const tuesday = nextWeekday(2, 3);
  const wednesday = nextWeekday(3, 3);
  const thursday = nextWeekday(4, 3);
  const friday = nextWeekday(5, 3);
  test.beforeAll(async () => {
    clinic = await onboardOwnClinic('leave', ['THERAPIST', 'SUPPORT_STAFF']);
    [therapist, desk] = clinic.members;
  });
  test.afterAll(async () => {
    for (const m of clinic?.members ?? []) await m.api.dispose();
    await clinic?.api.dispose();
    if (clinic) await deleteClinic(clinic.adminEmail);
  });

  const apply = (who: { api: OwnClinic['api'] }, clinicianId: string, body: Record<string, unknown>) =>
    who.api.post(`/api/v1/clinicians/${clinicianId}/leave`, { data: body });
  const slots = async (date: string) => {
    const anon = await pwRequest.newContext({ baseURL: env.API_URL });
    try {
      const res = await anon.get(`/api/v1/public/booking/${clinic.firmCode}/slots`, {
        params: { practitioner_id: clinic.user.id, service_id: clinic.serviceId, date },
      });
      expect(res.status(), await res.text()).toBe(200);
      return (await res.json()).slots as string[];
    } finally {
      await anon.dispose();
    }
  };

  test('pending leave blocks nothing; the director approves their own and the day has no slots; cancelling brings them back', async () => {
    const made = await apply(clinic, clinic.user.id, { reason: 'planned', note: 'Family wedding', ...wholeDay(wednesday) });
    expect(made.status(), await made.text()).toBe(201);
    const leave = await made.json();
    expect(leave).toMatchObject({ clinician_id: clinic.user.id, reason: 'planned', note: 'Family wedding', status: 'pending', sessions: [] });
    expect((await slots(wednesday)).length).toBeGreaterThan(0);

    const approved = await clinic.api.post(`/api/v1/leave/${leave.id}/approve`);
    expect(approved.status(), await approved.text()).toBe(200);
    expect((await approved.json()).status).toBe('approved');
    expect(await slots(wednesday)).toEqual([]);
    expect((await slots(tuesday)).length).toBeGreaterThan(0);

    const cancelled = await clinic.api.post(`/api/v1/leave/${leave.id}/cancel`);
    expect(cancelled.status(), await cancelled.text()).toBe(200);
    expect((await cancelled.json()).status).toBe('cancelled');
    expect((await slots(wednesday)).length).toBeGreaterThan(0);
  });

  test('a therapist applies for themselves but cannot approve; only an approver sees the clinic’s requests', async () => {
    const made = await apply(therapist, therapist.user.id, { reason: 'sick', ...wholeDay(tuesday) });
    expect(made.status(), await made.text()).toBe(201);
    const leave = await made.json();
    expect((await therapist.api.post(`/api/v1/leave/${leave.id}/approve`)).status()).toBe(403);
    expect((await therapist.api.post(`/api/v1/leave/${leave.id}/reject`)).status()).toBe(403);
    expect((await apply(therapist, clinic.user.id, { reason: 'sick', ...wholeDay(tuesday) })).status()).toBe(403); // not for a colleague

    const mine = await (await therapist.api.get('/api/v1/leave')).json();
    expect(mine.map((l: { id: string }) => l.id)).toEqual([leave.id]);
    const pending = await (await clinic.api.get('/api/v1/leave', { params: { status: 'pending' } })).json();
    expect(pending.map((l: { id: string }) => l.id)).toEqual([leave.id]);
    expect(pending[0].clinician_name).toBe('Team Member 0');
    expect(await (await desk.api.get('/api/v1/leave')).json()).toEqual([]); // not an approver: only their own

    const rejected = await clinic.api.post(`/api/v1/leave/${leave.id}/reject`);
    expect(rejected.status()).toBe(200);
    expect((await rejected.json()).status).toBe('rejected');
    const again = await clinic.api.post(`/api/v1/leave/${leave.id}/approve`);
    expect(again.status()).toBe(409);
    expect((await again.json()).message).toBe('Only a pending request can be approved');
  });

  test('approval waits until every session booked inside the leave is reassigned or cancelled', async () => {
    const patient = await (
      await clinic.api.post('/api/v1/patients/', { data: { first_name: 'Leave', last_name: 'Patient', assigned_therapist_id: therapist.user.id } })
    ).json();
    const booked = await therapist.api.post('/api/v1/sessions/', { data: { patient_id: patient.id, scheduled_at: at(thursday, '11:00') } });
    expect(booked.status(), await booked.text()).toBe(200);
    const session = await booked.json();

    const made = await apply(therapist, therapist.user.id, { reason: 'casual', ...wholeDay(thursday) });
    expect(made.status(), await made.text()).toBe(201);
    const leave = await made.json();
    expect(leave.sessions).toEqual([{ id: session.id, scheduled_at: expect.any(String) }]);

    const refused = await clinic.api.post(`/api/v1/leave/${leave.id}/approve`);
    expect(refused.status()).toBe(409);
    expect((await refused.json()).message).toBe('Reassign or cancel the 1 booked session in this leave first');
    expect((await clinic.api.post(`/api/v1/sessions/${session.id}/cancel`, { data: { reason: 'clinician on leave' } })).status()).toBe(200);
    const approved = await clinic.api.post(`/api/v1/leave/${leave.id}/approve`);
    expect(approved.status(), await approved.text()).toBe(200);
    expect(await approved.json()).toMatchObject({ status: 'approved', sessions: [] });
  });

  test('staff booking is not blocked, but time-off says what a booking would overlap', async () => {
    const block = await clinic.api.post(`/api/v1/clinicians/${clinic.user.id}/blocked-time`, {
      data: { reason: 'supervision', starts_at: at(friday, '15:00'), ends_at: at(friday, '16:00') },
    });
    expect(block.status(), await block.text()).toBe(201);
    const check = (who: OwnMember | OwnClinic, id: string, starts: string) =>
      who.api.get(`/api/v1/clinicians/${id}/time-off`, { params: { starts_at: starts, minutes: 50 } });

    const onLeave = await check(desk, therapist.user.id, at(thursday, '12:00')); // approved above
    expect(onLeave.status(), await onLeave.text()).toBe(200);
    expect(await onLeave.json()).toEqual([{ kind: 'leave', reason: null }]); // the desk is not told why
    expect(await (await check(desk, clinic.user.id, at(friday, '15:30'))).json()).toEqual([{ kind: 'blocked', reason: 'supervision' }]);
    expect(await (await check(desk, clinic.user.id, at(friday, '11:00'))).json()).toEqual([]);

    const anon = await pwRequest.newContext({ baseURL: env.API_URL });
    try {
      const login = await (await anon.post('/api/v1/auth/login', { data: { ...DEMO_PATIENT, audience: 'patient' } })).json();
      const res = await anon.get(`/api/v1/clinicians/${clinic.user.id}/time-off`, {
        params: { starts_at: at(friday, '15:30'), minutes: 50 },
        headers: { Authorization: `Bearer ${login.access_token}`, 'X-Tenant-ID': login.tenant.id },
      });
      expect(res.status()).toBe(403);
    } finally {
      await anon.dispose();
    }
  });

  test('invalid or overlapping leave is refused; an unknown request → 404; no token → 401', async ({ anon }) => {
    const bad: [Record<string, unknown>, string][] = [
      [{ reason: 'holiday', ...wholeDay(friday) }, 'Pick a reason: sick, casual, planned'],
      [{ reason: 'sick', starts_at: at(friday, '12:00'), ends_at: at(friday, '11:00') }, 'Leave must end after it starts'],
      [{ reason: 'planned', starts_at: at(friday, '00:00'), ends_at: new Date(Date.parse(at(friday, '00:00')) + 61 * 86_400_000).toISOString() }, 'Leave can be at most 60 days'],
    ];
    for (const [body, message] of bad) {
      const res = await apply(therapist, therapist.user.id, body);
      expect(res.status(), JSON.stringify(body)).toBe(422);
      expect((await res.json()).message).toBe(message);
    }
    // the therapist's Thursday leave is approved: a request overlapping it is refused
    const overlap = await apply(therapist, therapist.user.id, { reason: 'sick', starts_at: at(thursday, '15:00'), ends_at: at(friday, '10:00') });
    expect(overlap.status()).toBe(409);
    expect((await overlap.json()).message).toBe('This overlaps another leave request');

    const stranger = '00000000-0000-4000-8000-000000000001';
    expect((await clinic.api.post(`/api/v1/leave/${stranger}/approve`)).status()).toBe(404);
    expect((await anon.get('/api/v1/leave')).status()).toBe(401);
  });
});
