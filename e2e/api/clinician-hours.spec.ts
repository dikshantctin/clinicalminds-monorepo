import { request as pwRequest } from '@playwright/test';
import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { env } from '../src/env';
import { OwnClinic, OwnMember, deleteClinic, onboardOwnClinic } from '../src/clinics';
import { nextWeekday } from '../src/days';

/**
 * Clinician hours and blocked time (capacity slice c1). A clinician follows the clinic's hours until they
 * set their own; public booking offers only the overlap of the two, minus blocked time. The clinician
 * edits their own, an admin or director anyone's; a colleague gets 403. A fresh clinic: its director is
 * the bookable clinician, plus a therapist colleague.
 */

const CLINIC = { open_days: [1, 2, 3, 4, 5, 6], open: '10:00', close: '18:00', breaks: [] };
const wall = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
const at = (day: string, hhmm: string) => `${day}T${hhmm}:00+05:30`;

test.describe('clinician hours and blocked time', () => {
  requireApi();
  requireAuth();
  test.describe.configure({ mode: 'serial' });

  let clinic: OwnClinic;
  let therapist: OwnMember;
  const tuesday = nextWeekday(2, 3);
  const wednesday = nextWeekday(3, 3);
  test.beforeAll(async () => {
    clinic = await onboardOwnClinic('chours', ['THERAPIST']);
    therapist = clinic.members[0];
  });
  test.afterAll(async () => {
    await therapist?.api.dispose();
    await clinic?.api.dispose();
    if (clinic) await deleteClinic(clinic.adminEmail);
  });

  const hoursUrl = (id: string) => `/api/v1/clinicians/${id}/hours`;
  const blocksUrl = (id: string) => `/api/v1/clinicians/${id}/blocked-time`;
  const slots = async (date: string) => {
    const anon = await pwRequest.newContext({ baseURL: env.API_URL });
    try {
      const res = await anon.get(`/api/v1/public/booking/${clinic.firmCode}/slots`, {
        params: { practitioner_id: clinic.user.id, service_id: clinic.serviceId, date },
      });
      expect(res.status(), await res.text()).toBe(200);
      return ((await res.json()).slots as string[]).map(wall);
    } finally {
      await anon.dispose();
    }
  };

  test('a clinician who set nothing follows the clinic hours', async () => {
    const res = await clinic.api.get(hoursUrl(clinic.user.id));
    expect(res.status(), await res.text()).toBe(200);
    expect(await res.json()).toEqual({ custom: false, ...CLINIC });
  });

  test('a therapist sets their own hours; a colleague cannot read or change another clinician’s (403)', async () => {
    const own = { open_days: [1, 3, 5], open: '11:00', close: '17:00', breaks: [{ start: '13:00', end: '13:30' }] };
    const saved = await therapist.api.put(hoursUrl(therapist.user.id), { data: own });
    expect(saved.status(), await saved.text()).toBe(200);
    expect(await saved.json()).toEqual({ custom: true, ...own });
    expect(await (await therapist.api.get(hoursUrl(therapist.user.id))).json()).toEqual({ custom: true, ...own });

    expect((await therapist.api.get(hoursUrl(clinic.user.id))).status()).toBe(403);
    expect((await therapist.api.put(hoursUrl(clinic.user.id), { data: CLINIC })).status()).toBe(403);
    expect((await therapist.api.post(blocksUrl(clinic.user.id), {
      data: { reason: 'training', starts_at: at(tuesday, '10:00'), ends_at: at(tuesday, '11:00') },
    })).status()).toBe(403);
  });

  test('the director sets a colleague’s hours', async () => {
    const theirs = { open_days: [2, 4], open: '10:00', close: '14:00', breaks: [] };
    const res = await clinic.api.put(hoursUrl(therapist.user.id), { data: theirs });
    expect(res.status(), await res.text()).toBe(200);
    expect(await (await therapist.api.get(hoursUrl(therapist.user.id))).json()).toEqual({ custom: true, ...theirs });
  });

  test('own hours and blocked time shape the public slots; the clinic hours still bound them', async () => {
    const mine = { open_days: [1, 2, 4, 5, 6], open: '12:00', close: '18:00', breaks: [] };
    expect((await clinic.api.put(hoursUrl(clinic.user.id), { data: mine })).status()).toBe(200);
    const block = await clinic.api.post(blocksUrl(clinic.user.id), {
      data: { reason: 'supervision', note: 'Peer supervision', starts_at: at(tuesday, '15:00'), ends_at: at(tuesday, '16:00') },
    });
    expect(block.status(), await block.text()).toBe(201);
    const made = await block.json();
    expect(made).toMatchObject({ clinician_id: clinic.user.id, reason: 'supervision', note: 'Peer supervision' });
    expect(new Date(made.starts_at).getTime()).toBe(new Date(at(tuesday, '15:00')).getTime());

    expect(await slots(tuesday)).toEqual(['12:00', '12:30', '13:00', '13:30', '14:00', '16:00', '16:30', '17:00']);
    expect(await slots(wednesday)).toEqual([]); // not one of the director's days, though the clinic is open

    // hours that start before the clinic opens are saved, but public booking starts when the clinic opens
    const early = { ...mine, open: '08:00' };
    expect((await clinic.api.put(hoursUrl(clinic.user.id), { data: early })).status()).toBe(200);
    expect((await slots(tuesday))[0]).toBe('10:00');

    const listed = await clinic.api.get(blocksUrl(clinic.user.id), { params: { from: tuesday, to: tuesday } });
    expect(listed.status()).toBe(200);
    expect((await listed.json()).map((b: { id: string }) => b.id)).toEqual([made.id]);
    const none = await clinic.api.get(blocksUrl(clinic.user.id), { params: { from: wednesday, to: wednesday } });
    expect(await none.json()).toEqual([]);

    // a colleague cannot remove it; the director can, once
    expect((await therapist.api.delete(`${blocksUrl(clinic.user.id)}/${made.id}`)).status()).toBe(403);
    expect((await clinic.api.delete(`${blocksUrl(clinic.user.id)}/${made.id}`)).status()).toBe(204);
    expect((await clinic.api.delete(`${blocksUrl(clinic.user.id)}/${made.id}`)).status()).toBe(404);
    expect(await slots(tuesday)).toContain('15:00');
  });

  test('"use clinic hours" drops the clinician’s own', async () => {
    const res = await clinic.api.delete(hoursUrl(clinic.user.id));
    expect(res.status(), await res.text()).toBe(200);
    expect(await res.json()).toEqual({ custom: false, ...CLINIC });
    expect(await slots(wednesday)).toContain('10:00');
  });

  test('invalid hours or blocks → 422 and nothing changes', async () => {
    const before = await (await therapist.api.get(hoursUrl(therapist.user.id))).json();
    const bad = [
      { ...CLINIC, open: '17:00', close: '09:00' },
      { ...CLINIC, open_days: [0] },
      { ...CLINIC, breaks: [{ start: '14:00', end: '13:00' }] },
      { ...CLINIC, breaks: [{ start: '08:00', end: '09:00' }] },
      { ...CLINIC, open: '9am' },
    ];
    for (const body of bad) {
      expect((await therapist.api.put(hoursUrl(therapist.user.id), { data: body })).status(), JSON.stringify(body)).toBe(422);
    }
    const msg = await therapist.api.put(hoursUrl(therapist.user.id), { data: { ...CLINIC, open: '17:00', close: '09:00' } });
    expect((await msg.json()).message).toBe('Hours must end after they start');
    expect(await (await therapist.api.get(hoursUrl(therapist.user.id))).json()).toEqual(before);

    const badBlocks = [
      { reason: 'nap', starts_at: at(tuesday, '10:00'), ends_at: at(tuesday, '11:00') },
      { reason: 'training', starts_at: at(tuesday, '11:00'), ends_at: at(tuesday, '10:00') },
      { reason: 'workshop', starts_at: at(tuesday, '10:00'), ends_at: new Date(Date.parse(at(tuesday, '10:00')) + 15 * 86_400_000).toISOString() }, // > 14 days
    ];
    for (const body of badBlocks) {
      expect((await therapist.api.post(blocksUrl(therapist.user.id), { data: body })).status(), JSON.stringify(body)).toBe(422);
    }
    const listed = await therapist.api.get(blocksUrl(therapist.user.id), { params: { from: tuesday, to: nextWeekday(2, 20) } });
    expect(await listed.json()).toEqual([]);
  });

  test('not a clinician of this clinic → 404; no token → 401', async ({ anon }) => {
    const stranger = '00000000-0000-4000-8000-000000000001';
    expect((await clinic.api.get(hoursUrl(stranger))).status()).toBe(404);
    expect((await clinic.api.put(hoursUrl(stranger), { data: CLINIC })).status()).toBe(404);
    expect((await anon.get(hoursUrl(clinic.user.id))).status()).toBe(401);
    expect((await anon.get(blocksUrl(clinic.user.id))).status()).toBe(401);
  });
});
