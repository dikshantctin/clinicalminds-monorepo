import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { OwnClinic, OwnMember, deleteClinic, onboardOwnClinic } from '../src/clinics';

/**
 * Capacity slice e: the worker's beat (every minute) leaves a reminder in the clinician's bell
 * (GET /kanban/notifications) for each of their scheduled sessions starting within 15 minutes:
 * type "session_reminder", the session's id, no task. One per session; a cancelled session's reminder is
 * not shown; rescheduling drops it (a new one comes 15 minutes before the new time).
 * Needs the follow-up worker (celery -B) running, as in CI. A fresh clinic: director + therapist.
 */
const WORKER_BUDGET_MS = 100_000; // the beat runs every 60 s
const clock = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

interface Reminder { id: string; type: string; session_id: string | null; task_id: string | null; title: string; message: string; is_read: boolean }

test.describe('session reminder in the bell', () => {
  requireApi();
  requireAuth();
  test.describe.configure({ mode: 'serial' });

  let clinic: OwnClinic;
  let therapist: OwnMember;
  let patientId: string;
  test.beforeAll(async () => {
    clinic = await onboardOwnClinic('remind', ['THERAPIST']);
    therapist = clinic.members[0];
    const patient = await clinic.api.post('/api/v1/patients/', {
      data: { first_name: 'Remi', last_name: 'Patient', assigned_therapist_id: therapist.user.id },
    });
    expect(patient.status(), await patient.text()).toBe(200);
    patientId = (await patient.json()).id;
  });
  test.afterAll(async () => {
    await therapist?.api.dispose();
    await clinic?.api.dispose();
    if (clinic) await deleteClinic(clinic.adminEmail);
  });

  const book = async (therapistId: string, at: string) => {
    const res = await clinic.api.post('/api/v1/sessions/', { data: { patient_id: patientId, therapist_id: therapistId, scheduled_at: at } });
    expect(res.status(), await res.text()).toBe(200);
    return (await res.json()) as { id: string; scheduled_at: string };
  };
  const reminders = async (who: { api: OwnClinic['api'] }) => {
    const res = await who.api.get('/api/v1/kanban/notifications');
    expect(res.status()).toBe(200);
    return ((await res.json()) as Reminder[]).filter((n) => n.type === 'session_reminder');
  };

  test('a therapist gets one reminder for a session in 12 minutes; not for one later, nor for a cancelled one', async () => {
    test.setTimeout(WORKER_BUDGET_MS + 30_000);
    const soon = await book(therapist.user.id, inMinutes(12));
    const later = await book(therapist.user.id, inMinutes(150));
    const cancelled = await book(clinic.user.id, inMinutes(13)); // the director is a clinician too
    expect((await clinic.api.post(`/api/v1/sessions/${cancelled.id}/cancel`, { data: { reason: 'e2e' } })).status()).toBe(200);

    await expect.poll(async () => (await reminders(therapist)).length, { timeout: WORKER_BUDGET_MS, intervals: [2_000] }).toBe(1);
    const [reminder] = await reminders(therapist);
    expect(reminder).toEqual(
      expect.objectContaining({
        session_id: soon.id,
        task_id: null,
        title: `Session at ${clock(soon.scheduled_at)}`,
        message: 'With Remi',
        is_read: false,
      }),
    );
    expect((await reminders(therapist)).map((r) => r.session_id)).not.toContain(later.id);
    expect((await reminders(clinic)).map((r) => r.session_id)).not.toContain(cancelled.id);

    // read like any other notification
    expect((await therapist.api.post(`/api/v1/kanban/notifications/${reminder.id}/mark-read`)).status()).toBe(200);
    expect((await reminders(therapist))[0].is_read).toBe(true);
  });

  test('rescheduling drops the reminder (a new one comes before the new time)', async () => {
    const [reminder] = await reminders(therapist);
    const moved = await clinic.api.put(`/api/v1/sessions/${reminder.session_id}`, { data: { scheduled_at: inMinutes(60) } }); // clear of the 150-minute one with its buffer
    expect(moved.status(), await moved.text()).toBe(200);
    expect(await reminders(therapist)).toEqual([]);
  });
});
