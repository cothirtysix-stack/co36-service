import postgres from "postgres";

const env = (...k) => k.map(x => process.env[x]).find(Boolean) || "";
export const SB_URL = () => env("SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL").replace(/\/$/, "");
export const SB_ANON = () => env("SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEY", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");

let sql, inited;
export function db() {
  const url = env("DATABASE_URL", "POSTGRES_URL");
  if (!url) throw Object.assign(new Error("DATABASE_URL is not set in Vercel"), { status: 500 });
  sql ||= postgres(url, { ssl: url.includes("localhost") ? false : "require", max: 1, prepare: false, idle_timeout: 20, onnotice: () => {} });
  return sql;
}
// Data lives in a private "hub" schema: not exposed through Supabase's public API, row security on.
export async function init() {
  if (inited) return;
  const s = db();
  await s`create schema if not exists hub`;
  await s`create sequence if not exists hub.docs_seq`;
  await s`create table if not exists hub.docs (coll text not null, id text not null, data jsonb, deleted boolean not null default false, seq bigint not null default nextval('hub.docs_seq'), primary key (coll, id))`;
  await s`create index if not exists docs_coll_seq on hub.docs (coll, seq)`;
  await s`alter table hub.docs enable row level security`;
  inited = true;
}

// Server-side writes into the same store the page polls (merge = keep existing fields).
export async function putDoc(coll, id, data, merge = false) {
  await init(); const s = db();
  if (merge) await s`insert into hub.docs as d (coll, id, data) values (${coll}, ${id}, ${s.json(data)})
    on conflict (coll, id) do update set data = coalesce(d.data, '{}'::jsonb) || excluded.data, deleted = false, seq = nextval('hub.docs_seq')`;
  else await s`insert into hub.docs (coll, id, data) values (${coll}, ${id}, ${s.json(data)})
    on conflict (coll, id) do update set data = excluded.data, deleted = false, seq = nextval('hub.docs_seq')`;
}
export async function getDoc(coll, id) {
  await init(); const [r] = await db()`select data from hub.docs where coll = ${coll} and id = ${id} and not deleted`;
  return r?.data ?? null;
}

// Sign-in is Supabase Auth. Sign-ups are off in Supabase, so only people you invite can get a session.
const seen = new Map();
export async function auth(req, res) {
  if (process.env.DEV_NO_AUTH === "1" && !process.env.VERCEL) return { email: "dev" };
  const h = req.headers.authorization || "", token = h.startsWith("Bearer ") ? h.slice(7) : "";
  const fail = (code, msg) => { res.status(code).json({ error: msg, code: "not_granted" }); return null; };
  if (!token) return fail(401, "Please sign in.");
  const hit = seen.get(token); let user = hit && hit.exp > Date.now() ? hit.user : null;
  if (!user) {
    const r = await fetch(`${SB_URL()}/auth/v1/user`, { headers: { apikey: SB_ANON(), authorization: `Bearer ${token}` } });
    if (!r.ok) return fail(401, "Please sign in again.");
    user = await r.json(); seen.set(token, { user, exp: Date.now() + 5 * 60e3 });
    if (seen.size > 500) seen.clear();
  }
  const allow = env("ALLOWED_EMAILS").toLowerCase().split(/[\s,]+/).filter(Boolean);
  if (allow.length && !allow.includes(String(user.email || "").toLowerCase())) return fail(403, "Your account isn't on the invite list.");
  return user;
}
export function wrap(fn) {
  return async (req, res) => {
    if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
    try { const who = await auth(req, res); if (!who) return; await fn(req, res, who); }
    catch (e) { console.error(e); res.status(e.status || 500).json({ error: e.message || "Server error", code: e.code || "tool_error" }); }
  };
}
