import { APIRequestContext } from '@playwright/test';
import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { uniq } from '../src/env';
import { demoClinicianIds } from '../src/catalog';
import { openDay } from '../src/days';

/**
 * "Any available" clinician (practitioner_id = "any", or left out): the slots are the union of the free
 * slots of the clinicians assigned to the service; a booking goes to the first assigned clinician free at
 * that time; when none is free → 409. A clinician not assigned to the service is never chosen.
 */

const TEST_PHONE = '+919876543210'; // VERIFICATION_TEST_PHONES: no phone.email round-trip

const TAKEN = 'That slot is no longer available';

/** A day 10–29 days out: the other booking specs use fixed days +2…+9, so they never share our slots. */
const someDay = () => openDay(10 + Math.floor(Math.random() * 20)); // clinics are closed on Sunday

async function serviceFor(api: APIRequestContext, clinicianIds: string[]) {
  const res = await api.post('/api/v1/catalog/services', {
    data: { name: uniq('Any'), duration_minutes: 50, price: 0, currency: 'INR' },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = (await res.json()).id as string;
  const put = await api.put(`/api/v1/catalog/services/${id}/clinicians`, { data: { clinician_ids: clinicianIds } });
  expect(put.status(), await put.text()).toBe(200);
  return id;
}

test.describe('public booking: any available clinician', () => {
  requireApi();
  requireAuth();

  const services: string[] = [];
  const sessions: string[] = [];
  const patients: string[] = [];
  test.afterEach(async ({ api }) => {
    for (const id of sessions.splice(0)) await api.post(`/api/v1/sessions/${id}/cancel`, { data: { reason: 'e2e cleanup' } });
    for (const id of patients.splice(0)) await api.delete(`/api/v1/patients/${id}`);
    for (const id of services.splice(0)) await api.delete(`/api/v1/catalog/services/${id}`);
  });

  async function slotsOf(anon: APIRequestContext, firmCode: string, params: Record<string, string>) {
    const res = await anon.get(`/api/v1/public/booking/${firmCode}/slots`, { params });
    expect(res.status(), await res.text()).toBe(200);
    return (await res.json()).slots as string[];
  }

  // The shared test phone already has patients, so every booking says it is for someone new.
  async function book(anon: APIRequestContext, firmCode: string, data: Record<string, unknown>) {
    const res = await anon.post(`/api/v1/public/booking/${firmCode}`, {
      data: { patient: { first_name: uniq('Any'), last_name: 'Patient', phone: TEST_PHONE }, new_patient: true, ...data },
    });
    if (res.status() === 200) {
      const conf = await res.json();
      sessions.push(conf.session_id);
      patients.push(conf.patient_id);
    }
    return res;
  }

  /** Book the first of `slots` still free; a parallel spec that took one first answers 409 TAKEN → try the next. */
  async function bookFirstFree(anon: APIRequestContext, firmCode: string, slots: string[], data: Record<string, unknown>) {
    for (const slot of slots) {
      const res = await book(anon, firmCode, { ...data, scheduled_at: slot });
      if (res.status() === 409 && (await res.json()).message === TAKEN) continue;
      expect(res.status(), await res.text()).toBe(200);
      return { slot, conf: await res.json() };
    }
    throw new Error('every candidate slot was taken by parallel specs');
  }

  test('"any" slots are the union of the assigned clinicians\' slots (also when practitioner_id is left out)', async ({ api, anon, auth }) => {
    const [jane, smith] = await demoClinicianIds();
    const serviceId = await serviceFor(api, [jane, smith]);
    services.push(serviceId);
    const date = someDay();

    const union = [...new Set([
      ...(await slotsOf(anon, auth.firmCode, { practitioner_id: jane, service_id: serviceId, date })),
      ...(await slotsOf(anon, auth.firmCode, { practitioner_id: smith, service_id: serviceId, date })),
    ])].sort();
    expect(union.length).toBeGreaterThan(0);
    expect(await slotsOf(anon, auth.firmCode, { practitioner_id: 'any', service_id: serviceId, date })).toEqual(union);
    expect(await slotsOf(anon, auth.firmCode, { service_id: serviceId, date })).toEqual(union);

    const bad = await anon.get(`/api/v1/public/booking/${auth.firmCode}/slots`, {
      params: { practitioner_id: 'anyone', service_id: serviceId, date },
    });
    expect(bad.status()).toBe(422);
  });

  test('an "any" booking goes to an assigned clinician; an unassigned clinician is never picked (409 instead)', async ({ api, anon, auth }) => {
    const [jane, smith] = await demoClinicianIds();
    const janeOnly = await serviceFor(api, [jane]);
    const smithOnly = await serviceFor(api, [smith]); // only to read Smith's free slots
    services.push(janeOnly, smithOnly);
    const date = someDay();
    const smithFree = new Set(await slotsOf(anon, auth.firmCode, { practitioner_id: smith, service_id: smithOnly, date }));
    const both = (await slotsOf(anon, auth.firmCode, { practitioner_id: 'any', service_id: janeOnly, date })).filter((s) => smithFree.has(s));
    expect(both.length, 'times both Jane and Smith are free').toBeGreaterThan(0);

    const { slot, conf } = await bookFirstFree(anon, auth.firmCode, both, { service_id: janeOnly, practitioner_id: 'any' });
    expect(conf).toEqual(expect.objectContaining({ practitioner_id: jane, practitioner_name: 'Jane Doe' }));

    // Jane is now busy; Smith is free at that time but does not offer the service
    const second = await book(anon, auth.firmCode, { service_id: janeOnly, practitioner_id: 'any', scheduled_at: slot });
    expect(second.status(), await second.text()).toBe(409);
    expect((await second.json()).message).toBe(TAKEN);
    expect(await slotsOf(anon, auth.firmCode, { practitioner_id: 'any', service_id: janeOnly, date })).not.toContain(slot);
  });

  test('"any" fills each assigned clinician once, then 409 when all are busy at that time', async ({ api, anon, auth }) => {
    const [jane, smith] = await demoClinicianIds();
    const serviceId = await serviceFor(api, [jane, smith]);
    services.push(serviceId);
    const date = someDay();
    const smithFree = new Set(await slotsOf(anon, auth.firmCode, { practitioner_id: smith, service_id: serviceId, date }));
    const both = (await slotsOf(anon, auth.firmCode, { practitioner_id: jane, service_id: serviceId, date })).filter((s) => smithFree.has(s));
    expect(both.length, 'times both Jane and Smith are free').toBeGreaterThan(0);

    const { slot, conf: first } = await bookFirstFree(anon, auth.firmCode, both, { service_id: serviceId, practitioner_id: 'any' });
    const second = await book(anon, auth.firmCode, { service_id: serviceId, scheduled_at: slot }); // left out = "any"
    expect(second.status(), await second.text()).toBe(200);
    const picked = [first.practitioner_id, (await second.json()).practitioner_id];
    expect(picked.sort()).toEqual([jane, smith].sort());

    const full = await book(anon, auth.firmCode, { service_id: serviceId, practitioner_id: 'any', scheduled_at: slot });
    expect(full.status(), await full.text()).toBe(409);
    expect((await full.json()).message).toBe(TAKEN);
    expect(await slotsOf(anon, auth.firmCode, { practitioner_id: 'any', service_id: serviceId, date })).not.toContain(slot);
  });
});
