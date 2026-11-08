import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { deleteClinic, onboardOwnClinic, type OwnClinic } from '../src/clinics';

/**
 * A clinic's logo: POST /tenants/{id}/branding/logo stores it, GET returns the same bytes and type.
 * GET used to answer 500 whenever a logo existed (FileResponse was handed bytes instead of a path).
 * The logo is served under a sandboxing CSP with nosniff, so an SVG logo can never run script on the API origin.
 */
// a 1x1 transparent PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><script>alert(1)</script></svg>');

test.describe('clinic logo upload and download', () => {
  requireApi();
  requireAuth();
  test.describe.configure({ mode: 'serial' });

  let clinic: OwnClinic;
  let other: OwnClinic;
  const logo = () => `/api/v1/tenants/${clinic.tenantId}/branding/logo`;
  const upload = (name: string, mimeType: string, buffer: Buffer) =>
    clinic.api.post(logo(), { multipart: { file: { name, mimeType, buffer } } });

  test.beforeAll(async () => {
    clinic = await onboardOwnClinic('logo');
    other = await onboardOwnClinic('logox');
  });

  test.afterAll(async () => {
    await deleteClinic(clinic.adminEmail);
    await deleteClinic(other.adminEmail);
  });

  test('before any upload: 404 No logo found', async () => {
    const res = await clinic.api.get(logo());
    expect(res.status()).toBe(404);
    expect((await res.json()).message).toBe('No logo found');
  });

  test('an uploaded PNG comes back byte for byte, as image/png, sandboxed', async () => {
    const up = await upload('logo.png', 'image/png', PNG);
    expect(up.status(), await up.text()).toBe(200);
    expect(await up.json()).toEqual({ message: 'Logo uploaded successfully' });

    const res = await clinic.api.get(logo());
    expect(res.status(), res.status() === 200 ? '' : await res.text()).toBe(200);
    expect(res.headers()['content-type']).toBe('image/png');
    expect(res.headers()['x-content-type-options']).toBe('nosniff');
    expect(res.headers()['content-security-policy']).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox");
    expect(Buffer.compare(await res.body(), PNG)).toBe(0);
  });

  test('an SVG logo is served under the same sandbox (its script cannot run)', async () => {
    expect((await upload('logo.svg', 'image/svg+xml', SVG)).status()).toBe(200);
    const res = await clinic.api.get(logo());
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toBe('image/svg+xml');
    expect(res.headers()['content-security-policy']).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox");
    expect(Buffer.compare(await res.body(), SVG)).toBe(0);
  });

  test('a non-image upload: 400', async () => {
    const res = await upload('notes.txt', 'text/plain', Buffer.from('hello'));
    expect(res.status()).toBe(400);
    expect((await res.json()).message).toBe('File must be an image');
  });

  test("another clinic's admin: 403; no token: 401", async ({ anon }) => {
    const foreign = await other.api.get(logo());
    expect(foreign.status()).toBe(403);
    expect((await foreign.json()).message).toBe('Not a member of this tenant');
    expect((await anon.get(logo())).status()).toBe(401);
  });
});
