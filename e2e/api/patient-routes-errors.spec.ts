import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { deleteClinic, onboardOwnClinic, type OwnClinic } from '../src/clinics';

/**
 * GET /patients/{id}/sessions answers a refused or missing patient with the service's own 403/404 and message.
 * It used to turn them into 500 "Failed to retrieve patient sessions" (a broad `except Exception` without
 * `except HTTPException: raise`).
 */
const RANDOM_UUID = '00000000-0000-4000-8000-000000000000';

test.describe('patient sessions keep the status of a refusal', () => {
  requireApi();
  requireAuth();
  test.describe.configure({ mode: 'serial' });

  let clinic: OwnClinic; // CLINICAL_DIRECTOR admin, one THERAPIST
  let other: OwnClinic;
  let patientId: string; // assigned to nobody

  test.beforeAll(async () => {
    clinic = await onboardOwnClinic('perr', ['THERAPIST']);
    other = await onboardOwnClinic('perrx');
    const created = await clinic.api.post('/api/v1/patients/', { data: { first_name: 'Route', last_name: 'Errors' } });
    expect(created.status(), await created.text()).toBe(200);
    patientId = (await created.json()).id;
  });

  test.afterAll(async () => {
    await deleteClinic(clinic.adminEmail);
    await deleteClinic(other.adminEmail);
  });

  test("the clinic's own patient: 200", async () => {
    const res = await clinic.api.get(`/api/v1/patients/${patientId}/sessions`);
    expect(res.status(), await res.text()).toBe(200);
    expect(await res.json()).toEqual({ sessions: [], total: 0 });
  });

  test('an unknown, malformed or other-clinic patient: 404 Patient not found', async () => {
    for (const [ctx, id] of [
      [clinic.api, RANDOM_UUID],
      [clinic.api, 'not-a-uuid'],
      [other.api, patientId],
    ] as const) {
      const res = await ctx.get(`/api/v1/patients/${id}/sessions`);
      expect(res.status(), `${id}: ${await res.text()}`).toBe(404);
      expect((await res.json()).message).toBe('Patient not found');
    }
  });

  test('a clinician opening a patient not assigned to them: 403, not 500', async () => {
    const res = await clinic.members[0].api.get(`/api/v1/patients/${patientId}/sessions`);
    expect(res.status(), await res.text()).toBe(403);
    expect((await res.json()).message).toBe('Access denied to this patient record');
  });

  test('no token: 401', async ({ anon }) => {
    expect((await anon.get(`/api/v1/patients/${patientId}/sessions`)).status()).toBe(401);
  });
});
