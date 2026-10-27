// Read-only access for Claude Code (reviewing Ella's drafts, reading Richpanel Returns). Locked with the same secret as /api/inbound.
// Nothing here writes to Shopify, Richpanel or Returns.
import crypto from "node:crypto";
import { db, init } from "../lib/server.js";

const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

async function returnsGql(query, variables) {
  const r = await fetch("https://returns-api.richpanel.com/graphql", { method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.RICHPANEL_RETURNS_API_KEY || "" }, body: JSON.stringify({ query, variables }) });
  return r.json().catch(() => ({ error: `Returns ${r.status}` }));
}

const OPS = {
  // Ella's drafts and what happened to them, newest first.
  async drafts({ limit = 50 }) {
    await init();
    const rows = await db()`select id, data from hub.docs where coll = 'svc_returns' and not deleted order by seq desc limit ${Math.min(+limit || 50, 200)}`;
    return rows.map(r => ({ id: r.id, ...r.data }));
  },
  // Richpanel Returns: read queries only.
  async returns({ query, variables }) {
    if (!/^\s*(query\b|\{)/.test(String(query || "")) || /\bmutation\b/i.test(query)) throw new Error("read-only: queries only");
    return returnsGql(query, variables);
  }
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const want = process.env.SERVICE_INBOUND_KEY, got = req.headers["x-co36-key"];
  if (!want || !got || !same(got, want)) return res.status(401).json({ error: "bad key" });
  const { op, ...args } = req.body || {};
  if (!OPS[op]) return res.status(400).json({ error: "unknown op" });
  try { res.json(await OPS[op](args)); } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
}
