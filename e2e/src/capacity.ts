import { expect } from '@playwright/test';
import { OwnClinic, OwnMember, onboardOwnClinic } from './clinics';
import { addDays, isoWeekday } from './days';
import { uniqueDay } from './sessions';

const at = (d: string, hhmm: string) => `${d}T${hhmm}:00+05:30`;

export interface CapacityWeek {
  clinic: OwnClinic;
  therapist: OwnMember;
  desk: OwnMember;
  /** The week's Monday (clinic date), two weeks back. */
  monday: string;
}

/**
 * A fresh clinic (default hours Mon–Sat 10:00–18:00) with director "Hema Hours", therapist "Team Member 0"
 * and front desk "Team Member 1", and one past week built from exact times (capacity slice f):
 * - therapist: Tuesday on approved leave, Wednesday 15:00–16:00 blocked; sessions Mon 10:00 (50 + 10 buffer),
 *   Mon 11:00 no-show (50 + 10), Mon 12:00 cancelled, Sun 11:00 (50, no buffer; clinic closed), Thu 17:30
 *   (50, no buffer; runs 20 min past closing)
 *   → available 2340, used 150, no-show 60, free 2190, extra 70, 6 %;
 * - director: own hours Saturday 10:00–11:00 only; Sat 10:00 (50 + 5) → available 60, used 55, free 5, 92 %.
 */
export async function buildCapacityWeek(prefix: string): Promise<CapacityWeek> {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const twoWeeksAgo = addDays(today, -14);
  const monday = addDays(twoWeeksAgo, 1 - isoWeekday(twoWeeksAgo));
  const day = (n: number) => addDays(monday, n); // 0 = Monday … 6 = Sunday

  const clinic = await onboardOwnClinic(prefix, ['THERAPIST', 'SUPPORT_STAFF']);
  const [therapist, desk] = clinic.members;
  const patient = await (
    await clinic.api.post('/api/v1/patients/', { data: { first_name: 'Cap', last_name: 'Patient', assigned_therapist_id: therapist.user.id } })
  ).json();
  // book in the future (a create refuses the past), then move each session to its exact time in the week
  const future = uniqueDay();
  let hour = 9;
  const session = async (when: string, extra: Record<string, unknown> = {}, therapistId = therapist.user.id) => {
    hour += 1;
    const made = await clinic.api.post('/api/v1/sessions/', {
      data: { patient_id: patient.id, therapist_id: therapistId, scheduled_at: at(future, `${String(hour).padStart(2, '0')}:00`), ...extra },
    });
    expect(made.status(), await made.text()).toBe(200);
    const id = (await made.json()).id as string;
    expect((await clinic.api.put(`/api/v1/sessions/${id}`, { data: { scheduled_at: when } })).status()).toBe(200);
    return id;
  };

  const leave = await therapist.api.post(`/api/v1/clinicians/${therapist.user.id}/leave`, {
    data: { reason: 'sick', starts_at: at(day(1), '00:00'), ends_at: at(day(2), '00:00') },
  });
  expect(leave.status(), await leave.text()).toBe(201);
  expect((await clinic.api.post(`/api/v1/leave/${(await leave.json()).id}/approve`)).status()).toBe(200);
  const blocked = await therapist.api.post(`/api/v1/clinicians/${therapist.user.id}/blocked-time`, {
    data: { reason: 'supervision', starts_at: at(day(2), '15:00'), ends_at: at(day(2), '16:00') },
  });
  expect(blocked.status(), await blocked.text()).toBe(201);
  await session(at(day(0), '10:00'));
  const noShow = await session(at(day(0), '11:00'));
  expect((await clinic.api.post(`/api/v1/sessions/${noShow}/no-show`)).status()).toBe(200);
  const cancelled = await session(at(day(0), '12:00'));
  expect((await clinic.api.post(`/api/v1/sessions/${cancelled}/cancel`, { data: { reason: 'e2e' } })).status()).toBe(200);
  await session(at(day(6), '11:00'), { buffer_minutes: 0 });
  await session(at(day(3), '17:30'), { buffer_minutes: 0 });

  const hours = await clinic.api.put(`/api/v1/clinicians/${clinic.user.id}/hours`, {
    data: { open_days: [6], open: '10:00', close: '11:00', breaks: [] },
  });
  expect(hours.status(), await hours.text()).toBe(200);
  await session(at(day(5), '10:00'), { buffer_minutes: 5 }, clinic.user.id);
  return { clinic, therapist, desk, monday };
}
