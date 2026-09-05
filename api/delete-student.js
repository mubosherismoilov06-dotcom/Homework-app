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

    const { student_id } = await request.json().catch(() => ({}));
    if (!student_id) return respond({ error: 'missing student_id' }, 400);

    const [targetProfile] = await sbFetch(`/rest/v1/profiles?id=eq.${student_id}&select=role`);
    if (!targetProfile || targetProfile.role !== 'student') return respond({ error: 'student not found' }, 404);

    await sbFetch(`/auth/v1/admin/users/${student_id}`, { method: 'DELETE' });

    return respond({ ok: true });
  } catch (err) {
    return respond({ error: err.message }, 500);
  }
}
