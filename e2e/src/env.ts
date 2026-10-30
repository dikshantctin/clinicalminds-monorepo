export const env = {
  API_URL: process.env.API_URL ?? 'http://localhost:8000',
  WEB_URL: process.env.WEB_URL ?? 'http://localhost:3000',
  DEID_URL: process.env.DEID_URL ?? 'http://localhost:8002',
  EMAIL: process.env.E2E_EMAIL ?? 'demo@clinicalmind.com',
  PASSWORD: process.env.E2E_PASSWORD ?? 'password123',
};

/** True when the URL answers with anything below 500 within the timeout. */
export async function reachable(url: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.status < 500;
  } catch {
    return false;
  }
}

/** Unique suffix so parallel runs never collide on names/emails. */
export const uniq = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export const RANDOM_UUID = '00000000-0000-4000-8000-000000000000';

/** Seeded by backend/scripts/setup_demo_data.py and NOT on the VERIFICATION_TEST_* allowlists:
 *  logs in, but every clinical route answers 403 verification_required until phone.email verification. */
export const UNVERIFIED_USER = { email: 'intern.unverified@example.com', password: 'Password123!' };

/** Razorpay TEST-mode key pair for the demo clinic (e2e/.env). Payment specs skip when unset. */
export const RAZORPAY = {
  keyId: process.env.E2E_RAZORPAY_KEY_ID ?? '',
  keySecret: process.env.E2E_RAZORPAY_KEY_SECRET ?? '',
};

/** Demo team members seeded by backend/scripts/setup_demo_data.py (allow-listed for verification). */
export const DEMO_THERAPIST = { email: 'therapist.jane@democlinic.com', password: 'Password123!' };
export const DEMO_PSYCHOLOGIST = { email: 'dr.smith@democlinic.com', password: 'Password123!' };
/** Dev/test email outbox: the backend writes each email here as JSON instead of sending it when its
 *  EMAIL_OUTBOX_DIR is set (backend/.env; refused in production). Path as seen from e2e/. */
export const EMAIL_OUTBOX = process.env.E2E_EMAIL_OUTBOX ?? '../backend/.email-outbox';

/** A portal PATIENT login in the demo clinic, seeded by backend/scripts/setup_demo_data.py. */
export const DEMO_PATIENT = { email: 'patient.demo@democlinic.com', password: 'Password123!' };
