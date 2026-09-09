// supabase/functions/leaderboard/index.ts
//
// Computes a fair leaderboard for a group of students over a daily / weekly /
// monthly period.
//
// Fairness rules (per the teacher's request):
//   1. Every homework assigned to a student in the period is worth an EQUAL
//      share of 100%, regardless of type (listening / reading / chatgpt) or
//      how many listens/recordings it requires internally.
//   2. When two students land on the same score, the one who finished their
//      last piece of work EARLIER ranks higher (not lower). This fixes the
//      bug where the student who reached 100% first was shown in 2nd place.
//
// Assumptions made while rebuilding this (nothing like it existed in the
// project before) — flag these to the teacher if the behavior doesn't match
// what they expect:
//   - "Assigned in this period" = the homework's deadline falls on/within
//     the selected day/week/month.
//   - Listening homework is "done" once completed listening_sessions >=
//     homework.total_required_listens (falling back to
//     listens_per_day * number_of_days).
//   - Reading homework is "done" once `reading_audio` submissions >=
//     homework.reading_recordings_required (default 1).
//   - Chatgpt homework is "done" as soon as one chat_photo/chat_text
//     submission exists.
//   - The per-day trend chart re-runs the same equal-weight scoring using
//     only homeworks whose deadline is that exact date.

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

function pad(n: number) {
  return String(n).padStart(2, "0");
}
function toDateStr(d: Date) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function periodRange(period: string, dateStr: string) {
  const d = new Date(dateStr + "T00:00:00Z");
  if (period === "daily") {
    return { start: dateStr, end: dateStr };
  }
  if (period === "weekly") {
    // Monday-start week containing d.
    const dow = d.getUTCDay(); // 0=Sun..6=Sat
    const diffToMonday = dow === 0 ? -6 : 1 - dow;
    const start = new Date(d);
    start.setUTCDate(d.getUTCDate() + diffToMonday);
    const end = new Date(start);
    end.setUTCDate(start.getUTCDate() + 6);
    return { start: toDateStr(start), end: toDateStr(end) };
  }
  // monthly
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  return { start: toDateStr(start), end: toDateStr(end) };
}

function eachDateInRange(start: string, end: string) {
  const out: string[] = [];
  const cur = new Date(start + "T00:00:00Z");
  const last = new Date(end + "T00:00:00Z");
  while (cur <= last) {
    out.push(toDateStr(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
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

function progressFor(
  hw: any,
  studentId: string,
  submissions: any[],
  sessions: any[],
): Progress {
  if (hw.type === "listening") {
    const required = hw.total_required_listens || (hw.listens_per_day && hw.number_of_days
      ? hw.listens_per_day * hw.number_of_days
      : 1) || 1;
    const mine = sessions
      .filter((s) => s.homework_id === hw.id && s.student_id === studentId)
      .sort((a, b) => new Date(a.completed_at).getTime() - new Date(b.completed_at).getTime());
    const completedCount = mine.length;
    const fraction = Math.min(1, completedCount / required);
    const finishedAt = completedCount >= required ? mine[required - 1].completed_at : null;
    const lastActivityAt = mine.length ? mine[mine.length - 1].completed_at : null;
    return { fraction, finishedAt, lastActivityAt };
  }

  if (hw.type === "reading") {
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

  // chatgpt (or any other one-shot type): first qualifying submission finishes it.
  const mine = submissions
    .filter((s) =>
      s.homework_id === hw.id && s.student_id === studentId &&
      (s.type === "chat_photo" || s.type === "chat_text")
    )
    .sort((a, b) => new Date(a.submitted_at).getTime() - new Date(b.submitted_at).getTime());
  if (mine.length === 0) return { fraction: 0, finishedAt: null, lastActivityAt: null };
  return { fraction: 1, finishedAt: mine[0].submitted_at, lastActivityAt: mine[0].submitted_at };
}

function scoreStudent(
  studentId: string,
  hwList: any[],
  submissions: any[],
  sessions: any[],
) {
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
    if (lastActivityAt && (!lastActivity || lastActivityAt > lastActivity)) {
      lastActivity = lastActivityAt;
    }
  }

  return {
    score: Math.round(total),
    // Only fully-finished students are ordered by finish time; among
    // students who aren't finished yet, ties fall back to most recent
    // activity (still earlier-is-better, so steady early progress wins ties).
    tieBreakAt: allComplete ? lastFinish : lastActivity,
  };
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

    const { data: callerProfile } = await sb
      .from("profiles")
      .select("*")
      .eq("id", userData.user.id)
      .single();
    if (!callerProfile || !callerProfile.active) return json({ error: "Account not active." }, 403);

    const url = new URL(req.url);
    const period = url.searchParams.get("period") || "daily";
    const dateParam = url.searchParams.get("date") || toDateStr(new Date());
    let groupId = url.searchParams.get("group_id");

    if (callerProfile.role === "student") {
      groupId = callerProfile.group_id;
      if (!groupId) return json({ noGroup: true });
    } else {
      if (!groupId) return json({ error: "group_id is required." }, 400);
      const { data: group } = await sb.from("groups").select("teacher_id").eq("id", groupId).single();
      if (!group || group.teacher_id !== callerProfile.id) {
        return json({ error: "That group doesn't belong to you." }, 403);
      }
    }

    const { start, end } = periodRange(period, dateParam);

    const { data: group } = await sb.from("groups").select("id, name").eq("id", groupId).single();

    const { data: students } = await sb
      .from("profiles")
      .select("id, name")
      .eq("group_id", groupId)
      .eq("role", "student")
      .eq("active", true)
      .order("name");

    const base = { startDate: start, endDate: end, groupName: group?.name || null };

    if (!students || students.length === 0) {
      return json({ ...base, students: [], daily: {} });
    }
    const studentIds = students.map((s) => s.id);

    const { data: assignedRows } = await sb
      .from("homework_assignments")
      .select("homework_id, student_id")
      .in("student_id", studentIds);

    const allHomeworkIds = [...new Set((assignedRows || []).map((r) => r.homework_id))];

    let homeworks: any[] = [];
    if (allHomeworkIds.length > 0) {
      const { data } = await sb.from("homework").select("*").in("id", allHomeworkIds);
      homeworks = data || [];
    }

    const periodHomeworks = homeworks.filter((hw) => homeworkDueInRange(hw, start, end));
    const periodHwIds = periodHomeworks.map((h) => h.id);

    const assignedMap: Record<string, any[]> = {};
    for (const row of assignedRows || []) {
      const hw = periodHomeworks.find((h) => h.id === row.homework_id);
      if (!hw) continue;
      (assignedMap[row.student_id] ??= []).push(hw);
    }

    let submissions: any[] = [];
    let sessions: any[] = [];
    if (periodHwIds.length > 0) {
      const [subsRes, sessRes] = await Promise.all([
        sb.from("submissions").select("homework_id, student_id, type, submitted_at")
          .in("homework_id", periodHwIds).in("student_id", studentIds),
        sb.from("listening_sessions").select("homework_id, student_id, completed_at")
          .in("homework_id", periodHwIds).in("student_id", studentIds).eq("completed", true),
      ]);
      submissions = subsRes.data || [];
      sessions = sessRes.data || [];
    }

    const results = students.map((s) => {
      const { score, tieBreakAt } = scoreStudent(s.id, assignedMap[s.id] || [], submissions, sessions);
      return { id: s.id, name: s.name, score, tieBreakAt, isSelf: s.id === callerProfile.id };
    });

    results.sort((a, b) => {
      if (a.score === null && b.score === null) return 0;
      if (a.score === null) return 1;
      if (b.score === null) return -1;
      if (b.score !== a.score) return b.score - a.score;
      const at = a.tieBreakAt ? new Date(a.tieBreakAt).getTime() : Infinity;
      const bt = b.tieBreakAt ? new Date(b.tieBreakAt).getTime() : Infinity;
      return at - bt; // earlier finish wins the tie
    });

    let rank = 0, lastScore: number | null = null, lastTie: string | null = null;
    results.forEach((r, i) => {
      if (r.score === null) return;
      if (r.score !== lastScore || r.tieBreakAt !== lastTie) rank = i + 1;
      (r as any).rank = rank;
      lastScore = r.score;
      lastTie = r.tieBreakAt;
    });

    const studentsOut = results.map((r) => ({
      id: r.id,
      name: r.name,
      score: r.score,
      rank: (r as any).rank ?? null,
      isSelf: r.isSelf,
    }));

    // Trend: caller's own per-day score across the period, using homeworks
    // due on that exact date.
    const daily: Record<string, { date: string; score: number | null }[]> = {};
    const myHwByDay = eachDateInRange(start, end).map((d) => {
      const hwDueThatDay = homeworks.filter((hw) =>
        homeworkDueOn(hw, d) &&
        (assignedRows || []).some((r) => r.homework_id === hw.id && r.student_id === callerProfile.id)
      );
      const { score } = scoreStudent(callerProfile.id, hwDueThatDay, submissions, sessions);
      return { date: d, score: hwDueThatDay.length ? score : null };
    });
    daily[callerProfile.id] = myHwByDay;

    return json({ ...base, students: studentsOut, daily });
  } catch (e) {
    console.error(e);
    return json({ error: "Server error." }, 500);
  }
});
