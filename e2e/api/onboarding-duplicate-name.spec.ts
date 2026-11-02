import { test, expect, requireApi } from '../src/fixtures';
import { uniq } from '../src/env';
import { E2E_CLINIC, deleteClinic } from '../src/clinics';

const ALLOW_LISTED_PHONE = '+919876543211'; // VERIFICATION_TEST_PHONES: onboarding skips phone.email

const onboarding = (name: string, slug: string) => ({
  organization: {
    name, type: 'clinic', contact_email: `${slug}@example.com`, contact_phone: ALLOW_LISTED_PHONE,
    address_line1: '1 Road', city: 'Pune', state: 'MH', postal_code: '411001',
  },
  plan: { plan_type: 'basic', max_users: 5, max_patients: 100, max_sessions_per_month: 500 },
  admin: { email: `admin.${slug}@example.com`, password: 'Password123!', first_name: 'New', last_name: 'Admin', phone: ALLOW_LISTED_PHONE },
  admin_role: 'ADMIN',
  team_members: [],
});

test.describe('onboarding two clinics with the same name', () => {
  requireApi();
  const created: string[] = [];
  test.afterAll(async () => {
    for (const email of created.splice(0)) await deleteClinic(email); // afterAll runs per test (fullyParallel)
  });

  test('both are created as separate tenants', async ({ anon }) => {
    const name = `${E2E_CLINIC} Same Name ${uniq('clinic')}`;
    const [slugA, slugB] = [uniq('a').toLowerCase(), uniq('b').toLowerCase()];
    const first = await anon.post('/api/v1/onboarding/complete', { data: onboarding(name, slugA) });
    expect(first.status(), await first.text()).toBe(200);
    created.push(`admin.${slugA}@example.com`);
    const second = await anon.post('/api/v1/onboarding/complete', { data: onboarding(name, slugB) });
    expect(second.status(), await second.text()).toBe(200);
    created.push(`admin.${slugB}@example.com`);
    const [a, b] = [(await first.json()).tenant_id, (await second.json()).tenant_id];
    expect(a).not.toBe(b);
    expect((await second.json()).organization_name).toBe(name);
  });

  test('the same admin email is still refused (400)', async ({ anon }) => {
    const slug = uniq('dup').toLowerCase();
    expect((await anon.post('/api/v1/onboarding/complete', { data: onboarding(`${E2E_CLINIC} ${slug}`, slug) })).status()).toBe(200);
    created.push(`admin.${slug}@example.com`);
    const again = await anon.post('/api/v1/onboarding/complete', { data: onboarding(`${E2E_CLINIC} ${slug}`, slug) });
    expect(again.status()).toBe(400);
    expect((await again.json()).message.errors.join(' ')).toMatch(/already exists/);
  });
});
