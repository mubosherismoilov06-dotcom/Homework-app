import { respond, sbFetchFactory, getCallerUser } from '../lib/api-shared.js';

// Computes daily / weekly / monthly completion-% leaderboards for a group.
//
// Scoring rule (per student, per calendar day):
//   For every homework assignment active that day (start_date <= day <= deadline,
//   not archived), compute a 0–1 completion fraction for each of the tasks it
//   involves — tracked as SEPARATE components, never fused together:
//     - listening          : cumulative completed listens as of that day,
//                             divided by the homework's required total, capped at 1.
//     - listening_photo     : 1 if the transcription photo has been submitted by
//                             that day, else 0 — only for listening homework that
//                             has "require transcription photo" turned on.
//     - reading_recording   : (# of "read the passage aloud" recordings submitted
//                             by that day) / the homework's required count, capped at 1.
//     - retelling           : 1 if at least one retelling recording has been
//                             submitted by that day, else 0 (retelling has no set
//                             required count — any submission counts as done).
//     - chatgpt_photo       : 1 if the ChatGPT screenshot has been submitted by
//                             that day, else 0.
//     - vocabulary_photo    : 1 if the vocabulary homework photo has been
//                             submitted by that day, else 0.
//     - grammar_photo       : 1 if the grammar homework photo has been
//                             submitted by that day, else 0.
//   Each component is averaged across every homework that contributes to it that
//   day (so e.g. two listening homeworks the same day become one "listening %"),
//   and then the resulting component averages are averaged together for the
//   day's overall score — every component pulls equal weight, e.g.
//   60% listening + 100% listening_photo + 50% reading_recording -> day score 70%.
//   A day with no active homework at all has a null score (excluded from
//   weekly/monthly averages rather than counted as 0).
//
// Listening progress specifically is tracked as ONE cumulative running total
// per (homework, student) rather than a per-day bucket (see listening-update.js),
// so "how many listens had this student done AS OF a given day" is reconstructed
// here from individual completed listening_sessions rows (each has its own
// completed_at timestamp) rather than from listening_progress, which no longer
// carries day-by-day history.
//
// This intentionally does NOT expose raw submissions/recordings across
// students — only the aggregated percentages — so group-mates can see each
// other's progress without seeing each other's actual submitted work.

// SUPABASE_URL / SERVICE_KEY are read inside the handler from context.env



function fmt(d) { return d.toISOString().slice(0, 10); }

function parseUTCDate(s) { return new Date(s + 'T00:00:00Z'); }

function addDays(d, n) { const r = new Date(d); r.setUTCDate(r.getUTCDate() + n); return r; }

function dateRangeFor(period, refDateStr) {
  const ref = parseUTCDate(refDateStr);
  if (period === 'daily') return { start: refDateStr, end: refDateStr };
  if (period === 'weekly') {
    const dow = ref.getUTCDay(); // 0=Sun..6=Sat
    const mondayOffset = dow === 0 ? -6 : 1 - dow;
    const monday = addDays(ref, mondayOffset);
    const sunday = addDays(monday, 6);
    return { start: fmt(monday), end: fmt(sunday) };
  }
  // monthly
  const first = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), 1));
  const last = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + 1, 0));
  return { start: fmt(first), end: fmt(last) };
}

function allDatesBetween(startStr, endStr) {
  const out = [];
  let cur = parseUTCDate(startStr);
  const end = parseUTCDate(endStr);
  while (cur <= end) { out.push(fmt(cur)); cur = addDays(cur, 1); }
  return out;
}

export const config = { runtime: 'edge' };

export default async function handler(request) {
  if (request.method !== 'GET') return respond({ error: 'method not allowed' }, 405);
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const sbFetch = sbFetchFactory(SUPABASE_URL, SERVICE_KEY);
  try {
    if (!SUPABASE_URL || !SERVICE_KEY) {
      return respond({ error: 'server misconfigured: missing SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY env vars' }, 500);
    }
    const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
    if (!token) return respond({ error: 'not signed in' }, 401);

    let callerUser;
    try {
      callerUser = await getCallerUser(SUPABASE_URL, SERVICE_KEY, token);
    } catch (e) {
      return respond({ error: 'could not verify session, please try again' }, 502);
    }
    if (!callerUser || !callerUser.id) return respond({ error: 'not signed in' }, 401);

    const [callerProfile] = await sbFetch(`/rest/v1/profiles?id=eq.${callerUser.id}&select=id,name,role,group_id`);
    if (!callerProfile) return respond({ error: 'profile not found' }, 404);

    const params = Object.fromEntries(new URL(request.url).searchParams);
    const period = ['daily', 'weekly', 'monthly'].includes(params.period) ? params.period : 'daily';
    const refDateStr = /^\d{4}-\d{2}-\d{2}$/.test(params.date || '') ? params.date : fmt(new Date());

    let groupId;
    if (callerProfile.role === 'teacher') {
      groupId = params.group_id;
      if (!groupId) return respond({ error: 'group_id required for teachers' }, 400);
      const [g] = await sbFetch(`/rest/v1/groups?id=eq.${groupId}&teacher_id=eq.${callerProfile.id}&select=id`);
      if (!g) return respond({ error: 'group not found' }, 404);
    } else {
      groupId = callerProfile.group_id;
      if (!groupId) return respond({ ok: true, noGroup: true, students: [], daily: {} });
    }

    const [group] = await sbFetch(`/rest/v1/groups?id=eq.${groupId}&select=id,name`);
    const students = await sbFetch(`/rest/v1/profiles?group_id=eq.${groupId}&role=eq.student&active=eq.true&select=id,name&order=name.asc`);
    if (students.length === 0) return respond({ ok: true, groupName: group?.name || '', students: [], daily: {} });

    const studentIds = students.map(s => s.id);
    const idsIn = `(${studentIds.join(',')})`;

    const { start: startDate, end: endDate } = dateRangeFor(period, refDateStr);
    const days = allDatesBetween(startDate, endDate);

    const assignments = await sbFetch(
      `/rest/v1/homework_assignments?student_id=in.${idsIn}` +
      `&select=student_id,homework!inner(id,type,start_date,deadline,listens_per_day,total_required_listens,require_photo,reading_recordings_required,archived)` +
      `&homework.archived=eq.false&homework.start_date=lte.${endDate}&homework.deadline=gte.${startDate}`
    );

    // Every completed listen, individually — this is what lets us reconstruct
    // "how many had this student done as of day D" for any D in range, since
    // listening_progress itself is just a single running total with no
    // day-by-day history anymore.
    const sessions = await sbFetch(
      `/rest/v1/listening_sessions?student_id=in.${idsIn}&completed=eq.true&completed_at=lte.${endDate}T23:59:59` +
      `&select=homework_id,student_id,completed_at`
    );

    const submissions = await sbFetch(
      `/rest/v1/submissions?student_id=in.${idsIn}&submitted_at=lte.${endDate}T23:59:59` +
      `&type=in.(photo,reading_audio,retelling_audio,chat_photo,chat_text)` +
      `&select=homework_id,student_id,type,submitted_at`
    );

    // Index for fast lookup
    const sessionsByHwStudent = {}; // `${hwId}|${studentId}` -> sorted array of 'YYYY-MM-DD'
    for (const s of sessions) {
      const key = `${s.homework_id}|${s.student_id}`;
      (sessionsByHwStudent[key] = sessionsByHwStudent[key] || []).push(s.completed_at.slice(0, 10));
    }
    for (const key in sessionsByHwStudent) sessionsByHwStudent[key].sort();

    function listensAsOf(hwId, studentId, day) {
      const dates = sessionsByHwStudent[`${hwId}|${studentId}`];
      if (!dates) return 0;
      // dates is sorted ascending; count entries <= day.
      let lo = 0, hi = dates.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (dates[mid] <= day) lo = mid + 1; else hi = mid;
      }
      return lo;
    }

    const subsByHwStudent = {}; // `${hwId}|${studentId}` -> [{type, date, submitted_at}]
    for (const s of submissions) {
      const key = `${s.homework_id}|${s.student_id}`;
      (subsByHwStudent[key] = subsByHwStudent[key] || []).push({ type: s.type, date: s.submitted_at.slice(0, 10), submitted_at: s.submitted_at });
    }

    const byStudent = {};
    for (const s of students) byStudent[s.id] = [];
    for (const a of assignments) (byStudent[a.student_id] = byStudent[a.student_id] || []).push(a.homework);

    // Timestamp (ms) of the specific event on `day` that pushed a component to
    // its value used in scoreForDay, so ties can be broken by "who finished
    // first" rather than by name. `latestTs` tracks the newest contributing
    // event <= day for a given student across all their homeworks; this is
    // what "reaching 100%" (or whatever their tied score is) actually means
    // in wall-clock terms — the moment their last needed submission landed.
    function latestContributionTs(studentId, day) {
      const hwList = (byStudent[studentId] || []).filter(hw => hw.start_date <= day && hw.deadline >= day);
      let latest = null;
      const bump = (iso) => {
        if (!iso) return;
        const ms = new Date(iso).getTime();
        if (!Number.isNaN(ms) && (latest === null || ms > latest)) latest = ms;
      };
      for (const hw of hwList) {
        const subs = subsByHwStudent[`${hw.id}|${studentId}`] || [];
        if (hw.type === 'listening') {
          const dates = sessionsByHwStudent[`${hw.id}|${studentId}`] || [];
          for (const d of dates) if (d <= day) bump(d + 'T23:59:59');
          if (hw.require_photo) {
            for (const s of subs) if (s.type === 'photo' && s.date <= day) bump(s.submitted_at);
          }
        } else if (hw.type === 'reading') {
          for (const s of subs) if ((s.type === 'reading_audio' || s.type === 'retelling_audio') && s.date <= day) bump(s.submitted_at);
        } else if (hw.type === 'vocabulary' || hw.type === 'grammar') {
          for (const s of subs) if (s.type === 'photo' && s.date <= day) bump(s.submitted_at);
        } else {
          for (const s of subs) if ((s.type === 'chat_photo' || s.type === 'chat_text') && s.date <= day) bump(s.submitted_at);
        }
      }
      return latest;
    }

    function scoreForDay(studentId, day) {
      const hwList = (byStudent[studentId] || []).filter(hw => hw.start_date <= day && hw.deadline >= day);
      if (hwList.length === 0) return null;

      const componentTotals = {}; // component -> {sum, count}
      const addComponent = (name, pct) => {
        const t = (componentTotals[name] = componentTotals[name] || { sum: 0, count: 0 });
        t.sum += pct; t.count += 1;
      };

      for (const hw of hwList) {
        const subs = subsByHwStudent[`${hw.id}|${studentId}`] || [];

        if (hw.type === 'listening') {
          const done = listensAsOf(hw.id, studentId, day);
          const req = hw.total_required_listens || hw.listens_per_day || null;
          addComponent('listening', req ? Math.min(1, done / req) : (done > 0 ? 1 : 0));

          if (hw.require_photo) {
            const hasPhoto = subs.some(s => s.type === 'photo' && s.date <= day);
            addComponent('listening_photo', hasPhoto ? 1 : 0);
          }
        } else if (hw.type === 'reading') {
          const readingCount = subs.filter(s => s.type === 'reading_audio' && s.date <= day).length;
          const readingReq = hw.reading_recordings_required || 1;
          addComponent('reading_recording', Math.min(1, readingCount / readingReq));

          const hasRetelling = subs.some(s => s.type === 'retelling_audio' && s.date <= day);
          addComponent('retelling', hasRetelling ? 1 : 0);
        } else if (hw.type === 'vocabulary' || hw.type === 'grammar') {
          const hasPhoto = subs.some(s => s.type === 'photo' && s.date <= day);
          addComponent(hw.type === 'vocabulary' ? 'vocabulary_photo' : 'grammar_photo', hasPhoto ? 1 : 0);
        } else { // chatgpt
          const hasChat = subs.some(s => (s.type === 'chat_photo' || s.type === 'chat_text') && s.date <= day);
          addComponent('chatgpt_photo', hasChat ? 1 : 0);
        }
      }

      const componentAverages = Object.values(componentTotals).map(t => t.sum / t.count);
      if (componentAverages.length === 0) return null;
      const overall = componentAverages.reduce((a, b) => a + b, 0) / componentAverages.length;
      return Math.round(overall * 1000) / 10; // one decimal place
    }

    const dailyBreakdown = {};
    const results = students.map(s => {
      const dayScores = days.map(d => ({ date: d, score: scoreForDay(s.id, d) }));
      dailyBreakdown[s.id] = dayScores;
      const defined = dayScores.filter(d => d.score !== null);
      const score = defined.length ? Math.round((defined.reduce((a, b) => a + b.score, 0) / defined.length) * 10) / 10 : null;
      // completedAt = timestamp of this student's last contributing submission
      // as of the final day of the period. Two students with the same score
      // are tied on completion %, but whoever's last needed piece of work
      // landed earlier gets the better rank.
      const completedAt = score !== null ? latestContributionTs(s.id, endDate) : null;
      return { id: s.id, name: s.name, isSelf: s.id === callerProfile.id, score, completedAt };
    });

    results.sort((a, b) => {
      if (a.score === null && b.score === null) return a.name.localeCompare(b.name);
      if (a.score === null) return 1;
      if (b.score === null) return -1;
      if (a.score !== b.score) return b.score - a.score;
      // Tie on score: earlier completion timestamp ranks first. A student
      // with no recorded timestamp (shouldn't happen alongside a non-null
      // score, but guard anyway) sorts after one that has one.
      if (a.completedAt === null && b.completedAt === null) return a.name.localeCompare(b.name);
      if (a.completedAt === null) return 1;
      if (b.completedAt === null) return -1;
      if (a.completedAt !== b.completedAt) return a.completedAt - b.completedAt;
      return a.name.localeCompare(b.name);
    });
    results.forEach((r, i) => { r.rank = r.score === null ? null : i + 1; delete r.completedAt; });

    return respond({
      ok: true, period, startDate, endDate, groupId, groupName: group?.name || '',
      students: results, daily: dailyBreakdown
    });
  } catch (err) {
    return respond({ error: err.message }, 500);
  }
}
