// Connection check: says which services work. Never returns key values.
import { db, SB_URL, SB_ANON } from "../lib/server.js";
import { shopify } from "../lib/shopify.js";
import { AUTOPILOT } from "../lib/autopilot.js";
import { findOrders } from "../lib/ella.js";

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
    // Sent per day (New York time), split: replies to customer emails vs after-return follow-ups, and who sent.
    const perDay = await db()`select to_char(to_timestamp((data->>'sentAt')::bigint / 1000) at time zone 'America/New_York', 'YYYY-MM-DD') as d,
      case when id like 'qc-%' then 'followup' else 'reply' end as k, coalesce(data->>'sentBy', '?') as by, count(*)::int as n
      from hub.docs where coll = 'svc_returns' and not deleted and data->>'status' = 'sent' and data->>'sentAt' is not null group by 1,2,3 order by 1`;
    // Why today's drafts didn't go out (counts only).
    const why = await db()`select case when id like 'qc-%' then 'after-return follow-up (switched off)'
        when data->>'handedAt' is not null then 'held → Michelle: ' || coalesce(data->'flags'->>0, 'vip')
        when data->>'sarahAt' is not null then 'someone else answered: ' || coalesce(data->>'answeredBy', data->>'autoSkipped', '?')
        when jsonb_array_length(coalesce(data->'flags', '[]'::jsonb)) > 0 then 'flagged, not handed: ' || (data->'flags'->>0)
        when data->>'intent' not in ('return', 'exchange') then 'intent: ' || coalesce(data->>'intent', '?')
        when data->>'vip' = 'true' then 'vip'
        else 'clean draft (should send)' end as reason, count(*)::int as n
      from hub.docs where coll = 'svc_returns' and not deleted and data->>'status' in ('draft', 'drafting', 'error')
      and coalesce((data->>'lastAt')::bigint, (data->>'receivedAt')::bigint, 0) > ${Date.now() - 36 * 3600e3} group by 1 order by 2 desc`;
    // Coverage: every conversation the safety net judged a return/exchange ask must have an outcome in the hub.
    const cov = await db()`select count(*)::int as asks, count(r.id)::int as handled,
        count(*) filter (where r.id is null)::int as missing, array_agg(substr(s.id, 2)) filter (where r.id is null) as missing_nos,
        count(*) filter (where r.data->>'status' = 'sent')::int as sent, count(*) filter (where r.data->>'handedAt' is not null)::int as to_michelle,
        count(*) filter (where r.data->>'sarahAt' is not null)::int as team_answered
      from hub.docs s left join hub.docs r on r.coll = 'svc_returns' and r.id = s.id and not r.deleted
      where s.coll = 'svc_seen' and not s.deleted and s.data->>'checkedYes' = 'true' and s.seq > 0`;
    return { ok: true, coverage: cov[0], why, perDay, notes: nt, byStatus: Object.fromEntries(rows.map(r => [r.st, r.n])), lastAt: rows.reduce((m, r) => Math.max(m, Number(r.last) || 0), 0) || null }; });
  const afterqc = await run(async () => { const [r] = await db()`select data from hub.docs where coll = 'svc_meta' and id = 'afterqc'`;
    const [n] = await db()`select count(*)::int as c from hub.docs where coll = 'svc_returns' and id like 'qc-%' and not deleted`; const k = await db()`select data->>'kind' as kind, data->>'status' as status, (data->>'ticketId' is not null) as thread, (data->>'refundNotifiedAt' is not null) as told, coalesce(data->>'refundNoted', '') as noted, count(*)::int as c from hub.docs where coll = 'svc_returns' and id like 'qc-%' and not deleted group by 1,2,3,4,5`;
    const [q] = await db()`select data from hub.docs where coll = 'svc_meta' and id = 'qcscan'`; const [e4] = await db()`select data from hub.docs where coll = 'svc_meta' and id = 'inbound400'`;
    const [t] = await db()`select count(*)::int as c from hub.docs where coll = 'svc_qcthread' and not deleted`;
    const miss = await db()`select d.data->'orders'->>0 as o, d.data->>'refundNotifiedAt' as at, exists(select 1 from hub.docs x where x.coll = 'svc_qcthread' and x.id = replace(d.data->'orders'->>0, '#', '')) as has
      from hub.docs d where d.coll = 'svc_returns' and d.id like 'qc-%' and not d.deleted and d.data->>'ticketId' is null and d.data->>'status' = 'draft'`;
    return { last: r?.data || null, docs: n.c, kinds: k, scan: q?.data || null, inbound400: e4?.data || null, threads: t.c, missing: miss.map(m => ({ order: String(m.o || "").slice(0, 3) + "…", has: m.has, at: m.at })) }; });
  const ap = await run(async () => { const r = await db()`select data from hub.docs where coll = 'svc_meta' and id = 'autopilot'`;
    return { ok: true, on: AUTOPILOT.on, until: AUTOPILOT.until, pausedOnBoard: !!r[0]?.data?.off, afterQcAuto: !!r[0]?.data?.afterQcAuto, setBy: r[0]?.data?.by ? "someone" : null, setAt: r[0]?.data?.at || null, live: AUTOPILOT.on && Date.now() < Date.parse(AUTOPILOT.until) && !r[0]?.data?.off }; });
  // Ella's order lookup on a known recent order (result: found or the error, no customer data).
  const lookup = await run(async () => { const o = await findOrders("order 134648", null); return { ok: o.length > 0, found: o.length, hasItems: !!o[0]?.lineItems?.nodes?.length }; });
  // Richpanel Returns field names (schema only, no customer data) — used to map the Returns board.
  const returnsSchema = req.query?.schema ? await run(async () => {
    const q = async t => { const r = await fetch("https://returns-api.richpanel.com/graphql", { method: "POST", headers: { "content-type": "application/json", "x-api-key": process.env.RICHPANEL_RETURNS_API_KEY || "" },
      body: JSON.stringify({ query: `query($t:String!){ __type(name:$t){ name fields { name type { name kind ofType { name kind ofType { name kind } } } } enumValues { name } } }`, variables: { t } }) });
      const j = await r.json().catch(() => ({})); const T = j.data?.__type; if (!T) return j.errors ? JSON.stringify(j.errors).slice(0, 120) : null;
      return T.enumValues ? T.enumValues.map(e => e.name) : T.fields.map(f => `${f.name}:${f.type.name || f.type.ofType?.name || f.type.ofType?.ofType?.name}`); };
    const names = String(req.query.schema).split(",").slice(0, 8);
    return Object.fromEntries(await Promise.all(names.map(async n => [n, await q(n)])));
  }) : undefined;
  // Which return fields exist (introspection is off): try each one, report ok / error text only.
  const returnsProbe = req.query?.probe ? await run(async () => {
    const fields = String(req.query.probe).split(",").slice(0, 25).filter(f => /^[A-Za-z_][\w{} ]*$/.test(f));
    const out = {};
    await Promise.all(fields.map(async f => { const r = await fetch("https://returns-api.richpanel.com/graphql", { method: "POST", headers: { "content-type": "application/json", "x-api-key": process.env.RICHPANEL_RETURNS_API_KEY || "" },
      body: JSON.stringify({ query: `query{ getAllReturns(query:{ limit: 1 }){ returns { ${f} } } }` }) });
      const j = await r.json().catch(() => ({})); out[f] = j.errors ? String(j.errors[0]?.message || "error").slice(0, 140) : "ok"; }));
    return out;
  }) : undefined;
  // ?conv=12345 → what the hub did with one conversation (statuses and flags only, no message text).
  const conv = /^\d{3,7}$/.test(String(req.query?.conv || "")) ? await run(async () => {
    const id = "n" + req.query.conv, g = async c => (await db()`select data from hub.docs where coll = ${c} and id = ${id}`)[0]?.data || null;
    const r = await g("svc_returns"), seen = await g("svc_seen"), inb = await g("svc_inbox");
    return { returns: r && { status: r.status, intent: r.intent, flags: r.flags, error: r.error, sarahAt: !!r.sarahAt, answeredBy: r.answeredBy, sentBy: r.sentBy, receivedAt: r.receivedAt, notedAt: r.notedAt, autoSkipped: r.autoSkipped, autoError: r.autoError, handedAt: r.handedAt, handedOk: r.handedOk, lastAt: r.lastAt }, seen: !!seen, read: seen?.read || null, inbox: inb && { mood: inb.mood } };
  }) : undefined;
  // ?reader=1 → one tiny call to the fast model the inbox reader uses, error text only.
  const reader = req.query?.reader ? await run(async () => {
    const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY || "", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: process.env.ANTHROPIC_FAST_MODEL || "claude-haiku-5-5", max_tokens: 20, messages: [{ role: "user", content: "Say ok" }] }) });
    const j = await r.json().catch(() => ({})); return { status: r.status, model: process.env.ANTHROPIC_FAST_MODEL || "claude-haiku-5-5", error: j.error?.message?.slice(0, 200) || null, text: (j.content || []).map(b => b.text).join("").slice(0, 40) };
  }) : undefined;
  res.json({ reader, conv, returnsProbe, returnsSchema, ellaLookup: lookup, autopilot: ap, afterqc, returns_lane, scan, inbox, supabase, shopify: shop, richpanel, returns, claude: { ok: !!process.env.ANTHROPIC_API_KEY }, inboundKey: { ok: !!process.env.SERVICE_INBOUND_KEY } });
}
