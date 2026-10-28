// After the warehouse marks a return "Quality Check Completed" (Richpanel Returns qcCompletedAt), Ella writes one short follow-up
// before any refund: bought 2 sizes → offer another of the size that fit; plain refund → one honest last offer (store credit +10%).
// Exchanges and store credit get nothing (David, Oct 27). Draft only for now: nothing here sends, and refunds always need David's OK.
import { db, init, getDoc, putDoc } from "./server.js";
import { findOrders, facts, draftReply, nameFor, AFTER_RECEIPT, draftFor, isOp, isNoise, RETURN_WORDS, RETURNS_TEMPLATE, loadTicket } from "./ella.js";

export const AFTER_QC_SINCE = "2026-10-27T20:30:00Z"; // only returns checked after this go-live

async function returnsGql(query, variables) {
  const r = await fetch("https://returns-api.richpanel.com/graphql", { method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.RICHPANEL_RETURNS_API_KEY || "" }, body: JSON.stringify({ query, variables }) });
  const j = await r.json().catch(() => ({})); if (!r.ok || j.errors) throw new Error(`Returns ${r.status}: ${JSON.stringify(j.errors || j).slice(0, 200)}`);
  return j.data;
}
const ms = v => typeof v === "number" ? v : Date.parse(v || "") || (Number(v) || 0);
const size = v => String(v || "").split("/").map(s => s.trim()).find(s => /^(XXS|XS|S|M|L|XL|XXL|2XL|3XL|\d{2}(x\d{2})?)$/i.test(s)) || "";

// Same product bought in 2+ sizes on one order.
const twoSizes = order => { const by = {};
  (order?.lineItems?.nodes || []).forEach(l => { const s = size(l.variantTitle); if (s) (by[l.title] ||= new Set()).add(s.toUpperCase()); });
  return Object.entries(by).find(([, s]) => s.size > 1)?.[0] || null; };

// What the customer told us before (the original thread + anything the hub saved from them), oldest first, so Ella
// doesn't ask "big or small?" when they already said "too small".
async function pastWords(t, email) {
  const out = [];
  if (t?.number) { const k = await loadTicket(t.number).catch(() => null);
    (k?.comments || []).filter(c => !isNoise(c)).slice(-12).forEach(c => out.push(`${isOp(c) ? "CO36" : "Customer"}: ${String(c.plain_body || c.body || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 500)}`)); }
  if (email) { await init();
    const rows = await db()`select data->>'message' as m from hub.docs where coll in ('svc_returns', 'svc_inbox') and not deleted and id not like 'qc-%'
      and lower(data->>'email') = ${String(email).toLowerCase()} and data->>'message' is not null order by seq desc limit 4`;
    rows.reverse().forEach(r => { const m = String(r.m || "").slice(0, 500); if (m && !out.some(x => x.includes(m.slice(0, 60)))) out.unshift(`Customer (earlier email): ${m}`); }); }
  return out.join("\n");
}

// The Richpanel thread to answer in (David): the customer's original email about this return first, so it reads as one conversation;
// else the "Quality Check Completed" email (captured by /api/inbound).
async function threadFor(orderNumber, email) {
  await init(); const e = String(email || "").toLowerCase();
  const [r] = await db()`select data from hub.docs where coll in ('svc_returns', 'svc_inbox') and not deleted and data->>'ticketId' is not null
    and id not like 'qc-%' and (data->'orders' ? ${"#" + orderNumber} or data->>'order' = ${"#" + orderNumber} or lower(data->>'email') = ${e})
    order by (data->'orders' ? ${"#" + orderNumber} or data->>'order' = ${"#" + orderNumber}) desc, seq desc limit 1`;
  if (r) return { ticketId: r.data.ticketId, number: r.data.number, from: "original" };
  const qc = await getDoc("svc_qcthread", String(orderNumber));
  return qc?.ticketId ? { ...qc, from: "qc_email" } : null;
}

export async function pollAfterQc() {
  const since = Date.parse(AFTER_QC_SINCE);
  const d = await returnsGql(`query($q: ReturnsQueryInput){ getAllReturns(query: $q){ returns { _id name status orderNumber outcome type qcCompletedAt customer { name email } total { amount refund } } } }`,
    { q: { startDate: new Date(since - 45 * 864e5).toISOString(), limit: 200, skip: 0 } });
  const fresh = (d.getAllReturns?.returns || []).filter(r => ms(r.qcCompletedAt) >= since);
  let made = 0;
  for (const r of fresh) {
    const id = "qc-" + r._id;
    const prev = await getDoc("svc_returns", id);
    if (prev && !(prev.status === "draft" && prev.kind && !prev.v3)) continue; // redo unsent drafts once with the customer's history // redo old last-ask drafts once (size rule)
    const outcome = String(r.outcome || "").toUpperCase();
    if (outcome !== "REFUND") { await putDoc("svc_returns", id, { stage: "after_qc", status: "skipped", outcome, returnName: r.name, at: Date.now(), why: "exchange or store credit: no email" }); continue; }
    const email = r.customer?.email || "", who = r.customer?.name || "", on = String(r.orderNumber || "").replace(/^#+/, "");
    const orders = await findOrders(`#${on}`, email).catch(() => []);
    const order = orders.find(o => o.name === "#" + on) || orders[0];
    const two = twoSizes(order), kind = two ? "two_sizes" : "last_ask";
    const t = await threadFor(on, email);
    const history = await pastWords(t, email).catch(() => "");
    const situation = two
      ? `SITUATION: The warehouse just received and checked their return for order #${on}. They bought ${two} in two sizes and sent one back. Before the refund goes out, write ONE short message in this exact spirit (David's wording): "${AFTER_RECEIPT.bought_two_sizes.A}" Fill in their first name and the product; say "the size that fit" if you don't know which size they kept.`
      : `SITUATION: The warehouse just received and checked their return for order #${on} (refund of about $${r.total?.refund ?? r.total?.amount ?? "?"}). Before the refund goes out, write ONE short, warm, honest last ask. One try only, no pressure, under 40 words. If they'd still like the refund, they just reply. Never promise a refund or its timing.
SIZES (David): we don't know why they sent it back. Don't list sizes. Always one size up or down, never two (only two if they say it was way off). Ask simply if it was too big or too small so you can send the right size, e.g. "Was it running big or small on you? I'd love to send the right size instead." If that size is sold out in their color, offer the same size in another in-stock color or a similar in-stock style. Store credit with 10% extra is the fallback offer if it's not about fit.
READ THE HISTORY FIRST (David): if the conversation so far already says why (e.g. "too small", "neck too tight", "sleeves too long"), don't ask again; use it and offer exactly one size in that direction (or the better style), e.g. "Since the XL ran small on you, would you like the XXL instead?"`;
    let draft = null, plan = "", flags = [];
    try { const x = await draftReply({ name: who, thread: history || "(no earlier messages found)", latest: situation, orderFacts: facts(orders), persona: nameFor(email || who) }); draft = x.reply; plan = x.plan; flags = x.flags || []; }
    catch (e) { flags = ["draft_error"]; }
    const c = order?.customer || {}, vip = Number(c.numberOfOrders || 0) >= 5 || Number(c.amountSpent?.amount || 0) >= 500;
    await putDoc("svc_returns", id, { v2: true, v3: true, stage: "after_qc", kind, intent: "after_qc", status: "draft", draft, plan,
      flags: [...new Set([...flags, ...(vip ? ["vip"] : []), ...(t ? [] : ["no_thread"])])], vip,
      ticketId: t?.ticketId || prev?.ticketId || null, number: t?.number || prev?.number || null, thread: t?.from || prev?.thread || null, customer: who, email, orders: ["#" + on], returnId: r._id, returnName: r.name,
      refund: r.total?.refund || r.total?.amount || null, qcAt: ms(r.qcCompletedAt), receivedAt: prev?.receivedAt || Date.now(), lastAt: Date.now(), draftedAt: Date.now() }, true); // merge: keep the refund-notice fields on a redo
    made++; if (made >= 2) break; // a few per minute keeps the cron fast
  }
  return { checked: fresh.length, made };
}

// Tell the team who to refund: a private note + the "refundrequired" tag on the conversation (reopened so it lands in the inbox),
// and the case shows under "Refunds to do" on the Returns board. Ella never refunds.
//  - her last offer wasn't sent (drafts-only mode, VIP, no thread): right away, so nobody waits on an offer that never went out
//  - her last offer was sent: 48h later (if they answer sooner, the reply comes through the normal flow and a person sees it)
const RP = (path, init) => fetch(`https://api.richpanel.com/v1/${path}`, { ...init, headers: { "content-type": "application/json", "x-richpanel-key": process.env.RICHPANEL_API_KEY || "" } });
// Richpanel's HTTP Target only fires on customer messages, so "Quality Check Completed" emails (sent by Returns) never reach /api/inbound.
// Walk new conversation numbers instead (each one is a cheap lookup) and remember the QC threads by order number.
export async function scanQcThreads() {
  const meta = (await getDoc("svc_meta", "qcscan")) || {}; let n = Number(meta.last) || 37480, misses = 0, found = 0;
  if (!meta.r4) n = Math.min(n, 37740); // one-time look back (catches #37726, missed by the reader)
  for (let i = 0; i < 25 && misses < 3; i++) {
    const r = await RP(`tickets/number/${n + 1}`, { method: "GET" }); if (!r.ok) { misses++; continue; }
    misses = 0; n++; const t = (await r.json().catch(() => ({})))?.ticket || {};
    const m = String(t.subject || "").match(/quality check completed.*?#\s*(\d+)/i);
    if (m && t.id) { await putDoc("svc_qcthread", m[1], { ticketId: t.id, number: String(n), at: Date.now() }); found++; }
    else if (t.id) await catchMissedReturn(t, String(n)).catch(() => {});
  }
  await putDoc("svc_meta", "qcscan", { last: n, at: Date.now(), found: (meta.found || 0) + found, r1: true, r2: true, r3: true, r4: true });
  return found;
}

// Second net for returns/exchanges the webhook missed: a fresh conversation (under 3h), the customer's words say return/exchange,
// nobody has answered yet, and the hub has no draft for it → draft it now (autopilot then sends it after the usual wait).
async function catchMissedReturn(t, number) {
  const id = "n" + number; if (Date.now() - Date.parse(t.created_at || t.createdAt || 0) > 3 * 3600e3) return;
  const had = await getDoc("svc_returns", id);
  // Redo once if an earlier scan draft had no order (the email address wasn't read then).
  if (had && !(had.caughtBy === "scan" && (had.flags || []).includes("no_order") && !had.redoneAt && had.status === "draft")) return;
  const comments = (t.comments || []).filter(c => !isNoise(c)), cust = comments.filter(c => !isOp(c)), last = comments[comments.length - 1];
  if (!cust.length || isOp(last)) return;
  const message = String(cust[cust.length - 1].plain_body || cust[cust.length - 1].body || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (RETURNS_TEMPLATE.test(String(t.subject || "")) || !RETURN_WORDS.test(`${t.subject || ""} ${message}`)) return;
  const cp = t.customer_profile || {}, who = cp.name || [cp.firstName || cp.first_name, cp.lastName || cp.last_name].filter(Boolean).join(" ") || null, mail = cp.email || t.customer?.email || t.customer_email || t.via?.source?.from?.address || t.from?.address || t.from_email || null;
  await putDoc("svc_returns", id, { ticketId: t.id, number, customer: who, email: mail, subject: t.subject, message: message.slice(0, 2000),
    intent: /exchange|swap|another size/i.test(message) ? "exchange" : "return", status: "drafting", receivedAt: Date.now(), lastAt: Date.now(), sarahAt: null, caughtBy: "scan", ...(had ? { redoneAt: Date.now() } : {}) }, true);
  await draftFor(id, { who, mail, subject: t.subject, message, comments });
}

export async function notifyRefunds(settings = {}) {
  await init();
  const rows = await db()`select id, data from hub.docs where coll = 'svc_returns' and not deleted and id like 'qc-%'
    and data->>'stage' = 'after_qc' and (data->>'refundNotifiedAt' is null or ((data->>'refundNoted')::boolean is not true and (data->>'refundNotifiedAt')::bigint > ${Date.now() - 2 * 864e5})) and data->>'status' in ('draft', 'sent') order by seq limit 10`;
  let n = 0;
  for (const { id, data: r } of rows) {
    const willSend = settings.afterQcAuto && !settings.off && !(r.flags || []).some(f => f !== "no_order");
    const due = r.refundNotifiedAt ? true : r.status === "sent" ? Date.now() >= (r.sentAt || 0) + 48 * 3600e3 : !willSend;
    if (!due) continue;
    const why = r.status === "sent" ? "Ella's last offer went out 48h ago" : "Ella's last offer wasn't sent";
    let ok = false;
    if (!r.ticketId) { const t = await threadFor(String(r.orders?.[0] || "").replace(/^#+/, ""), r.email); if (t) { r.ticketId = t.ticketId; await putDoc("svc_returns", id, { ticketId: t.ticketId, number: t.number, thread: t.from, flags: (r.flags || []).filter(f => f !== "no_thread") }, true); } }
    if (r.ticketId) {
      const body = `REFUND TO DO · #${String(r.orders?.[0] || "").replace(/^#+/, "")} · ${r.customer || r.email || ""}${r.refund != null ? ` · about $${r.refund}` : ""}\nReturn ${r.returnName || ""} passed quality check. ${why}. Please check the thread for their answer, then refund in Richpanel Returns.`;
      const x = await RP(`tickets/${encodeURIComponent(r.ticketId)}`, { method: "PUT", body: JSON.stringify({ ticket: { status: "OPEN", comment: { body, sender_type: "operator", public: false, author_id: process.env.RICHPANEL_AUTHOR_ID || "operator" } } }) });
      ok = x.ok;
      await RP(`tickets/${encodeURIComponent(r.ticketId)}/add-tags`, { method: "PUT", body: JSON.stringify({ tags: ["refundrequired"] }) }).catch(() => {});
    }
    await putDoc("svc_returns", id, { refundNotifiedAt: r.refundNotifiedAt || Date.now(), refundWhy: why, refundNoted: ok }, true); n++;
  }
  return n;
}
