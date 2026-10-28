import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { uniq } from '../src/env';

test.describe('/api/v1/onboarding (public)', () => {
  requireApi();

  test('GET /onboarding/metadata returns wizard metadata', async ({ anon }) => {
    const res = await anon.get('/api/v1/onboarding/metadata');
    expect(res.status()).toBe(200);
    expect(typeof (await res.json())).toBe('object');
  });

  test('POST /onboarding/validate rejects an empty payload', async ({ anon }) => {
    const res = await anon.post('/api/v1/onboarding/validate', { data: {} });
    expect([400, 422]).toContain(res.status());
  });

  test('POST /onboarding/complete rejects an empty payload', async ({ anon }) => {
    const res = await anon.post('/api/v1/onboarding/complete', { data: {} });
    expect([400, 422]).toContain(res.status());
  });
});

test.describe('/api/v1/otp', () => {
  requireApi();
  requireAuth();

  test('GET /otp/health responds', async ({ api }) => {
    expect((await api.get('/api/v1/otp/health')).status()).toBe(200);
  });

  test('validates generate/verify bodies (422)', async ({ api }) => {
    expect((await api.post('/api/v1/otp/generate', { data: { email: 'not-an-email', type: 'email' } })).status()).toBe(422);
    expect((await api.post('/api/v1/otp/verify', { data: { email: 'a@b.co', otp: '123', type: 'email' } })).status()).toBe(422); // otp must be 6 chars
  });

  test('verify with a wrong code is rejected', async ({ api }) => {
    const res = await api.post('/api/v1/otp/verify', { data: { email: `${uniq('otp')}@example.com`, otp: '000000', type: 'email' } });
    expect([400, 404, 422], await res.text()).toContain(res.status());
  });

  test('generate sends an email OTP', async ({ api }) => {
    test.fixme(true, 'otp.generate sends via SMTP (SMTP_USER/SMTP_PASSWORD) and fails without credentials; phone OTP is TODO');
    const res = await api.post('/api/v1/otp/generate', { data: { email: `${uniq('otp')}@example.com`, type: 'email' } });
    expect(res.status()).toBe(200);
    expect((await res.json()).message).toMatch(/OTP sent/);
  });
});
