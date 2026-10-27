// Stands in for Claude's page runtime (window.claude.use) on Vercel:
// db -> /api/db (Postgres), mcp -> /api/mcp (Shopify + Triple Whale), sample -> /api/chat (Claude API).
(() => {
  let resolveReady; const ready = new Promise(r => resolveReady = r);
  let getToken = async () => null, who = "";

  async function api(path, body) {
    const t = await getToken();
    const r = await fetch("/api/" + path, { method: "POST", headers: { "content-type": "application/json", ...(t ? { authorization: "Bearer " + t } : {}) }, body: JSON.stringify(body) });
    let j = {}; try { j = await r.json(); } catch (_) {}
    if (r.status === 401 && path !== "login") { try { if (localStorage.getItem("co36-service-session")) { localStorage.removeItem("co36-service-session"); location.reload(); } } catch (_) {} }
    if (!r.ok) { const e = new Error(j.error || r.statusText); e.code = j.code || (r.status === 401 ? "not_granted" : "tool_error"); e.text = j.error; throw e; }
    return j;
  }

  // ---------------- db ----------------
  const cache = {};            // coll -> Map(id -> data)
  const cursors = {};          // coll -> last seq seen
  const fired = new Set();     // colls whose first load has been delivered
  const listeners = new Set(); // {coll, id|null, cb}
  let polling = false, pollAgain = false, timer = null;
  const clone = v => v == null ? v : JSON.parse(JSON.stringify(v));
  const split = path => { const i = path.lastIndexOf("/"); return [path.slice(0, i), path.slice(i + 1)]; };

  function emit(L) {
    const m = cache[L.coll] || new Map();
    try {
      if (L.id != null) { const d = m.get(L.id); L.cb({ id: L.id, exists: d !== undefined, data: () => clone(d) }); }
      else { const docs = [...m.entries()].map(([id, d]) => ({ id, exists: true, data: () => clone(d) })); L.cb({ docs, size: docs.length, empty: !docs.length }); }
    } catch (e) { console.error(e); }
  }
  function notify(changed) { // changed: Map(coll -> Set(ids))
    listeners.forEach(L => {
      const ids = changed.get(L.coll); if (!ids) return;
      if (L.id == null || ids.has(L.id) || ids.has("*")) emit(L);
    });
  }
  function watch(coll) { if (!(coll in cursors)) { cursors[coll] = 0; cache[coll] ||= new Map(); poll(); } }

  async function poll() {
    if (polling) { pollAgain = true; return; }
    polling = true;
    try {
      let more = true;
      const changed = new Map();
      while (more) {
        const colls = Object.keys(cursors); if (!colls.length) break;
        const r = await api("db", { op: "poll", cursors });
        (r.rows || []).forEach(x => {
          const m = cache[x.coll] ||= new Map();
          if (x.deleted) m.delete(x.id); else m.set(x.id, x.data);
          if ((cursors[x.coll] || 0) < x.seq) cursors[x.coll] = x.seq;
          if (!changed.has(x.coll)) changed.set(x.coll, new Set()); changed.get(x.coll).add(x.id);
        });
        more = !!r.more;
      }
      Object.keys(cursors).forEach(c => { if (!fired.has(c)) { fired.add(c); changed.set(c, new Set(["*"])); } });
      notify(changed);
    } catch (e) { console.warn("sync", e); }
    polling = false;
    if (pollAgain) { pollAgain = false; poll(); }
  }
  function startLoop() { clearInterval(timer); timer = setInterval(() => { if (document.visibilityState === "visible") poll(); }, 5000); }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") poll(); });

  function local(coll, id, data) { // optimistic write so the page updates at once
    const m = cache[coll] ||= new Map();
    if (data === undefined) m.delete(id); else m.set(id, clone(data));
    queueMicrotask(() => notify(new Map([[coll, new Set([id])]])));
  }
  const whenLoaded = coll => new Promise(res => { watch(coll); if (fired.has(coll)) return res(); const L = { coll, id: null, cb: () => { listeners.delete(L); res(); } }; listeners.add(L); });

  function docRef(coll, id) {
    return {
      id, path: coll + "/" + id,
      async get() { await whenLoaded(coll); const d = cache[coll]?.get(id); return { id, exists: d !== undefined, data: () => clone(d) }; },
      async set(data) { local(coll, id, data); await api("db", { op: "set", coll, id, data }); },
      async update(data) { const cur = cache[coll]?.get(id) || {}; local(coll, id, { ...cur, ...data }); await api("db", { op: "update", coll, id, data }); },
      async delete() { local(coll, id, undefined); await api("db", { op: "delete", coll, id }); },
      onSnapshot(cb, err) { const L = { coll, id, cb }; listeners.add(L); watch(coll); if (fired.has(coll)) emit(L); return () => listeners.delete(L); }
    };
  }
  function collRef(coll) {
    const self = {
      doc: id => docRef(coll, id),
      limit: () => self, orderBy: () => self, where: () => self,
      async get() { await whenLoaded(coll); const docs = [...cache[coll].entries()].map(([id, d]) => ({ id, exists: true, data: () => clone(d) })); return { docs, size: docs.length, empty: !docs.length }; },
      onSnapshot(cb, err) { const L = { coll, id: null, cb }; listeners.add(L); watch(coll); if (fired.has(coll)) emit(L); return () => listeners.delete(L); }
    };
    return self;
  }
  const db = { doc: p => { const [c, i] = split(p); return docRef(c, i); }, collection: c => collRef(c) };

  // ---------------- mcp ----------------
  const mcp = { async callTool(server, tool, args) { const r = await api("mcp", { server, tool, args }); return { payload: r.payload }; } };

  // ---------------- sample (chat with tools) ----------------
  async function sample(input, opts = {}) {
    const tools = opts.tools || [];
    const byName = Object.fromEntries(tools.map(t => [t.name, t]));
    let messages = typeof input === "string" ? [{ role: "user", content: input }] : input.map(m => ({ role: m.role, content: m.content }));
    let text = "";
    for (let round = 0; round < 10; round++) {
      const r = await api("chat", { messages, tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema || t.input_schema || { type: "object", properties: {} } })) });
      const blocks = r.content || [];
      const t = blocks.filter(b => b.type === "text").map(b => b.text).join("");
      if (t) { text = text ? text + "\n" + t : t; opts.onText && opts.onText({ text, delta: t }); }
      if (r.stop_reason !== "tool_use") break;
      const results = [];
      for (const b of blocks.filter(b => b.type === "tool_use")) {
        try { const out = await byName[b.name].execute(b.input || {}); results.push({ type: "tool_result", tool_use_id: b.id, content: JSON.stringify(out ?? null) }); }
        catch (e) { results.push({ type: "tool_result", tool_use_id: b.id, content: String(e?.message || e), is_error: true }); }
      }
      messages = [...messages, { role: "assistant", content: blocks }, { role: "user", content: results }];
    }
    return { text, truncated: false };
  }
  sample.json = async (input, opts) => { const r = await sample(input, opts); const m = r.text.match(/[\[{][\s\S]*[\]}]/); return JSON.parse(m ? m[0] : r.text); };

  // ---------------- downloads / user ----------------
  const downloads = { async save({ filename, data }) { const b = data instanceof Blob ? data : new Blob([data]); const u = URL.createObjectURL(b); const a = document.createElement("a"); a.href = u; a.download = filename || "download"; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 4000); } };
  const user = { async canEdit() { return true; }, async email() { return who; } };

  const ns = { db, mcp, sample, downloads, user, api: { post: api } };
  window.claude = { use: async name => { await ready; return ns[name] ?? null; } };

  // ---------------- sign-in (Supabase Auth, invite-only) ----------------
  async function boot() {
    const cfg = await fetch("/api/config").then(r => r.json());
    if (cfg.devNoAuth) { resolveReady(); startLoop(); return; }
    if (cfg.passwordLogin) return passwordBoot();
    if (!cfg.supabaseUrl || !cfg.supabaseKey) throw new Error("Supabase keys missing");
    await new Promise((res, rej) => { const s = document.createElement("script"); s.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
    const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
    let { data: { session } } = await sb.auth.getSession();
    if (!session) {
      const o = document.createElement("div");
      o.style.cssText = "position:fixed;inset:0;z-index:9999;background:#F7F7F9;display:grid;place-items:center;font-family:Inter,system-ui,sans-serif;padding:16px";
      o.innerHTML = `<form id="co36-in" style="width:min(360px,100%);background:#fff;border:1px solid #ECECF0;border-radius:20px;padding:28px;display:grid;gap:14px;box-shadow:0 8px 30px rgba(16,16,40,.06)">
        <div style="font-weight:800;font-size:22px">CO36 Service</div>
        <div style="font-size:13.5px;color:#6E6E7A">Invite only. Sign in with the email and password David gave you.</div>
        <input id="co36-em" type="email" required autocomplete="username" placeholder="you@cothirtysix.com" style="border:1px solid #ECECF0;border-radius:12px;padding:11px 13px;font-size:15px">
        <input id="co36-pw" type="password" autocomplete="current-password" placeholder="Password" style="border:1px solid #ECECF0;border-radius:12px;padding:11px 13px;font-size:15px">
        <button style="border:0;background:#5B5BF6;color:#fff;border-radius:99px;padding:11px;font-weight:700;font-size:14px;cursor:pointer">Sign in</button>
        <a id="co36-link" href="#" style="font-size:12.5px;color:#6E6E7A;text-align:center">Email me a sign-in link instead</a>
        <div id="co36-msg" style="font-size:13px;color:#6E6E7A;min-height:18px"></div></form>`;
      document.body.appendChild(o);
      const em = () => document.getElementById("co36-em").value.trim(), m = document.getElementById("co36-msg");
      const show = (error, ok) => { m.style.color = error ? "#EF4444" : "#16A34A"; m.textContent = error ? (/signups? not allowed|not found|otp_disabled/i.test(error.message) ? "That email isn't invited yet. Ask David for an invite." : /invalid login/i.test(error.message) ? "Wrong email or password." : error.message) : ok; };
      document.getElementById("co36-in").onsubmit = async e => {
        e.preventDefault(); const pw = document.getElementById("co36-pw").value;
        if (!pw) { m.style.color = "#EF4444"; m.textContent = "Enter your password."; return; }
        m.style.color = "#6E6E7A"; m.textContent = "Signing in…";
        const { error } = await sb.auth.signInWithPassword({ email: em(), password: pw });
        show(error, "Signed in.");
      };
      document.getElementById("co36-link").onclick = async e => {
        e.preventDefault(); if (!em()) { m.style.color = "#EF4444"; m.textContent = "Enter your email first."; return; }
        m.style.color = "#6E6E7A"; m.textContent = "Sending…";
        const { error } = await sb.auth.signInWithOtp({ email: em(), options: { shouldCreateUser: false, emailRedirectTo: location.origin + location.pathname } });
        show(error, "Check your email for the sign-in link.");
      };
      sb.auth.onAuthStateChange((ev, s) => { if (s) location.reload(); });
      return;
    }
    getToken = async () => (await sb.auth.getSession()).data.session?.access_token || null;
    who = session.user?.email || "";
    const out = document.createElement("button");
    out.textContent = "Sign out"; out.title = session.user?.email || "";
    out.style.cssText = "position:fixed;left:16px;bottom:16px;z-index:50;border:1px solid #ECECF0;background:#fff;border-radius:99px;padding:6px 12px;font:12px Inter,system-ui,sans-serif;color:#6E6E7A;cursor:pointer";
    out.onclick = async () => { await sb.auth.signOut(); location.reload(); };
    document.body.appendChild(out);
    resolveReady(); startLoop();
  }
  // The hub's own sign-in (one password set in Vercel). Remembered in this browser for 60 days.
  async function passwordBoot() {
    const KEY = "co36-service-session";
    let saved = null; try { saved = JSON.parse(localStorage.getItem(KEY) || "null"); } catch (_) {}
    if (!saved?.token) {
      const o = document.createElement("div");
      o.style.cssText = "position:fixed;inset:0;z-index:9999;background:#F7F7F9;display:grid;place-items:center;font-family:Inter,system-ui,sans-serif;padding:16px";
      o.innerHTML = `<form id="co36-in" style="width:min(360px,100%);background:#fff;border:1px solid #ECECF0;border-radius:20px;padding:28px;display:grid;gap:14px;box-shadow:0 8px 30px rgba(16,16,40,.06)">
        <div style="font-weight:800;font-size:22px">CO36 Service</div>
        <div style="font-size:13.5px;color:#6E6E7A">Sign in with your email and password.</div>
        <input id="co36-em" type="email" required autocomplete="username" placeholder="you@cothirtysix.com" style="border:1px solid #ECECF0;border-radius:12px;padding:11px 13px;font-size:15px">
        <input id="co36-pw" type="password" required autocomplete="current-password" placeholder="Password" style="border:1px solid #ECECF0;border-radius:12px;padding:11px 13px;font-size:15px">
        <button style="border:0;background:#5B5BF6;color:#fff;border-radius:99px;padding:11px;font-weight:700;font-size:14px;cursor:pointer">Sign in</button>
        <div id="co36-msg" style="font-size:13px;color:#6E6E7A;min-height:18px"></div></form>`;
      document.body.appendChild(o);
      const m = document.getElementById("co36-msg");
      document.getElementById("co36-in").onsubmit = async e => {
        e.preventDefault(); m.style.color = "#6E6E7A"; m.textContent = "Signing in…";
        const r = await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: document.getElementById("co36-em").value, password: document.getElementById("co36-pw").value }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { m.style.color = "#EF4444"; m.textContent = j.error || "Couldn't sign in."; return; }
        try { localStorage.setItem(KEY, JSON.stringify(j)); } catch (_) {}
        location.reload();
      };
      return;
    }
    getToken = async () => saved.token; who = saved.email || "";
    // Teammates only see the pages David gave them; anything else sends them to their first page.
    const page = (location.pathname.match(/\/(\w+)\.html$/) || [])[1] || "index";
    if (saved.role === "member") {
      const pages = saved.pages || [];
      if (!pages.includes(page)) { location.replace(`/${pages[0] || "returns"}.html`); return; }
      const hide = () => document.querySelectorAll("a[href]").forEach(a => { const m = a.getAttribute("href").match(/^\/(\w+)\.html/); if (m && !pages.includes(m[1])) a.style.display = "none"; });
      hide(); new MutationObserver(hide).observe(document.body, { childList: true, subtree: true });
    } else if (page !== "team") {
      const t = document.createElement("a"); t.href = "/team.html"; t.textContent = "Team";
      t.style.cssText = "position:fixed;left:100px;bottom:16px;z-index:50;border:1px solid #ECECF0;background:#fff;border-radius:99px;padding:6px 12px;font:12px Inter,system-ui,sans-serif;color:#6E6E7A;text-decoration:none";
      document.body.appendChild(t);
    }
    const out = document.createElement("button");
    out.textContent = "Sign out"; out.title = who;
    out.style.cssText = "position:fixed;left:16px;bottom:16px;z-index:50;border:1px solid #ECECF0;background:#fff;border-radius:99px;padding:6px 12px;font:12px Inter,system-ui,sans-serif;color:#6E6E7A;cursor:pointer";
    out.onclick = () => { try { localStorage.removeItem(KEY); } catch (_) {} location.reload(); };
    document.body.appendChild(out);
    resolveReady(); startLoop();
  }
  const go = () => boot().catch(e => { console.error(e); document.body.insertAdjacentHTML("afterbegin", '<div style="padding:12px 16px;background:#FDECEC;color:#B91C1C;font:14px system-ui">Sign-in failed to load. Check the Supabase keys in Vercel settings.</div>'); });
  document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", go) : go();
})();
