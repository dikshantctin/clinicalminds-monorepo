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
      expect(member.status(), await member.text()).toBe(400); // the creator is auto-added
      expect((await member.json()).message).toBe('User is already a team member');

      const updated = await api.put(`/api/v1/teams/teams/${team.id}`, { data: { description: 'updated by e2e' } });
      expect(updated.status(), await updated.text()).toBe(200);

      const stats = await api.get('/api/v1/teams/stats');
      expect(stats.status()).toBe(200);
    } finally {
      const del = await api.delete(`/api/v1/teams/teams/${team.id}`);
      expect(del.status()).toBe(200);
    }
  });

  test('a deleted team leaves the list (still readable with is_active=false)', async ({ api }) => {
    const name = uniq('GoneTeam');
    const created = await api.post('/api/v1/teams/teams', { data: { name, team_type: 'CLINICAL', color: '#3B82F6' } });
    expect(created.status(), await created.text()).toBe(200);
    const team = await created.json();
    const listed = async (params: Record<string, string>) =>
      ((await (await api.get('/api/v1/teams/teams', { params: { search: name, ...params } })).json()).teams as { id: string }[]).map((t) => t.id);
    expect(await listed({})).toContain(team.id);
    expect((await api.delete(`/api/v1/teams/teams/${team.id}`)).status()).toBe(200);
    expect(await listed({})).not.toContain(team.id);
    expect(await listed({ is_active: 'false' })).toContain(team.id);
  });
});
