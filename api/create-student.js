import { respond, sbFetchFactory, getCallerUser } from '../lib/api-shared.js';

export const config = { runtime: 'edge' };

export default async function handler(request) {
  if (request.method !== 'POST') return respond({ error: 'method not allowed' }, 405);

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const sbFetch = sbFetchFactory(SUPABASE_URL, SERVICE_KEY);

  try {
    const token = (request.headers.get('authorization') || '').replace('Bearer ', '');

    const callerUser = await getCallerUser(SUPABASE_URL, SERVICE_KEY, token);
    if (!callerUser || !callerUser.id) return respond({ error: 'not signed in' }, 401);

    const [callerProfile] = await sbFetch(`/rest/v1/profiles?id=eq.${callerUser.id}&select=role`);
    if (!callerProfile || callerProfile.role !== 'teacher') return respond({ error: 'teachers only' }, 403);

    const { name, username, password, student_id_number } = await request.json();
    if (!name || !username || !password) return respond({ error: 'missing fields' }, 400);

    const email = username.trim().toLowerCase() + '@students.homeworkapp.local';

    const created = await sbFetch('/auth/v1/admin/users', {
      method: 'POST',
      body: JSON.stringify({ email, password, email_confirm: true })
    });

    try {
      await sbFetch('/rest/v1/profiles', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          id: created.id, name, username: username.trim().toLowerCase(),
          role: 'student', student_id_number: student_id_number || null, active: true,
          plaintext_password: password
        })
      });
    } catch (profileErr) {
      await sbFetch(`/auth/v1/admin/users/${created.id}`, { method: 'DELETE' });
      return respond({ error: profileErr.message }, 400);
    }

    return respond({ ok: true, id: created.id });
  } catch (err) {
    return respond({ error: err.message }, 500);
  }
}
