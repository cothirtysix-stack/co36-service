// Team page: David adds or removes teammates and picks which pages each one can open. Owner only.
import crypto from "node:crypto";
import { db, init, wrap, putDoc, getDoc, hashPw } from "../lib/server.js";

const PAGES = ["home", "returns", "fulfillment"];
const newPw = () => crypto.randomBytes(9).toString("base64url");
const clean = e => String(e || "").trim().toLowerCase();

export default wrap(async (req, res, who) => {
  if (who.role === "member") return res.status(403).json({ error: "Only David can manage the team." });
  const b = req.body || {}, email = clean(b.email);
  const pages = (Array.isArray(b.pages) ? b.pages : []).filter(p => PAGES.includes(p));
  if (b.op === "list") {
    await init();
    const rows = await db()`select id, data from hub.docs where coll = 'svc_users' and not deleted order by seq desc`;
    return res.json(rows.map(r => ({ email: r.id, name: r.data.name || "", pages: r.data.pages || [], disabled: !!r.data.disabled, addedAt: r.data.addedAt })));
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "Enter a valid email." });
  if (b.op === "add") {
    if (!pages.length) return res.status(400).json({ error: "Pick at least one page." });
    if (await getDoc("svc_users", email)) return res.status(400).json({ error: "That person is already on the team." });
    const password = newPw();
    await putDoc("svc_users", email, { name: String(b.name || "").slice(0, 60), pages, hash: hashPw(password), since: Date.now(), addedAt: new Date().toISOString(), addedBy: who.email });
    return res.json({ ok: true, password });
  }
  const u = await getDoc("svc_users", email);
  if (!u) return res.status(404).json({ error: "Not on the team." });
  if (b.op === "pages") { if (!pages.length) return res.status(400).json({ error: "Pick at least one page." }); await putDoc("svc_users", email, { pages }, true); return res.json({ ok: true }); }
  if (b.op === "reset") { const password = newPw(); await putDoc("svc_users", email, { hash: hashPw(password), since: Date.now() }, true); return res.json({ ok: true, password }); }
  if (b.op === "remove") { await init(); await db()`update hub.docs set data = null, deleted = true, seq = nextval('hub.docs_seq') where coll = 'svc_users' and id = ${email}`; return res.json({ ok: true }); }
  res.status(400).json({ error: "bad op" });
});
