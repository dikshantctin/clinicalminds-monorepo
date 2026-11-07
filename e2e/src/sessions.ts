import { APIRequestContext, APIResponse } from '@playwright/test';

export const CLASH = 'The clinician already has a session at that time';

/**
 * POST /api/v1/sessions/ for a spec that needs "a session around this time", not an exact one. Staff
 * booking refuses a clinician's overlapping sessions (409), and parallel specs book the same demo clinician,
 * so on that clash the time moves on by an hour and the booking is tried again. Any other answer is returned.
 */
export async function bookSession(ctx: APIRequestContext, data: { scheduled_at: string } & Record<string, unknown>): Promise<APIResponse> {
  let at = new Date(data.scheduled_at).getTime();
  for (let tries = 0; tries < 48; tries++) {
    const res = await ctx.post('/api/v1/sessions/', { data: { ...data, scheduled_at: new Date(at).toISOString() } });
    if (res.status() !== 409 || (await res.json()).message !== CLASH) return res;
    at += 3_600_000;
  }
  throw new Error('the demo clinician has no free hour in the next two days');
}

/** A clinic-time (IST) date 60–1000 days ahead, so a spec that books exact clock times has the day to itself. */
export function uniqueDay(): string {
  const d = new Date(Date.now() + (60 + Math.floor(Math.random() * 940)) * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
}

/** Move a session's start into the past (an update, unlike a create, accepts a past time), so it can be
 * completed or marked no-show straight from "scheduled": both refuse a session that has not started (409). */
export async function backdate(ctx: APIRequestContext, sessionId: string, minutesAgo = 10): Promise<void> {
  const res = await ctx.put(`/api/v1/sessions/${sessionId}`, { data: { scheduled_at: new Date(Date.now() - minutesAgo * 60_000).toISOString() } });
  if (res.status() !== 200) throw new Error(`backdate ${sessionId}: ${res.status()}`);
}
