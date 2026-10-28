import { test, expect, requireApi } from '../src/fixtures';

test.describe('GET /health', () => {
  requireApi();

  test('is public and reports service status', async ({ anon }) => {
    const res = await anon.get('/health');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('healthy');
    expect(body.platform).toContain('ClinicalMind');
    expect(body.services).toEqual(
      expect.objectContaining({
        database: expect.any(String),
        ai_router: expect.stringMatching(/^(active|inactive)$/),
        crisis_detector: expect.stringMatching(/^(active|inactive)$/),
      }),
    );
  });
});
