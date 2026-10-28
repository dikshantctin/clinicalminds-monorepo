import { request as pwRequest, APIRequestContext } from '@playwright/test';
import { test, expect, requireDeid } from '../src/fixtures';
import { env } from '../src/env';

/** Black-box tests for deidentification-service (FastAPI on DEID_URL, default :8002). */
test.describe('@deid de-identification service', () => {
  requireDeid();

  let deid: APIRequestContext;
  test.beforeAll(async () => {
    deid = await pwRequest.newContext({ baseURL: env.DEID_URL });
  });
  test.afterAll(async () => {
    await deid.dispose();
  });

  test('GET /api/health', async () => {
    const res = await deid.get('/api/health');
    expect(res.status()).toBe(200);
  });

  test('GET / lists the endpoints', async () => {
    const res = await deid.get('/');
    expect(res.status()).toBe(200);
    expect((await res.json()).endpoints).toEqual(expect.objectContaining({ text: '/api/deidentify/text' }));
  });

  test('GET /api/identifiers lists supported identifier categories', async () => {
    const res = await deid.get('/api/identifiers');
    expect(res.status()).toBe(200);
  });

  test('POST /api/deidentify/text removes names, phone, email and MRN', async () => {
    test.slow(); // first call may load NLP models
    const text = [
      'Patient: John Smith',
      'DOB: 03/15/1985',
      'Phone: (555) 123-4567',
      'Email: john.smith@email.com',
      'MRN: MR123456',
      'Clinical notes from visit on 12/15/2023. Patient reports persistent low mood.',
    ].join('\n');

    const res = await deid.post('/api/deidentify/text', { data: { text, use_nlp: true, confidence_threshold: 0.85 } });
    expect(res.status(), await res.text()).toBe(200);
    const body = await res.json();

    expect(body.original_text).toBe(text);
    expect(body.deidentified_text).not.toContain('john.smith@email.com');
    expect(body.deidentified_text).not.toContain('(555) 123-4567');
    expect(body.deidentified_text).not.toContain('MR123456');
    expect(body.deidentified_text).not.toContain('John Smith');
    expect(body.deidentified_text).toContain('low mood'); // clinical content survives
    expect(Array.isArray(body.entities_removed)).toBe(true);
    expect(body.entities_removed.length).toBeGreaterThan(0);
    expect(body.processing_time).toBeGreaterThanOrEqual(0);
  });

  test('POST /api/deidentify/text validates the body', async () => {
    expect((await deid.post('/api/deidentify/text', { data: {} })).status()).toBe(422);
  });
});
