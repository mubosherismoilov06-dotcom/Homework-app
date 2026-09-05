import { respond, sbFetchFactory } from '../lib/api-shared.js';

export const config = { runtime: 'edge' };

export default async function handler(request) {
  if (request.method !== 'POST') return respond({ error: 'method not allowed' }, 405);

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const sbFetch = sbFetchFactory(SUPABASE_URL, SERVICE_KEY);

  try {
    const { name, email, password } = await request.json();
    if (!name || !email || !password) return respond({ error: 'missing fields' }, 400);

    const [existingTeacher] = await sbFetch(`/rest/v1/profiles?role=eq.teacher&select=id&limit=1`);
    if (existingTeacher) return respond({ error: 'A teacher account already exists. Please use the login page.' }, 400);

    let userId;
    try {
      const created = await sbFetch('/auth/v1/admin/users', {
        method: 'POST',
        body: JSON.stringify({ email, password, email_confirm: true })
      });
      userId = created.id;
    } catch (e) {
      if (!/registered|exists/i.test(e.message)) throw e;
      const list = await sbFetch(`/auth/v1/admin/users?page=1&per_page=1000`);
      const match = (list.users || []).find(u => u.email && u.email.toLowerCase() === email.toLowerCase());
      if (!match) throw e;
      userId = match.id;
      await sbFetch(`/auth/v1/admin/users/${userId}`, { method: 'PUT', body: JSON.stringify({ password }) });
    }

    const [existingProfile] = await sbFetch(`/rest/v1/profiles?id=eq.${userId}&select=id`);
    if (!existingProfile) {
      await sbFetch('/rest/v1/profiles', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ id: userId, name, username: email, role: 'teacher', active: true })
      });
    }

    return respond({ ok: true });
  } catch (err) {
    return respond({ error: err.message }, 500);
  }
}
