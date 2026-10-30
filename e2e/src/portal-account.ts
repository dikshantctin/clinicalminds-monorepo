import { request as pwRequest, APIRequestContext, expect } from '@playwright/test';
import { env, uniq } from './env';
import { inviteTokenFor } from './outbox';

/** A throwaway portal account (invited patient with a password), so specs never change the demo users' passwords. */
export async function portalAccount(api: APIRequestContext, password: string, opts: { setPassword?: boolean } = {}) {
  const created = await api.post('/api/v1/patients/', { data: { first_name: uniq('Reset'), last_name: 'Patient' } });
  expect(created.status(), await created.text()).toBe(200);
  const patientId: string = (await created.json()).id;
  const email = `${uniq('reset')}@example.com`.toLowerCase();
  const inv = await api.post(`/api/v1/patients/${patientId}/invite`, { data: { email, first_name: 'Reset', last_name: 'Patient' } });
  expect(inv.status(), await inv.text()).toBe(200);
  if (opts.setPassword !== false) {
    const set = await api.post('/api/v1/patients/set-password', { data: { token: inviteTokenFor(email), password } });
    expect(set.status(), await set.text()).toBe(200);
  }
  return { email, patientId, cleanup: () => api.delete(`/api/v1/patients/${patientId}`) };
}

export async function loginStatus(email: string, password: string): Promise<number> {
  const anon = await pwRequest.newContext({ baseURL: env.API_URL });
  const res = await anon.post('/api/v1/auth/login', { data: { email, password, audience: 'patient' } });
  await anon.dispose();
  return res.status();
}
