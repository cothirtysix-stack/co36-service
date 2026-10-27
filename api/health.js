// Connection check: says which services work. Never returns key values.
import { db, SB_URL, SB_ANON } from "../lib/server.js";
import { shopify } from "../lib/shopify.js";
import { AUTOPILOT } from "../lib/autopilot.js";

const NEED_SCOPES = ["read_orders", "read_fulfillments", "read_customers", "write_orders", "write_draft_orders", "write_gift_cards"];
const run = async fn => { try { return await Promise.race([fn(), new Promise((_, no) => setTimeout(() => no(new Error("timed out after 8s")), 8000))]); } catch (e) { return { ok: false, error: String(e.message || e).slice(0, 160) }; } };

export default async function handler(req, res) {
  res.setHeader("cache-control", "no-store");
  const [supabase, shop, richpanel, returns] = await Promise.all([
    run(async () => { if (!SB_URL() || !SB_ANON()) return { ok: false, error: "Supabase URL or key missing" }; await db()`select 1`; return { ok: true }; }),
    run(async () => {
      const j = await shopify(`{ shop { name } currentAppInstallation { accessScopes { handle } } }`);
      if (j.errors) return { ok: false, error: JSON.stringify(j.errors).slice(0, 160) };
      const have = (j.data.currentAppInstallation?.accessScopes || []).map(s => s.handle);
      // write_* includes the matching read_*
      const missing = NEED_SCOPES.filter(s => !have.includes(s) && !have.includes(s.replace(/^read_/, "write_")));
      return { ok: true, store: j.data.shop.name, missing };
    }),
    run(async () => {
      if (!process.env.RICHPANEL_API_KEY) return { ok: false, error: "RICHPANEL_API_KEY missing" };
      const r = await fetch("https://api.richpanel.com/v1/teams", { headers: { "x-richpanel-key": process.env.RICHPANEL_API_KEY } });
      return r.ok ? { ok: true } : { ok: false, error: `Richpanel said ${r.status}` };
    }),
    run(async () => {
      if (!process.env.RICHPANEL_RETURNS_API_KEY) return { ok: false, error: "RICHPANEL_RETURNS_API_KEY missing" };
      const r = await fetch("https://returns-api.richpanel.com/graphql", { method: "POST", headers: { "content-type": "application/json", "x-api-key": process.env.RICHPANEL_RETURNS_API_KEY },
        body: JSON.stringify({ query: "query { getReturnsStatusCounts { OPEN MANUAL_REVIEW } }" }) });
      const j = await r.json().catch(() => ({}));
      const c = j.data?.getReturnsStatusCounts;
      return c ? { ok: true, open: c.OPEN, manualReview: c.MANUAL_REVIEW } : { ok: false, error: `Returns said ${r.status}: ${JSON.stringify(j.errors || j).slice(0, 120)}` };
    })
  ]);
  const inbox = await run(async () => { const [r] = await db()`select count(*)::int as n, max((data->>'lastAt')::bigint) as last from hub.docs where coll = 'svc_inbox' and not deleted`;
    const meta = await db()`select data from hub.docs where coll = 'svc_meta' and id = 'inbound'`;
    return { ok: true, received: meta[0]?.data || null, kept: r.n, lastAt: r.last ? new Date(Number(r.last)).toISOString() : null }; });
  const scan = await run(async () => { const rows = await db()`select id, data from hub.docs where coll = 'svc_fix' and not deleted`;
    const by = Object.fromEntries(rows.map(r => [r.id, r.data]));
    return { ok: true, scan: by.scan || null, latest: by.latest ? { at: by.latest.at, problems: by.latest.problems?.length, notShipped: by.latest.notShipped?.count } : null }; });
  const returns_lane = await run(async () => { const rows = await db()`select data->>'status' as st, count(*)::int as n, max((data->>'receivedAt')::bigint) as last from hub.docs where coll = 'svc_returns' and not deleted group by 1`;
    const [nt] = await db()`select count(*) filter (where data->>'notedAt' is not null and data->>'noteError' is null)::int as noted, count(*) filter (where data->>'noteError' is not null)::int as failed, max(data->>'noteError') as err,
      count(*) filter (where data->>'number' is not null)::int as withNumber from hub.docs where coll = 'svc_returns' and not deleted`;
    return { ok: true, notes: nt, byStatus: Object.fromEntries(rows.map(r => [r.st, r.n])), lastAt: rows.reduce((m, r) => Math.max(m, Number(r.last) || 0), 0) || null }; });
  const ap = await run(async () => { const r = await db()`select data from hub.docs where coll = 'svc_meta' and id = 'autopilot'`;
    return { ok: true, on: AUTOPILOT.on, until: AUTOPILOT.until, pausedOnBoard: !!r[0]?.data?.off, live: AUTOPILOT.on && Date.now() < Date.parse(AUTOPILOT.until) && !r[0]?.data?.off }; });
  res.json({ autopilot: ap, returns_lane, scan, inbox, supabase, shopify: shop, richpanel, returns, claude: { ok: !!process.env.ANTHROPIC_API_KEY }, inboundKey: { ok: !!process.env.SERVICE_INBOUND_KEY } });
}
