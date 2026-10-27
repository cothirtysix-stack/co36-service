import { db, init, wrap } from "../lib/server.js";
const CAP = 3_000_000;
const ok = s => typeof s === "string" && /^[A-Za-z0-9_\-.~:@+\/]{1,300}$/.test(s);
// The Service Hub shares a database with CO36 HQ: only service collections (svc_*) are reachable from here.
const svc = c => ok(c) && /^svc_/.test(c) && c !== "svc_users"; // logins are only reachable through /api/team
export default wrap(async (req, res) => {
  await init();
  const s = db(), b = req.body || {};
  if (b.op === "poll") {
    const c = Object.entries(b.cursors || {}).filter(([k]) => svc(k));
    if (!c.length) return res.json({ rows: [], more: false });
    const rows = await s`select d.coll, d.id, d.data, d.deleted, d.seq from hub.docs d
      join unnest(${c.map(x => x[0])}::text[], ${c.map(x => Number(x[1]) || 0)}::bigint[]) as w(c, since)
      on d.coll = w.c and d.seq > w.since order by d.seq limit 500`;
    const out = []; let bytes = 0;
    for (const r of rows) { bytes += JSON.stringify(r.data || "").length; out.push({ coll: r.coll, id: r.id, data: r.data, deleted: r.deleted, seq: Number(r.seq) }); if (bytes > CAP) break; }
    return res.json({ rows: out, more: out.length < rows.length || rows.length === 500 });
  }
  if (!svc(b.coll) || !ok(b.id)) return res.status(403).json({ error: "not allowed" });
  if (b.op === "set") {
    await s`insert into hub.docs (coll, id, data) values (${b.coll}, ${b.id}, ${s.json(b.data ?? {})})
      on conflict (coll, id) do update set data = excluded.data, deleted = false, seq = nextval('hub.docs_seq')`;
  } else if (b.op === "update") {
    await s`insert into hub.docs as d (coll, id, data) values (${b.coll}, ${b.id}, ${s.json(b.data ?? {})})
      on conflict (coll, id) do update set data = coalesce(d.data, '{}'::jsonb) || excluded.data, deleted = false, seq = nextval('hub.docs_seq')`;
  } else if (b.op === "delete") {
    await s`update hub.docs set data = null, deleted = true, seq = nextval('hub.docs_seq') where coll = ${b.coll} and id = ${b.id}`;
  } else return res.status(400).json({ error: "bad op" });
  res.json({ ok: true });
});
