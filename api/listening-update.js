import { respond } from '../lib/api-shared.js';

export const config = { runtime: 'edge' };

// Server-side listening validation — talks to Supabase's REST API directly.
// This is the ONLY place a "completed listen" is ever recorded; the browser
// reports a position, but this function decides whether to trust it.
//
// Listening is tracked as ONE cumulative total across the whole assignment
// window (start_date -> deadline) — there is no daily quota/reset. Every
// legitimate completed listen increments a single running counter per
// (homework, student), stored as day_number = 1 in listening_progress for
// historical schema-compatibility, but read/written without any date
// filtering.

const TOLERANCE = 4; // seconds of slack for normal browser timer jitter

export default async function handler(request) {
  if (request.method !== 'POST') return respond({ error: 'method not allowed' }, 405);

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  function sb(path, opts = {}) {
    return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...opts,
      headers: {
        'apikey': SERVICE_KEY,
        'Authorization': `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': opts.prefer || 'return=representation',
        ...(opts.headers || {})
      }
    }).then(async r => {
      const text = await r.text();
      const data = text ? JSON.parse(text) : null;
      if (!r.ok) throw new Error(data?.message || 'Supabase error');
      return data;
    });
  }

  async function currentTotals(homework_id, student_id) {
    const [hw] = await sb(`homework?id=eq.${homework_id}&select=total_required_listens,listens_per_day`);
    const required = hw.total_required_listens || hw.listens_per_day || 0;
    const existingRows = await sb(`listening_progress?homework_id=eq.${homework_id}&student_id=eq.${student_id}&select=completed_listens`);
    const done = (existingRows || []).reduce((sum, r) => sum + r.completed_listens, 0);
    return { done, required };
  }

  async function recordCompletedListen(homework_id, student_id) {
    const [hw] = await sb(`homework?id=eq.${homework_id}&select=total_required_listens,listens_per_day`);
    const required = hw.total_required_listens || hw.listens_per_day || 0;

    const existingRows = await sb(`listening_progress?homework_id=eq.${homework_id}&student_id=eq.${student_id}&select=*`);
    const priorTotal = (existingRows || []).reduce((sum, r) => sum + r.completed_listens, 0);
    const newTotal = priorTotal + 1;

    const primary = (existingRows || []).find(r => r.day_number === 1);
    if (primary) {
      await sb(`listening_progress?id=eq.${primary.id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: JSON.stringify({ completed_listens: primary.completed_listens + 1, required_listens: required })
      });
    } else {
      await sb('listening_progress', {
        method: 'POST', prefer: 'return=minimal',
        body: JSON.stringify({
          homework_id, student_id, day_number: 1,
          date: new Date().toISOString().slice(0, 10),
          completed_listens: 1, required_listens: required
        })
      });
    }

    return { done: newTotal, required };
  }

  try {
    if (!SUPABASE_URL || !SERVICE_KEY) {
      return respond({ error: 'server misconfigured: missing SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY env vars' }, 500);
    }
    const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
    if (!token) return respond({ error: 'not signed in' }, 401);
    let callerUser;
    try {
      const authRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` }
      });
      callerUser = await authRes.json();
    } catch (e) {
      return respond({ error: 'could not verify session, please try again' }, 502);
    }
    if (!callerUser || !callerUser.id) return respond({ error: 'not signed in' }, 401);

    const body = await request.json();
    const { session_id, homework_id, student_id, position, duration, action } = body;

    if (action === 'start') {
      if (student_id !== callerUser.id) return respond({ error: 'forbidden' }, 403);
      if (!(typeof duration === 'number' && isFinite(duration) && duration > 0)) {
        return respond({ error: 'invalid audio duration' }, 400);
      }
      const [assignment] = await sb(`homework_assignments?homework_id=eq.${homework_id}&student_id=eq.${student_id}&select=homework_id`);
      if (!assignment) return respond({ error: 'not assigned to this homework' }, 403);
      const [session] = await sb('listening_sessions', {
        method: 'POST',
        body: JSON.stringify({ homework_id, student_id, audio_duration: duration, legitimate_position: 0, day_number: 1 })
      });
      return respond({ session_id: session.id });
    }

    const [session] = await sb(`listening_sessions?id=eq.${session_id}&select=*`);
    if (!session) return respond({ error: 'invalid session' }, 400);
    if (session.student_id !== callerUser.id) return respond({ error: 'forbidden' }, 403);
    if (session.completed) return respond({ ok: true, already_completed: true });

    if (action === 'seek_attempt') {
      await sb(`listening_sessions?id=eq.${session_id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: JSON.stringify({ seek_attempts: session.seek_attempts + 1 })
      });
      return respond({ ok: true, position: session.legitimate_position });
    }

    if (action === 'progress') {
      const maxAllowed = session.legitimate_position + TOLERANCE + 1;
      const clamped = Math.max(Math.min(position, maxAllowed), session.legitimate_position);
      const reachedEnd = clamped >= session.audio_duration - TOLERANCE;

      if (!reachedEnd) {
        await sb(`listening_sessions?id=eq.${session_id}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: JSON.stringify({ legitimate_position: clamped })
        });
        return respond({ ok: true, position: clamped, completed: false });
      }

      const claimed = await sb(`listening_sessions?id=eq.${session_id}&completed=eq.false`, {
        method: 'PATCH', prefer: 'return=representation',
        body: JSON.stringify({ legitimate_position: clamped, completed: true, completed_at: new Date().toISOString() })
      });

      if (!claimed || claimed.length === 0) {
        const totals = await currentTotals(session.homework_id, session.student_id);
        return respond({ ok: true, position: clamped, completed: true, already_completed: true, ...totals });
      }

      const totals = await recordCompletedListen(session.homework_id, session.student_id);
      return respond({ ok: true, position: clamped, completed: true, ...totals });
    }

    return respond({ error: 'unknown action' }, 400);
  } catch (err) {
    return respond({ error: err.message }, 500);
  }
}
