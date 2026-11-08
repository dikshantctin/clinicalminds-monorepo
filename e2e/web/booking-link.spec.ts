import { readFileSync } from 'fs';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { test, expect, requireWeb, requireAuth } from '../src/fixtures';
import { OwnClinic, deleteClinic, onboardOwnClinic } from '../src/clinics';
import { LoginPage } from '../src/pages/login.page';
import { portalAccount } from '../src/portal-account';

/** The text a QR code in a PNG file holds. */
const decodeQr = (png: Buffer): string | undefined => {
  const img = PNG.sync.read(png);
  return jsQR(new Uint8ClampedArray(img.data), img.width, img.height)?.data;
};

/** Settings → Booking link: staff share the clinic's /book/<code> page (copy, QR to print, WhatsApp), so patients
 * never have to know or type the clinic code. A fresh clinic, so the code is known. */
test.describe('Settings → Booking link', () => {
  requireWeb();
  requireAuth();
  test.use({ storageState: { cookies: [], origins: [] } });
  test.describe.configure({ mode: 'serial' });

  let clinic: OwnClinic;
  test.beforeAll(async () => {
    clinic = await onboardOwnClinic('booklink', ['SUPPORT_STAFF', 'THERAPIST']);
  });
  test.afterAll(async () => {
    for (const m of clinic?.members ?? []) await m.api.dispose();
    await clinic?.api.dispose();
    if (clinic) await deleteClinic(clinic.adminEmail);
  });

  test('the front desk copies the link, downloads a QR that opens it, and gets a WhatsApp share', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const login = new LoginPage(page);
    await login.goto();
    await login.login(clinic.members[0].email, 'Password123!');
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.goto('/dashboard/settings');
    await page.getByRole('tab', { name: 'Booking link' }).click();

    const link = `${new URL(page.url()).origin}/book/${clinic.firmCode}`;
    await expect(page.getByTestId('booking-link-url')).toHaveValue(link);
    await expect(page.getByTestId('booking-link-open')).toHaveAttribute('href', `/book/${clinic.firmCode}`);

    await page.getByTestId('booking-link-copy').click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);

    const src = await page.getByTestId('booking-link-qr').getAttribute('src');
    expect(src?.startsWith('data:image/png;base64,')).toBe(true);
    expect(decodeQr(Buffer.from(src!.split(',')[1], 'base64'))).toBe(link);

    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('booking-link-download').click()]);
    expect(download.suggestedFilename()).toBe('booking-qr.png');
    expect(decodeQr(readFileSync(await download.path()))).toBe(link);

    await expect(page.getByTestId('booking-link-whatsapp')).toHaveAttribute(
      'href',
      `https://wa.me/?text=${encodeURIComponent(`Book your appointment online: ${link}`)}`,
    );
  });

  test('a clinician sees the same link', async ({ page }) => {
    const login = new LoginPage(page);
    await login.goto();
    await login.login(clinic.members[1].email, 'Password123!');
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.goto('/dashboard/settings');
    await page.getByRole('tab', { name: 'Booking link' }).click();
    await expect(page.getByTestId('booking-link-url')).toHaveValue(`${new URL(page.url()).origin}/book/${clinic.firmCode}`);
  });

  test('a patient never reaches it: /dashboard/settings sends them to the portal', async ({ page }) => {
    const patient = await portalAccount(clinic.api, 'Password123!');
    try {
      const login = new LoginPage(page, '/portal/login');
      await login.goto();
      await login.login(patient.email, 'Password123!');
      await expect(page).toHaveURL(/\/portal$/);
      await page.goto('/dashboard/settings');
      await expect(page).toHaveURL(/\/portal$/);
      await expect(page.getByRole('tab', { name: 'Booking link' })).toHaveCount(0);
      await expect(page.getByTestId('booking-link-url')).toHaveCount(0);
    } finally {
      await patient.cleanup();
    }
  });
});
