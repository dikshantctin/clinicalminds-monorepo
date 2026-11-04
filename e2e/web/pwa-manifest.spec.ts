import { test, expect, requireWeb } from '../src/fixtures';

/** PWA-1: the web app manifest and icons the phone uses for "Add to Home Screen". No login needed. */
test.describe('installable app: manifest and icons', () => {
  requireWeb();

  test('the manifest names PsyClinicalMind, starts at "/" and opens full-screen', async ({ request }) => {
    const res = await request.get('/manifest.webmanifest');
    expect(res.status()).toBe(200);
    const m = await res.json();
    expect(m.name).toBe('PsyClinicalMind');
    expect(m.short_name).toBe('PsyClinicalMind');
    expect(m.description).toBe(
      'Practice management for mental health clinics: online booking and payments, sessions, and a clinical follow-up queue.',
    );
    expect(m.start_url).toBe('/');
    expect(m.scope).toBe('/');
    expect(m.display).toBe('standalone');
    expect(m.orientation).toBe('portrait');
    expect(m.theme_color).toBe('#2563eb');
    expect(m.background_color).toBe('#ffffff');
  });

  test('the manifest lists 192, 512 and a maskable 512 icon, each served as a PNG', async ({ request }) => {
    const m = await (await request.get('/manifest.webmanifest')).json();
    const icons: { src: string; sizes: string; purpose?: string }[] = m.icons;
    expect(icons.map((i) => `${i.sizes} ${i.purpose ?? 'any'}`).sort()).toEqual(
      ['192x192 any', '512x512 any', '512x512 maskable'],
    );
    for (const icon of icons) {
      const res = await request.get(icon.src);
      expect(res.status(), icon.src).toBe(200);
      expect(res.headers()['content-type'], icon.src).toBe('image/png');
    }
  });

  test('every icon and manifest link in index.html resolves', async ({ request }) => {
    const html = await (await request.get('/')).text();
    const hrefs = [...html.matchAll(/<link[^>]+rel="(?:icon|apple-touch-icon|manifest)"[^>]*>/g)].map(
      (tag) => /href="([^"]+)"/.exec(tag[0])![1],
    );
    expect(hrefs.length).toBeGreaterThanOrEqual(3);
    for (const href of hrefs) {
      const res = await request.get(href);
      expect(res.status(), href).toBe(200);
      expect(res.headers()['content-type'], href).not.toContain('text/html'); // not the SPA fallback
    }
  });

  test('the manifest does not advertise removed features', async ({ request }) => {
    const m = await (await request.get('/manifest.webmanifest')).json();
    expect(`${m.name} ${m.description}`).not.toMatch(/\bAI\b|crisis/i);
  });

  test('the old /site.webmanifest is gone', async ({ request }) => {
    const res = await request.get('/site.webmanifest');
    expect(res.headers()['content-type'] ?? '').not.toContain('json');
  });
});
