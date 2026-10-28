import { test, expect, requireApi, requireAuth } from '../src/fixtures';
import { uniq } from '../src/env';

test.describe('/api/v1/teams', () => {
  requireApi();
  requireAuth();

  test('validates the create body (422 for missing name / bad colour / bad type)', async ({ api }) => {
    expect((await api.post('/api/v1/teams/teams', { data: {} })).status()).toBe(422);
    expect((await api.post('/api/v1/teams/teams', { data: { name: 'x', color: 'blue' } })).status()).toBe(422);
    expect((await api.post('/api/v1/teams/teams', { data: { name: 'x', team_type: 'clinical' } })).status()).toBe(422); // enum is upper-case
  });

  test('create → read → list → my-teams → add member → update → delete', async ({ api, auth }) => {
    const created = await api.post('/api/v1/teams/teams', {
      data: { name: uniq('Team'), description: 'e2e', team_type: 'CLINICAL', color: '#3B82F6', max_members: 10 },
    });
    expect(created.status(), await created.text()).toBe(200);
    const team = await created.json();
    expect(team).toEqual(expect.objectContaining({ id: expect.any(String), team_type: 'CLINICAL', is_active: true }));

    try {
      expect((await api.get(`/api/v1/teams/teams/${team.id}`)).status()).toBe(200);

      const list = await api.get('/api/v1/teams/teams');
      expect(list.status()).toBe(200);

      const mine = await api.get('/api/v1/teams/my-teams');
      expect(mine.status()).toBe(200);

      const users = await api.get('/api/v1/teams/users');
      expect(users.status()).toBe(200);

      const member = await api.post(`/api/v1/teams/teams/${team.id}/members`, { data: { user_id: auth.user?.id, role: 'MEMBER' } });
      expect([200, 400, 409], await member.text()).toContain(member.status()); // 400/409 if the creator is auto-added

      const updated = await api.put(`/api/v1/teams/teams/${team.id}`, { data: { description: 'updated by e2e' } });
      expect(updated.status(), await updated.text()).toBe(200);

      const stats = await api.get('/api/v1/teams/stats');
      expect(stats.status()).toBe(200);
    } finally {
      const del = await api.delete(`/api/v1/teams/teams/${team.id}`);
      expect(del.status()).toBe(200);
    }
  });
});
