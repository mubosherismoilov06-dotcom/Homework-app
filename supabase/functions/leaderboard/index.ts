// supabase/functions/leaderboard/index.ts  (v2)
//
// Two scopes:
//   scope=period (default) — ranks students on homeworks due within the
//     selected day/week/month. This is "current" standing.
//   scope=all_time — ranks students on EVERY homework ever assigned
//     (active + archived), equal-weighted the same way. Meant to be shown
//     as a bar chart, mirroring the Groups progression page's "All-Time
//     Totals" section.
//
// Fairness rules (unchanged from v1, per the teacher's request):
//   1. Every homework counts as an equal share of 100%, regardless of type.
//   2. Equal scores are broken by whoever finished earliest.
//
// v2 fixes (found by reading the real schema/groups.html after v1 shipped):
//   - Added 'vocabulary' and 'grammar' homework types (>=1 'photo'
//     submission for that homework = done — same as chatgpt).
//   - Listening homework with require_photo=true now also needs a 'photo'
//     submission, not just the listen count, to be treated as 100% done.
//   - Reading's 'retelling_audio' submissions are informational only (no
//     required count in the schema) and still don't factor into scoring,
//     matching how the Groups page treats them.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function pad(n: number) { return String(n).padStart(2, "0"); }
function toDateStr(d: Date) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function periodRange(period: string, dateStr: string) {
  const d = new Date(dateStr + "T00:00:00Z");
  if (period === "daily") return { start: dateStr, end: dateStr };
  if (period === "weekly") {
    const dow = d.getUTCDay();
    const diffToMonday = dow === 0 ? -6 : 1 - dow;
    const start = new Date(d);
    start.setUTCDate(d.getUTCDate() + diffToMonday);
    const end = new Date(start);
    end.setUTCDate(start.getUTCDate() + 6);
    return { start: toDateStr(start), end: toDateStr(end) };
  }
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  return { start: toDateStr(start), end: toDateStr(end) };
}

function eachDateInRange(start: string, end: string) {
  const out: string[] = [];
  const cur = new Date(start + "T00:00:00Z");
  const last = new Date(end + "T00:00:00Z");
  while (cur <= last) { out.push(toDateStr(cur)); cur.setUTCDate(cur.getUTCDate() + 1); }
  return out;
}

function homeworkDueOn(hw: any, dateStr: string) {
  if (!hw.deadline) return false;
  return String(hw.deadline).slice(0, 10) === dateStr;
}
function homeworkDueInRange(hw: any, start: string, end: string) {
  if (!hw.deadline) return false;
  const due = String(hw.deadline).slice(0, 10);
  return due >= start && due <= end;
}

type Progress = { fraction: number; finishedAt: string | null; lastActivityAt: string | null };

function latestOf(...ts: (string | null)[]) {
  return ts.filter(Boolean).sort().pop() || null;
}

function progressFor(
  hw: any,
  studentId: string,
  submissions: any[],
  sessions: any[],
): Progress {
  const photoSubs = () =>
    submissions
      .filter((s) => s.homework_id === hw.id && s.student_id === studentId && s.type === "photo")
      .sort((a, b) => new Date(a.submitted_at).getTime() - new Date(b.submitted_at).getTime());

  if (hw.type === "listening") {
    const required = hw.total_required_listens || (hw.listens_per_day && hw.number_of_days
      ? hw.listens_per_day * hw.number_of_days
      : 1) || 1;
    const mine = sessions
      .filter((s) => s.homework_id === hw.id && s.student_id === studentId)
      .sort((a, b) => new Date(a.completed_at).getTime() - new Date(b.completed_at).getTime());
    const completedCount = mine.length;
    const listenFraction = Math.min(1, completedCount / required);
    const listenFinishedAt = completedCount >= required ? mine[required - 1].completed_at : null;
    const listenLastActivityAt = mine.length ? mine[mine.length - 1].completed_at : null;

    if (!hw.require_photo) {
      return { fraction: listenFraction, finishedAt: listenFinishedAt, lastActivityAt: listenLastActivityAt };
    }
    // Both the listen count AND a transcription photo are required.
    const photos = photoSubs();
    const photoDone = photos.length > 0;
    const photoAt = photoDone ? photos[0].submitted_at : null;
    const fraction = (listenFraction + (photoDone ? 1 : 0)) / 2;
    const finishedAt = listenFraction >= 1 && photoDone ? latestOf(listenFinishedAt, photoAt) : null;
    const lastActivityAt = latestOf(listenLastActivityAt, photoAt);
    return { fraction, finishedAt, lastActivityAt };
  }

  if (hw.type === "reading") {
    // Retelling recordings have no required count in this app (unlimited,
    // no target) — only reading_audio counts toward completion, matching
    // the teacher's Groups progression view.
    const required = hw.reading_recordings_required || 1;
    const mine = submissions
      .filter((s) => s.homework_id === hw.id && s.student_id === studentId && s.type === "reading_audio")
      .sort((a, b) => new Date(a.submitted_at).getTime() - new Date(b.submitted_at).getTime());
    const completedCount = mine.length;
    const fraction = Math.min(1, completedCount / required);
    const finishedAt = completedCount >= required ? mine[required - 1].submitted_at : null;
    const lastActivityAt = mine.length ? mine[mine.length - 1].submitted_at : null;
    return { fraction, finishedAt, lastActivityAt };
  }

  if (hw.type === "vocabulary" || hw.type === "grammar") {
    // Same as chatgpt: one qualifying photo submission finishes it.
    const photos = photoSubs();
    if (photos.length === 0) return { fraction: 0, finishedAt: null, lastActivityAt: null };
    return { fraction: 1, finishedAt: photos[0].submitted_at, lastActivityAt: photos[0].submitted_at };
  }

  // chatgpt (or any other one-shot type)
  const mine = submissions
    .filter((s) =>
      s.homework_id === hw.id && s.student_id === studentId &&
      (s.type === "chat_photo" || s.type === "chat_text")
    )
    .sort((a, b) => new Date(a.submitted_at).getTime() - new Date(b.submitted_at).getTime());
  if (mine.length === 0) return { fraction: 0, finishedAt: null, lastActivityAt: null };
  return { fraction: 1, finishedAt: mine[0].submitted_at, lastActivityAt: mine[0].submitted_at };
}

function scoreStudent(studentId: string, hwList: any[], submissions: any[], sessions: any[]) {
  if (hwList.length === 0) return { score: null as number | null, tieBreakAt: null as string | null };
  const weight = 100 / hwList.length;
  let total = 0;
  let allComplete = true;
  let lastFinish: string | null = null;
  let lastActivity: string | null = null;

  for (const hw of hwList) {
    const { fraction, finishedAt, lastActivityAt } = progressFor(hw, studentId, submissions, sessions);
    total += fraction * weight;
    if (fraction < 1) {
      allComplete = false;
    } else if (finishedAt && (!lastFinish || finishedAt > lastFinish)) {
      lastFinish = finishedAt;
    }
    if (lastActivityAt && (!lastActivity || lastActivityAt > lastActivity)) lastActivity = lastActivityAt;
  }

  return {
    score: Math.round(total),
    tieBreakAt: allComplete ? lastFinish : lastActivity,
  };
}

function rankAndSort(results: { id: string; name: string; score: number | null; tieBreakAt: string | null; isSelf: boolean }[]) {
  results.sort((a, b) => {
    if (a.score === null && b.score === null) return 0;
    if (a.score === null) return 1;
    if (b.score === null) return -1;
    if (b.score !== a.score) return b.score - a.score;
    const at = a.tieBreakAt ? new Date(a.tieBreakAt).getTime() : Infinity;
    const bt = b.tieBreakAt ? new Date(b.tieBreakAt).getTime() : Infinity;
    return at - bt;
  });
  let rank = 0, lastScore: number | null = null, lastTie: string | null = null;
  results.forEach((r, i) => {
    if (r.score === null) return;
    if (r.score !== lastScore || r.tieBreakAt !== lastTie) rank = i + 1;
    (r as any).rank = rank;
    lastScore = r.score;
    lastTie = r.tieBreakAt;
  });
  return results.map((r) => ({ id: r.id, name: r.name, score: r.score, rank: (r as any).rank ?? null, isSelf: r.isSelf }));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "Not signed in." }, 401);

    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await callerClient.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: "Not signed in." }, 401);

    const sb = createClient(supabaseUrl, serviceRoleKey);

    const { data: callerProfile } = await sb.from("profiles").select("*").eq("id", userData.user.id).single();
    if (!callerProfile || !callerProfile.active) return json({ error: "Account not active." }, 403);

    const url = new URL(req.url);
    const scope = url.searchParams.get("scope") === "all_time" ? "all_time" : "period";
    const period = url.searchParams.get("period") || "daily";
    const dateParam = url.searchParams.get("date") || toDateStr(new Date());
    let groupId = url.searchParams.get("group_id");

    if (callerProfile.role === "student") {
      groupId = callerProfile.group_id;
      if (!groupId) return json({ noGroup: true });
    } else {
      if (!groupId) return json({ error: "group_id is required." }, 400);
      const { data: g } = await sb.from("groups").select("teacher_id").eq("id", groupId).single();
      if (!g || g.teacher_id !== callerProfile.id) return json({ error: "That group doesn't belong to you." }, 403);
    }

    const { start, end } = scope === "all_time" ? { start: null as any, end: null as any } : periodRange(period, dateParam);

    const { data: group } = await sb.from("groups").select("id, name").eq("id", groupId).single();
    const { data: students } = await sb.from("profiles").select("id, name")
      .eq("group_id", groupId).eq("role", "student").eq("active", true).order("name");

    const base: any = { scope, groupName: group?.name || null };
    if (scope === "period") { base.startDate = start; base.endDate = end; }

    if (!students || students.length === 0) return json({ ...base, students: [], daily: {} });
    const studentIds = students.map((s) => s.id);

    const { data: assignedRows } = await sb.from("homework_assignments")
      .select("homework_id, student_id").in("student_id", studentIds);
    const allHomeworkIds = [...new Set((assignedRows || []).map((r) => r.homework_id))];

    let homeworks: any[] = [];
    if (allHomeworkIds.length > 0) {
      const { data } = await sb.from("homework").select("*").in("id", allHomeworkIds);
      homeworks = data || [];
    }

    const scopedHomeworks = scope === "all_time"
      ? homeworks
      : homeworks.filter((hw) => homeworkDueInRange(hw, start, end));
    const scopedHwIds = scopedHomeworks.map((h) => h.id);

    const assignedMap: Record<string, any[]> = {};
    for (const row of assignedRows || []) {
      const hw = scopedHomeworks.find((h) => h.id === row.homework_id);
      if (!hw) continue;
      (assignedMap[row.student_id] ??= []).push(hw);
    }

    let submissions: any[] = [];
    let sessions: any[] = [];
    if (scopedHwIds.length > 0) {
      const [subsRes, sessRes] = await Promise.all([
        sb.from("submissions").select("homework_id, student_id, type, submitted_at")
          .in("homework_id", scopedHwIds).in("student_id", studentIds),
        sb.from("listening_sessions").select("homework_id, student_id, completed_at")
          .in("homework_id", scopedHwIds).in("student_id", studentIds).eq("completed", true),
      ]);
      submissions = subsRes.data || [];
      sessions = sessRes.data || [];
    }

    const results = students.map((s) => {
      const { score, tieBreakAt } = scoreStudent(s.id, assignedMap[s.id] || [], submissions, sessions);
      return { id: s.id, name: s.name, score, tieBreakAt, isSelf: s.id === callerProfile.id };
    });
    const studentsOut = rankAndSort(results);

    // Trend (period scope only): caller's own per-day score across the period.
    const daily: Record<string, { date: string; score: number | null }[]> = {};
    if (scope === "period") {
      const myHwByDay = eachDateInRange(start, end).map((d) => {
        const hwDueThatDay = homeworks.filter((hw) =>
          homeworkDueOn(hw, d) &&
          (assignedRows || []).some((r) => r.homework_id === hw.id && r.student_id === callerProfile.id)
        );
        const { score } = scoreStudent(callerProfile.id, hwDueThatDay, submissions, sessions);
        return { date: d, score: hwDueThatDay.length ? score : null };
      });
      daily[callerProfile.id] = myHwByDay;
    }

    return json({ ...base, students: studentsOut, daily });
  } catch (e) {
    console.error(e);
    return json({ error: "Server error." }, 500);
  }
});
