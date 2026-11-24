// Saved = real exchanges only (David, Nov 23: "did you add these to the columns?" — 3 of Ella's 5 "saves" were customers who
// only mentioned an exchange, or said no). A refund → exchange switch counts once Shopify has the exchange order
// (EXC-<order>-R1, made by the returns portal), created after they first asked for the refund.
import { db, init, putDoc } from "./server.js";
import { shopify } from "./shopify.js";
import { countSave } from "./offertest.js";

export async function verifySaves(limit = 8) {
  await init();
  const rows = await db()`select id, data from hub.docs where coll = 'svc_returns' and not deleted and data->>'saveClaimAt' is not null and data->>'savedAt' is null
    and (data->>'saveClaimAt')::bigint > ${Date.now() - 21 * 864e5} and coalesce((data->>'saveCheckAt')::bigint, 0) < ${Date.now() - 2 * 3600e3}
    order by (data->>'saveClaimAt')::bigint desc limit ${limit}`;
  let found = 0;
  for (const { id, data: r } of rows) {
    const nums = [...new Set([...(r.orders || []), r.exchange?.order, ...(String(r.message || "").match(/\b1\d{5}\b/g) || [])].filter(Boolean).map(n => String(n).replace(/\D/g, "")).filter(n => n.length >= 5))].slice(0, 3);
    if (!nums.length) { await putDoc("svc_returns", id, { saveCheckAt: Date.now() }, true); continue; }
    const j = await shopify(`query($q:String){ orders(first: 5, query: $q){ nodes { name createdAt } } }`, { q: nums.map(n => `name:EXC-${n}*`).join(" OR ") }).catch(() => null);
    const start = Number(r.receivedAt) || Number(r.saveClaimAt) - 7 * 864e5;
    const hit = (j?.data?.orders?.nodes || []).find(o => Date.parse(o.createdAt) > start - 864e5);
    if (!hit) { await putDoc("svc_returns", id, { saveCheckAt: Date.now() }, true); continue; }
    await putDoc("svc_returns", id, { savedAt: Date.parse(hit.createdAt), savedVerified: hit.name }, true); found++;
    if (r.offerVariant && r.offerCounted && !r.offerSaved) { await countSave(r.offerVariant); await putDoc("svc_returns", id, { offerSaved: Date.now() }, true); }
  }
  return { checked: rows.length, found };
}

// One time: the old "saves" (counted on words) go back to being claims until Shopify shows the exchange; A/B counts start over.
export async function resetSaves1123() {
  await init();
  await db()`update hub.docs set data = data || jsonb_build_object('saveClaimAt', (data->>'savedAt')::bigint) - 'savedAt' - 'offerSaved', seq = nextval('hub.docs_seq')
    where coll = 'svc_returns' and not deleted and data->>'savedAt' ~ '^[0-9]+$' and data->>'savedVerified' is null and data->>'exchangeMade' is null`;
  await db()`update hub.docs set data = data || '{"exchanges":0}'::jsonb, seq = nextval('hub.docs_seq') where coll = 'svc_experiments' and not deleted`;
}
