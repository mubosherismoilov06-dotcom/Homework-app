// Public, safe to expose in the browser (this is the "anon/publishable" key,
// database access is still locked down by the security rules we set up in Supabase).
const SUPABASE_URL = "https://wotrxllrtwgegavdudbe.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_2M8oCytMWpSW6dOVSMhUXQ_VOlBmHMm";

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Redirects to login if not signed in. Returns the user's profile (with role).
async function requireAuth() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { window.location.href = "/login.html"; return null; }
  const { data: profile } = await sb.from("profiles").select("*").eq("id", session.user.id).single();
  if (!profile || !profile.active) { await sb.auth.signOut(); window.location.href = "/login.html"; return null; }
  return profile;
}

async function requireTeacher() {
  const profile = await requireAuth();
  if (profile && profile.role !== "teacher") { window.location.href = "/student/"; return null; }
  return profile;
}

async function requireStudent() {
  const profile = await requireAuth();
  if (profile && profile.role !== "student") { window.location.href = "/teacher/"; return null; }
  return profile;
}

async function logout() {
  await sb.auth.signOut();
  window.location.href = "/login.html";
}

// Fetch a serverless function with the current session's access token attached.
// If the token has expired (common after a long-running action, e.g. bulk
// assigning homework to many students), a plain getSession() will still hand
// back the stale token and the function will reject it with 401. This helper
// refreshes the session and retries once before giving up, instead of just
// surfacing a confusing "not signed in" error for a user who's actually
// still logged in.
async function authedFetch(url, options = {}) {
  let { data: { session } } = await sb.auth.getSession();
  if (!session) { window.location.href = "/login.html"; return null; }

  const doFetch = (token) => fetch(url, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: 'Bearer ' + token }
  });

  let res = await doFetch(session.access_token);

  if (res.status === 401) {
    const { data: refreshed, error } = await sb.auth.refreshSession();
    if (error || !refreshed.session) { window.location.href = "/login.html"; return null; }
    res = await doFetch(refreshed.session.access_token);
  }

  return res;
}

// Students log in with a plain username; we map it to an internal email
// under the hood so Supabase Auth (which is email-based) still works.
function usernameToEmail(username) {
  return username.trim().toLowerCase() + "@students.homeworkapp.local";
}
