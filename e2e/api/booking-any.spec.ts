import { APIRequestContext } from '@playwright/test';
import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { uniq } from '../src/env';
import { demoClinicianIds } from '../src/catalog';

/**
 * "Any available" clinician (practitioner_id = "any", or left out): the slots are the union of the free
 * slots of the clinicians assigned to the service; a booking goes to the first assigned clinician free at
 * that time; when none is free → 409. A clinician not assigned to the service is never chosen.
 */

const TEST_PHONE = '+919876543210'; // VERIFICATION_TEST_PHONES: no phone.email round-trip

/** A day 3–30 days out, so parallel specs (which use day +2) rarely share our slots. */
const someDay = () => {
  const d = new Date();
  d.setDate(d.getDate() + 3 + Math.floor(Math.random() * 28));
  return d.toISOString().slice(0, 10);
};

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
  test.afterEach(async ({ api }) => {
    for (const id of sessions.splice(0)) await api.post(`/api/v1/sessions/${id}/cancel`, { data: { reason: 'e2e cleanup' } });
    for (const id of services.splice(0)) await api.delete(`/api/v1/catalog/services/${id}`);
  });

  async function slotsOf(anon: APIRequestContext, firmCode: string, params: Record<string, string>) {
    const res = await anon.get(`/api/v1/public/booking/${firmCode}/slots`, { params });
    expect(res.status(), await res.text()).toBe(200);
    return (await res.json()).slots as string[];
  }

  function book(anon: APIRequestContext, firmCode: string, data: Record<string, unknown>) {
    return anon.post(`/api/v1/public/booking/${firmCode}`, {
      data: { patient: { first_name: uniq('Any'), last_name: 'Patient', phone: TEST_PHONE }, ...data },
    });
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
    const slot = (await slotsOf(anon, auth.firmCode, { practitioner_id: 'any', service_id: janeOnly, date })).find((s) => smithFree.has(s));
    expect(slot, 'a time both Jane and Smith are free').toBeTruthy();

    const first = await book(anon, auth.firmCode, { service_id: janeOnly, practitioner_id: 'any', scheduled_at: slot });
    expect(first.status(), await first.text()).toBe(200);
    const conf = await first.json();
    sessions.push(conf.session_id);
    expect(conf).toEqual(expect.objectContaining({ practitioner_id: jane, practitioner_name: 'Jane Doe' }));

    // Jane is now busy; Smith is free at that time but does not offer the service
    const second = await book(anon, auth.firmCode, { service_id: janeOnly, practitioner_id: 'any', scheduled_at: slot });
    expect(second.status(), await second.text()).toBe(409);
    expect(await slotsOf(anon, auth.firmCode, { practitioner_id: 'any', service_id: janeOnly, date })).not.toContain(slot);
  });

  test('"any" fills each assigned clinician once, then 409 when all are busy at that time', async ({ api, anon, auth }) => {
    const [jane, smith] = await demoClinicianIds();
    const serviceId = await serviceFor(api, [jane, smith]);
    services.push(serviceId);
    const date = someDay();
    const smithFree = new Set(await slotsOf(anon, auth.firmCode, { practitioner_id: smith, service_id: serviceId, date }));
    const slot = (await slotsOf(anon, auth.firmCode, { practitioner_id: jane, service_id: serviceId, date })).find((s) => smithFree.has(s));
    expect(slot, 'a time both Jane and Smith are free').toBeTruthy();

    const picked: string[] = [];
    for (const data of [{ practitioner_id: 'any' }, {}]) { // "any" and left out mean the same
      const res = await book(anon, auth.firmCode, { service_id: serviceId, scheduled_at: slot, ...data });
      expect(res.status(), await res.text()).toBe(200);
      const conf = await res.json();
      sessions.push(conf.session_id);
      picked.push(conf.practitioner_id);
    }
    expect(picked.sort()).toEqual([jane, smith].sort());

    const full = await book(anon, auth.firmCode, { service_id: serviceId, practitioner_id: 'any', scheduled_at: slot });
    expect(full.status(), await full.text()).toBe(409);
    expect(await slotsOf(anon, auth.firmCode, { practitioner_id: 'any', service_id: serviceId, date })).not.toContain(slot);
  });
});
