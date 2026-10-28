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
