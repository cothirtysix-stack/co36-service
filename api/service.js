// Service Hub actions. Every call is signed in (wrap). Writes to Shopify and Richpanel only happen when a person clicks.
import { wrap, putDoc, getDoc, db, init } from "../lib/server.js";
import { shopify, need } from "../lib/shopify.js";
import { bulkQuery, parseBulk, classify, eventsQuery, classifyMoving } from "../lib/fix.js";
import { draftFor, loadTicket, isOp } from "../lib/ella.js";

const fail = (msg, status = 400) => { throw Object.assign(new Error(msg), { status }); };
const userErr = (label, errs) => { if (errs?.length) fail(`${label}: ${errs.map(e => e.message).join("; ")}`, 502); };
const scopeHint = (e, scope) => /access denied|ACCESS_DENIED|not approved|required access/i.test(String(e?.message || e))
  ? fail(`Shopify needs the "${scope}" permission for this. Add it to the CO36 HQ app in Shopify, then try again.`, 403) : e;

async function scanStart() {
  const cur = await getDoc("svc_fix", "scan");
  if (cur?.status === "running" && Date.now() - cur.startedAt < 15 * 60e3) return cur;
  const since = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const j = await shopify(`mutation($q:String!){ bulkOperationRunQuery(query:$q){ bulkOperation { id status } userErrors { message } } }`, { q: bulkQuery(since) });
  userErr("Shopify scan", j.data?.bulkOperationRunQuery?.userErrors);
  const op = j.data?.bulkOperationRunQuery?.bulkOperation; if (!op) fail("Shopify didn't start the scan: " + JSON.stringify(j.errors || j).slice(0, 200), 502);
  const scan = { status: "running", id: op.id, startedAt: Date.now() };
  await putDoc("svc_fix", "scan", scan); return scan;
}

async function scanCheck() {
  const cur = await getDoc("svc_fix", "scan"); if (!cur?.id) return { status: "idle" };
  if (cur.status !== "running") return cur;
  const j = await shopify(`query($id:ID!){ node(id:$id){ ... on BulkOperation { status url errorCode objectCount } } }`, { id: cur.id });
  const op = j.data?.node || {};
  if (op.status === "RUNNING" || op.status === "CREATED") return { ...cur, objects: Number(op.objectCount || 0) };
  if (op.status !== "COMPLETED") { const done = { ...cur, status: "failed", error: op.errorCode || op.status || "unknown" }; await putDoc("svc_fix", "scan", done); return done; }
  const text = op.url ? await (await fetch(op.url)).text() : "";
  const now = Date.now(), first = classify(parseBulk(text), now);
  // Last carrier scan for packages that have been moving too long (capped so one check stays fast).
  const check = first.needEvents.slice(0, 400), last = {};
  for (let i = 0; i < check.length; i += 100) {
    const r = await shopify(eventsQuery, { ids: check.slice(i, i + 100).map(p => p.fulfillmentId) });
    (r.data?.nodes || []).forEach(n => { if (n?.id) last[n.id] = n.events?.nodes?.[0] || null; });
  }
  const moving = check.map(p => classifyMoving(p, last[p.fulfillmentId], now)).filter(Boolean);
  // Merged orders share one package, so keep one row per tracking number.
  const seen = new Set(), problems = [...first.problems, ...moving].sort((a, b) => Date.parse(a.since) - Date.parse(b.since))
    .filter(p => !p.tracking || (!seen.has(p.tracking) && seen.add(p.tracking)));
  await putDoc("svc_fix", "latest", { at: now, problems, notShipped: first.notShipped, onHold: first.onHold, unchecked: Math.max(0, first.needEvents.length - check.length) });
  const done = { ...cur, status: "done", finishedAt: now }; await putDoc("svc_fix", "scan", done); return done;
}

// Reply in the customer's Richpanel thread (an email reply to them).
async function reply({ ticketId, body, close }) {
  if (!ticketId || !String(body || "").trim()) fail("Missing conversation or message");
  if (/\{\{LABEL_LINK\}\}/.test(body)) fail("This reply needs the exchange to be set up first. Let Ella send it, or replace {{LABEL_LINK}}.");
  const r = await fetch(`https://api.richpanel.com/v1/tickets/${encodeURIComponent(ticketId)}`, { method: "PUT",
    headers: { "content-type": "application/json", "x-richpanel-key": need("RICHPANEL_API_KEY") },
    body: JSON.stringify({ ticket: { ...(close ? { status: "CLOSED" } : {}), comment: { body: String(body), sender_type: "operator", public: true, author_id: process.env.RICHPANEL_AUTHOR_ID || "operator" } } }) });
  if (!r.ok) fail(`Richpanel ${r.status}: ${(await r.text()).slice(0, 200)}`, 502);
  return { ok: true };
}

async function giftCard({ amount, order, note }) {
  const v = Number(amount); if (![15, 25, 50].includes(v)) fail("Gift cards are $15, $25 or $50");
  const m = `mutation($i:GiftCardCreateInput!){ giftCardCreate(input:$i){ giftCard { id } giftCardCode userErrors { message } } }`;
  const noteText = `Service Hub · ${order || ""} · ${note || "made right"}`.slice(0, 250);
  // Newer API versions take initialAmount (money); older ones take initialValue.
  let j = await shopify(m, { i: { initialAmount: { amount: String(v), currencyCode: "USD" }, note: noteText } }).catch(e => { throw scopeHint(e, "write_gift_cards"); });
  if (j.errors && /initialAmount/.test(JSON.stringify(j.errors))) j = await shopify(m, { i: { initialValue: String(v), note: noteText } });
  if (j.errors) throw scopeHint(new Error(JSON.stringify(j.errors)), "write_gift_cards");
  userErr("Gift card", j.data?.giftCardCreate?.userErrors);
  return { id: j.data.giftCardCreate.giftCard.id, code: j.data.giftCardCreate.giftCardCode, amount: v };
}

// $0 replacement order, linked to the original. One free reship per order unless a manager overrides.
async function reship({ order, override }) {
  if (!/^#?\d+$/.test(String(order || ""))) fail("Which order?");
  const name = "#" + String(order).replace(/^#/, "");
  const prior = await shopify(`query($q:String){ orders(first:1, query:$q){ nodes { name } } }`, { q: `tag:'Reship of ${name}'` });
  if (prior.data?.orders?.nodes?.length && !override) fail(`${name} was already reshipped (${prior.data.orders.nodes[0].name}). A manager has to OK a second one.`, 409);
  const o = (await shopify(`query($q:String){ orders(first:1, query:$q){ nodes { id name email customer { id }
    shippingAddress { firstName lastName company address1 address2 city provinceCode countryCodeV2 zip phone }
    lineItems(first:50){ nodes { quantity title variant { id } } } } } }`, { q: `name:${name}` })).data?.orders?.nodes?.[0];
  if (!o) fail(`Couldn't find ${name} in Shopify`, 404);
  const a = o.shippingAddress; if (!a) fail(`${name} has no shipping address Shopify will share. The app may need customer-data access.`, 403);
  const lineItems = o.lineItems.nodes.filter(l => l.variant?.id && !/protection|gift ?card/i.test(l.title)).map(l => ({ variantId: l.variant.id, quantity: l.quantity }));
  if (!lineItems.length) fail(`${name} has nothing physical to reship`);
  const input = { email: o.email, ...(o.customer?.id ? { purchasingEntity: { customerId: o.customer.id } } : {}),
    shippingAddress: { firstName: a.firstName, lastName: a.lastName, company: a.company, address1: a.address1, address2: a.address2, city: a.city, provinceCode: a.provinceCode, countryCode: a.countryCodeV2, zip: a.zip, phone: a.phone },
    lineItems, appliedDiscount: { valueType: "PERCENTAGE", value: 100, title: "Reship" },
    shippingLine: { title: "Express (reship)", priceWithCurrency: { amount: "0", currencyCode: "USD" } },
    tags: ["Reship", `Reship of ${name}`], note: `Free reship of ${name} from the Service Hub.` };
  const d = await shopify(`mutation($i:DraftOrderInput!){ draftOrderCreate(input:$i){ draftOrder { id } userErrors { message } } }`, { i: input }).catch(e => { throw scopeHint(e, "write_draft_orders"); });
  if (d.errors) throw scopeHint(new Error(JSON.stringify(d.errors)), "write_draft_orders");
  userErr("Reship", d.data?.draftOrderCreate?.userErrors);
  const c = await shopify(`mutation($id:ID!){ draftOrderComplete(id:$id){ draftOrder { order { id name } } userErrors { message } } }`, { id: d.data.draftOrderCreate.draftOrder.id });
  userErr("Reship", c.data?.draftOrderComplete?.userErrors);
  const made = c.data?.draftOrderComplete?.draftOrder?.order;
  await shopify(`mutation($id:ID!,$t:[String!]!){ tagsAdd(id:$id, tags:$t){ userErrors { message } } }`, { id: o.id, t: ["Reshipped", `Reshipped as ${made?.name}`] }).catch(() => {});
  return { order: made?.name, orderId: made?.id };
}

// Rewrite Ella's draft, optionally with an instruction ("offer store credit", "shorter").
async function redraft({ id, note }) {
  const ret = await getDoc("svc_returns", String(id || ""));
  if (!ret) fail("Not found", 404);
  const t = ret.number ? await loadTicket(ret.number) : null;
  const comments = t?.comments || [];
  const last = comments.filter(c => !isOp(c)).pop();
  await putDoc("svc_returns", id, { status: "drafting" }, true);
  await draftFor(id, { who: ret.customer, mail: ret.email, subject: ret.subject, message: String(last?.plain_body || last?.body || ret.message || ""), comments, note: String(note || "").slice(0, 300) });
  return { ok: true };
}

// Richpanel Returns (read): field list for building the board, and a page of returns.
async function returnsGql(query, variables) {
  const r = await fetch("https://returns-api.richpanel.com/graphql", { method: "POST",
    headers: { "content-type": "application/json", "x-api-key": need("RICHPANEL_RETURNS_API_KEY") }, body: JSON.stringify({ query, variables }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.errors) fail(`Returns ${r.status}: ${JSON.stringify(j.errors || j).slice(0, 300)}`, 502);
  return j.data;
}
async function returnsSchema({ type }) {
  const d = await returnsGql(`query($t:String!){ __type(name:$t){ name fields { name type { name kind ofType { name kind ofType { name kind } } } } inputFields { name type { name kind ofType { name } } } enumValues { name } } }`, { t: String(type || "ReturnsListResponse") });
  return d.__type;
}
async function returnsList({ statuses, startDate, endDate, limit = 100, skip = 0, fields }) {
  const f = String(fields || "_id name status createdAt orderNumber outcome customer { name email }");
  if (/[^A-Za-z0-9_{}\s]/.test(f)) fail("bad fields");
  const d = await returnsGql(`query($q: ReturnsQueryInput){ getAllReturns(query: $q){ returns { ${f} } count { OPEN MANUAL_REVIEW PENDING_LABEL_GENERATION PROCESSED CANCELLED } } }`,
    { q: { ...(statuses ? { statuses } : {}), ...(startDate ? { startDate } : {}), ...(endDate ? { endDate } : {}), limit: Math.min(+limit || 100, 200), skip: +skip || 0 } });
  return d.getAllReturns;
}

// Order count and lifetime spend for a few customers (VIP = 5+ orders or $500+ spent).
async function customers({ emails }) {
  const list = [...new Set((emails || []).map(e => String(e || "").trim().toLowerCase()).filter(e => /^[^\s@]+@[^\s@]+$/.test(e)))].slice(0, 50);
  const out = {};
  for (let i = 0; i < list.length; i += 10) {
    const chunk = list.slice(i, i + 10);
    const j = await shopify(`query($q:String){ customers(first: 20, query: $q){ nodes { email numberOfOrders amountSpent { amount } lastOrder { name createdAt } } } }`,
      { q: chunk.map(e => `email:${e}`).join(" OR ") });
    (j.data?.customers?.nodes || []).forEach(c => { const e = String(c.email || "").toLowerCase(); if (!e) return;
      const orders = Number(c.numberOfOrders || 0), spent = Number(c.amountSpent?.amount || 0);
      out[e] = { orders, spent, vip: orders >= 5 || spent >= 500, lastOrder: c.lastOrder?.name || null, lastOrderAt: c.lastOrder?.createdAt || null }; });
  }
  return out;
}

// Today's 10 VIPs (David, Nov 10): 5+ orders or $500+ spent, not checked in on for 60+ days. Same 10 all day (saved per day).
async function vips() {
  const day = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }), saved = await getDoc("svc_meta", `vips-${day}`);
  if (saved?.list) return { day, list: saved.list };
  const all = []; let after = null;
  for (let page = 0; page < 6; page++) {
    const j = await shopify(`query($a:String){ customers(first: 250, after: $a, query: "orders_count:>4 OR total_spent:>499"){ nodes { id displayName email numberOfOrders amountSpent { amount } lastOrder { name createdAt } } pageInfo { hasNextPage endCursor } } }`, { a: after });
    const c = j.data?.customers; (c?.nodes || []).forEach(n => all.push(n)); if (!c?.pageInfo?.hasNextPage) break; after = c.pageInfo.endCursor;
  }
  const cutoff = Date.now() - 60 * 864e5, pick = [];
  const hash = t => { let h = 0; for (const ch of t) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; };
  for (const c of all.filter(c => c.email).sort((a, b) => hash(day + a.id) - hash(day + b.id))) {
    const v = await getDoc("svc_vip", String(c.id).split("/").pop()); if (v?.checkedAt > cutoff) continue;
    pick.push({ id: String(c.id).split("/").pop(), name: c.displayName, email: c.email, orders: +c.numberOfOrders || 0, spent: +c.amountSpent?.amount || 0,
      lastOrder: c.lastOrder?.name || null, lastOrderAt: c.lastOrder?.createdAt || null, lastCheckIn: v?.checkedAt || null });
    if (pick.length >= 10) break;
  }
  await putDoc("svc_meta", `vips-${day}`, { list: pick, at: Date.now(), pool: all.length });
  return { day, list: pick, pool: all.length };
}

// A personal check-in note for one VIP, from David (Nov 10). Facts only: their orders and past conversations with us. Nothing is sent.
async function vipDraft({ id, refresh }) {
  const day = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const had = await getDoc("svc_vipdraft", String(id)); if (had?.day === day && had.body && !refresh) return had;
  const j = await shopify(`query($id:ID!){ customer(id:$id){ displayName firstName email createdAt numberOfOrders
    orders(first: 6, reverse: true){ nodes { name createdAt lineItems(first: 10){ nodes { title variantTitle quantity } } } } } }`, { id: `gid://shopify/Customer/${String(id).replace(/\D/g, "")}` });
  const c = j.data?.customer; if (!c) fail("Customer not found in Shopify");
  await init();
  const mail = String(c.email || "").toLowerCase();
  const talks = mail ? (await db()`select data from hub.docs where coll = 'svc_inbox' and not deleted and lower(data->>'email') = ${mail} order by seq desc limit 5`).map(r => r.data) : [];
  const rets = mail ? (await db()`select data from hub.docs where coll = 'svc_returns' and not deleted and lower(data->>'email') = ${mail} order by seq desc limit 5`).map(r => r.data) : [];
  const facts = [
    `Name: ${c.firstName || c.displayName}`, `Customer since: ${String(c.createdAt).slice(0, 10)}`, `Orders: ${c.numberOfOrders}`,
    ...(c.orders?.nodes || []).map(o => `- ${o.name} on ${String(o.createdAt).slice(0, 10)}: ${(o.lineItems?.nodes || []).filter(l => !/protection|insurance/i.test(l.title)).map(l => `${l.quantity}x ${l.title}${l.variantTitle ? " (" + l.variantTitle + ")" : ""}`).join(", ")}`),
    ...talks.map(t => `- Past email to us (${t.mood || "neutral"}): ${t.summary || t.quote || ""}`),
    ...rets.map(r => `- ${r.intent === "exchange" ? "Exchange" : "Return"} request: ${String(r.plan || r.message || "").slice(0, 140)}`)
  ].join("\n");
  const prompt = `Write a short personal check-in email from David, the founder of CO36 (a men's clothing brand), to one of our best customers.
Goal: make him feel valued and remembered, like a personal note from the founder. NOT marketing.
Rules:
- 40 to 80 words. Warm, simple, human. Sound like David wrote it himself.
- Use ONLY the facts below. Mention one specific, real thing (what he bought, how long he's been with us, an exchange we did). Never invent anything.
- No selling: no discounts, no new products, no links, no "shop now". Don't mention how much he spent or order counts as numbers.
- If a past email or return shows a problem, acknowledge it briefly and kindly, don't dwell.
- End with one genuine, easy question (how the shirts are holding up, how the fit has been), so he feels free to reply.
- Never mention AI, automation, or that he was picked from a list.
- Start with "Hi ${(c.firstName || String(c.displayName || "").split(" ")[0] || "there").replace(/[^\p{L}' -]/gu, "")},". Sign off exactly:\nDavid\nFounder, CO36
Facts:
${facts}
Answer with the email only.`;
  const key = process.env.ANTHROPIC_API_KEY; if (!key) fail("ANTHROPIC_API_KEY missing");
  const r = await fetch("https://api.anthropic.com/v1/messages", { signal: AbortSignal.timeout(40000), method: "POST", headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || "claude-opus-5-5", max_tokens: 2000, messages: [{ role: "user", content: prompt }] }) });
  const out = await r.json().catch(() => ({})); if (!r.ok) fail(out.error?.message || `Claude ${r.status}`, 502);
  const body = (out.content || []).map(b => b.text || "").join("").trim(); if (!body) fail("No draft came back, try again", 502);
  const doc = { day, body, at: Date.now(), email: c.email, name: c.displayName };
  await putDoc("svc_vipdraft", String(id), doc); return doc;
}

const OPS = { scanStart, scanCheck, reply, giftCard, reship, redraft, returnsSchema, returnsList, customers, vips, vipDraft };
export default wrap(async (req, res, who) => {
  const { op, ...args } = req.body || {};
  if (!OPS[op]) return res.status(400).json({ error: "Unknown action" });
  // Teammates only get the actions of the pages David gave them.
  const need = { giftCard: "home", reship: "fulfillment", scanStart: "fulfillment", scanCheck: "fulfillment" }[op];
  if (who.role === "member" && need && !(who.pages || []).includes(need)) return res.status(403).json({ error: "You don't have access to that." });
  res.json(await OPS[op](args, who));
});
