// Connection check: says which services work. Never returns key values.
import { db, SB_URL, SB_ANON } from "../lib/server.js";
import { shopify } from "../lib/shopify.js";

const NEED_SCOPES = ["read_orders", "read_fulfillments", "read_customers", "write_orders", "write_draft_orders", "write_gift_cards"];
const run = async fn => { try { return await fn(); } catch (e) { return { ok: false, error: String(e.message || e).slice(0, 160) }; } };

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
    return { ok: true, kept: r.n, lastAt: r.last ? new Date(Number(r.last)).toISOString() : null }; });
  res.json({ inbox, supabase, shopify: shop, richpanel, returns, claude: { ok: !!process.env.ANTHROPIC_API_KEY }, inboundKey: { ok: !!process.env.SERVICE_INBOUND_KEY } });
}
