import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { uniq } from '../src/env';
import { lastEmailTo } from '../src/outbox';
import { portalAccount, loginStatus } from '../src/portal-account';

/**
 * Forgot password: POST /auth/request-password-reset always answers the same (no account enumeration) and
 * emails a link only to an existing account that has a password; POST /auth/reset-password sets the new
 * password once — the link stops working as soon as the password changes. Both used to be stubs.
 */
const SAME_ANSWER = 'If the email exists, a password reset link has been sent.';
const OLD = 'Password123!';
const NEW = 'Changed456!';
const resetToken = (email: string) => {
  const mail = lastEmailTo(email);
  expect(mail.subject).toBe('Reset your ClinicalMinds password');
  const m = mail.html.match(/\/auth\/reset-password\?token=([\w.-]+)/);
  expect(m, 'the reset email carries a /auth/reset-password link').not.toBeNull();
  return m![1];
};
const noEmailTo = (email: string) => expect(() => lastEmailTo(email)).toThrow(/no email to/);

test.describe('password reset', () => {
  requireApi();
  requireAuth();

  test('request → emailed link → new password works, the old one does not, the link is single-use', async ({ anon, api }) => {
    const acct = await portalAccount(api, OLD);
    try {
      const req = await anon.post('/api/v1/auth/request-password-reset', { data: { email: acct.email.toUpperCase() } });
      expect(req.status()).toBe(200);
      expect((await req.json()).message).toBe(SAME_ANSWER);
      const token = resetToken(acct.email);

      const reset = await anon.post('/api/v1/auth/reset-password', { data: { token, new_password: NEW } });
      expect(reset.status(), await reset.text()).toBe(200);
      expect(await loginStatus(acct.email, NEW)).toBe(200);
      expect(await loginStatus(acct.email, OLD)).toBe(401);

      const again = await anon.post('/api/v1/auth/reset-password', { data: { token, new_password: 'Another789!' } });
      expect(again.status()).toBe(400);
      expect((await again.json()).message).toBe('Invalid or expired reset token');
      expect(await loginStatus(acct.email, NEW)).toBe(200);
    } finally {
      await acct.cleanup();
    }
  });

  test('an unknown email gets the same answer and no email', async ({ anon }) => {
    const email = `${uniq('nobody')}@example.com`.toLowerCase();
    const res = await anon.post('/api/v1/auth/request-password-reset', { data: { email } });
    expect(res.status()).toBe(200);
    expect((await res.json()).message).toBe(SAME_ANSWER);
    noEmailTo(email);
  });

  test('an invited account that never set a password gets no reset email (it uses its invite link)', async ({ anon, api }) => {
    const acct = await portalAccount(api, OLD, { setPassword: false });
    try {
      const res = await anon.post('/api/v1/auth/request-password-reset', { data: { email: acct.email } });
      expect(res.status()).toBe(200);
      expect((await res.json()).message).toBe(SAME_ANSWER);
      expect(lastEmailTo(acct.email).subject).not.toBe('Reset your ClinicalMinds password'); // still only the invite
    } finally {
      await acct.cleanup();
    }
  });

  test('a forged token → 400; a short password → 422; a malformed email → 422', async ({ anon }) => {
    const bad = await anon.post('/api/v1/auth/reset-password', { data: { token: 'not.a.token', new_password: NEW } });
    expect(bad.status()).toBe(400);
    expect((await bad.json()).message).toBe('Invalid or expired reset token');
    expect((await anon.post('/api/v1/auth/reset-password', { data: { token: 'x', new_password: 'short' } })).status()).toBe(422);
    expect((await anon.post('/api/v1/auth/request-password-reset', { data: { email: 'not-an-email' } })).status()).toBe(422);
  });
});
