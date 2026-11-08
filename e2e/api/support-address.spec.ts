import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { uniq } from '../src/env';

// The brand is PsyClinicalMind; the support mailbox is support@psyclinicalmind.com.
// clinicalmind.app is not ours and must not appear anywhere a client can read it.
test.describe('support address', () => {
  requireApi();

  test('error bodies point at support@psyclinicalmind.com', async ({ anon }) => {
    // unknown email: main.py's HTTPException handler answers the 401 with its error envelope
    const res = await anon.post('/api/v1/auth/login', {
      data: { email: `${uniq('nobody')}@example.com`, password: 'whatever123' },
    });
    expect(res.status()).toBe(401);
    const text = await res.text();
    expect(JSON.parse(text).support).toBe('contact support@psyclinicalmind.com if this persists');
    expect(text).not.toContain('clinicalmind.app');
  });

  test('OpenAPI contact, terms and license use psyclinicalmind.com', async ({ anon }) => {
    const res = await anon.get('/openapi.json');
    expect(res.status()).toBe(200);
    const text = await res.text();
    const info = JSON.parse(text).info;
    expect(info.termsOfService).toBe('https://psyclinicalmind.com/terms');
    expect(info.contact).toEqual({
      name: 'PsyClinicalMind Support',
      url: 'https://psyclinicalmind.com/support',
      email: 'support@psyclinicalmind.com',
    });
    expect(info.license).toEqual({ name: 'Commercial License', url: 'https://psyclinicalmind.com/license' });
    expect(text).not.toContain('clinicalmind.app');
  });

  // GET / is a plain identity answer: no marketing copy, no feature claims, no old brand, nothing else.
  test('GET / (signed in) is exactly name, status and support; without a token it is 401', async ({ api, anon }) => {
    requireAuth();
    const res = await api.get('/');
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({
      name: 'PsyClinicalMind API',
      status: 'ok',
      support: 'support@psyclinicalmind.com',
    });
    expect((await anon.get('/')).status()).toBe(401);
  });
});
