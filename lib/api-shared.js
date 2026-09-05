// Shared helpers used by every function in /api.
// Adapted from the original Cloudflare Pages Functions version:
// env vars now come from `process.env` (set in Vercel project settings)
// instead of `context.env`. The Request/Response handling is otherwise
// identical, since Vercel Edge Functions use the same Web-standard APIs
// Cloudflare Workers do.

export function respond(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

export function sbFetchFactory(SUPABASE_URL, SERVICE_KEY) {
  return async function sbFetch(path, opts = {}) {
    const r = await fetch(`${SUPABASE_URL}${path}`, {
      ...opts,
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
        ...(opts.headers || {})
      }
    });
    const text = await r.text();
    const data = text ? JSON.parse(text) : null;
    if (!r.ok) throw new Error((data && (data.message || data.msg)) || 'Supabase error');
    return data;
  };
}

export async function getCallerUser(SUPABASE_URL, SERVICE_KEY, token) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` }
  });
  return res.json();
}
