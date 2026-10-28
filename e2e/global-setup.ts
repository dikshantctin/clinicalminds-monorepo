/**
 * Runs once before any worker starts.
 *  1. Probes the backend, frontend and de-id service and records the result in process.env
 *     (E2E_API_UP / E2E_WEB_UP / E2E_DEID_UP) so specs can skip with a reason instead of failing.
 *  2. Logs in through the API and writes a Playwright storage state that seeds the same
 *     localStorage keys the frontend's AuthContext uses (auth_token, auth_user, tenant_id).
 *     E2E_AUTH_OK=1 when that succeeded; the token/tenant are exported for the API fixtures.
 */
import { request } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { env, reachable } from './src/env';

const STATE_DIR = path.join(__dirname, '.auth');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

export default async function globalSetup(): Promise<void> {
  const [apiUp, webUp, deidUp] = await Promise.all([
    reachable(`${env.API_URL}/health`),
    reachable(env.WEB_URL),
    reachable(`${env.DEID_URL}/api/health`),
  ]);
  process.env.E2E_API_UP = apiUp ? '1' : '0';
  process.env.E2E_WEB_UP = webUp ? '1' : '0';
  process.env.E2E_DEID_UP = deidUp ? '1' : '0';
  process.env.E2E_AUTH_OK = '0';

  const origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }> = [];

  if (apiUp) {
    const ctx = await request.newContext({ baseURL: env.API_URL });
    try {
      const res = await ctx.post('/api/v1/auth/login', {
        data: { email: env.EMAIL, password: env.PASSWORD },
      });
      if (res.ok()) {
        const body = await res.json();
        const tenantId: string = body.tenant?.id ?? '';
        const user = { ...body.user, tenant_id: tenantId };
        process.env.E2E_TOKEN = body.access_token;
        process.env.E2E_TENANT_ID = tenantId;
        process.env.E2E_USER = JSON.stringify(user);
        process.env.E2E_AUTH_OK = '1';
        origins.push({
          origin: env.WEB_URL,
          localStorage: [
            { name: 'auth_token', value: body.access_token },
            { name: 'auth_user', value: JSON.stringify(user) },
            { name: 'tenant_id', value: tenantId },
          ],
        });
      } else {
        console.warn(`[e2e] login as ${env.EMAIL} failed: ${res.status()} ${await res.text()}`);
      }
    } finally {
      await ctx.dispose();
    }
  }

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({ cookies: [], origins }, null, 2));

  console.log(
    `[e2e] api=${apiUp ? 'up' : 'DOWN'} (${env.API_URL})  web=${webUp ? 'up' : 'DOWN'} (${env.WEB_URL})  ` +
      `deid=${deidUp ? 'up' : 'DOWN'} (${env.DEID_URL})  auth=${process.env.E2E_AUTH_OK === '1' ? 'ok' : 'none'}`,
  );
}
