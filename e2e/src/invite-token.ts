import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** The backend's .env (its SECRET_KEY signs invite links). Path as seen from e2e/, like E2E_EMAIL_OUTBOX. */
const BACKEND_ENV = process.env.E2E_BACKEND_ENV ?? '../backend/.env';

function secretKey(): string {
  const path = resolve(__dirname, '..', BACKEND_ENV);
  const line = readFileSync(path, 'utf8').split('\n').find((l) => l.startsWith('SECRET_KEY='));
  if (!line) throw new Error(`no SECRET_KEY in ${path}: set E2E_BACKEND_ENV to the backend's .env`);
  return line.slice('SECRET_KEY='.length).split('#')[0].trim();
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64url');

/** A staff set-password token like app/utils/auth.create_staff_invite_token, expiring `expiresInSeconds`
 *  from now (negative = already expired). HS256, the backend's JWT_ALGORITHM. */
export function staffInviteToken(userId: string, tenantId: string, expiresInSeconds: number): string {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(
    JSON.stringify({ user_id: userId, tenant_id: tenantId, purpose: 'staff_invite', exp: now + expiresInSeconds, iat: now - 3600 }),
  );
  const sig = createHmac('sha256', secretKey()).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}
