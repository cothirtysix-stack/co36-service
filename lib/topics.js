// Inbox by reason (David, Nov 19): every customer email, sorted by WHY they wrote (product question, where's my order, damaged,
// shrinkage...). Ella drafts an answer for each one still waiting, for training only: NOTHING here is ever sent to a customer.
// svc_topics = one card per conversation (last 7 days + anything still waiting); svc_tstat = a tiny {day, topic} row per
// conversation (last 30 days) for the % bar on top.
import { putDoc, getDoc } from "./server.js";
import { isNoise, isAutoEmail, plainText, findOrders, facts } from "./ella.js";
import { read } from "./mood.js";
import { orderFacts } from "./asks.js";
import { sizeFacts } from "./sizefinder.js";
import { lessonsForPrompt } from "./learn.js";

export const TOPICS = {
  product: "Product question", tracking: "Where's my order", refund_status: "Where's my refund", damaged: "Damaged / defective",
  shrinkage: "Shrinkage / washed", wrong_item: "Wrong item shipped", missing_item: "Missing item", cancel_change: "Cancel or change order", discount: "Discount / promo code",
  billing: "Unexpected charge", website: "Website or checkout problem", account: "Account, emails, unsubscribe", praise: "Thanks / praise", feedback: "Feedback / complaint", suggestion: "Product suggestion", spam: "Spam, pitches, auto-replies", return: "Return / refund request", exchange: "Exchange", other: "Other"
};
const isOp = c => !!(c.is_operator ?? c.isOperator);
const clean = c => plainText(String(c?.plain_body || c?.body || "").replace(/<a\b[^>]*>(.*?)<\/a>/gi, "$1").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim());
const when = c => Date.parse(c?.created_at || c?.createdAt || 0) || 0;
const day = ms => new Date(ms - 5 * 3600e3).toISOString().slice(0, 10); // New York day
export const isEmailTicket = t => { const ch = String(t?.via?.channel || t?.channel || t?.source || ""); return /email|gmail/i.test(ch) && !/instagram|facebook|comment|social|messenger|dm/i.test(ch); };
export const topicOf = m => TOPICS[m?.topic] ? m.topic : m?.intent === "product" ? "product" : m?.intent === "tracking" ? "tracking" : m?.intent === "refund_status" ? "refund_status"
  : m?.intent === "exchange" ? "exchange" : m?.intent === "return" ? "return" : m?.type === "damaged" ? "damaged" : m?.type === "wrong" ? "wrong_item" : "other";

// One Richpanel conversation → its stat row, and a card if it's recent or still waiting. mood: reuse the webhook's read.
export async function recordTicket(number, t, mood = null) {
  if (!t) return "missing";
  if (!isEmailTicket(t)) return "not email";
  const comments = (t.comments || []).filter(c => !isNoise(c) && !isAutoEmail(c));
  const custs = comments.filter(c => !isOp(c)), lastCust = custs[custs.length - 1];
  if (!lastCust) return "no customer message";
  const subject = String(t.subject || "");
  const text = clean(lastCust);
  if (/judge\.?me|left (a|the following) \d star review|quality check completed/i.test(`${subject} ${text.slice(0, 300)}`)) return "review/auto";
  const created = Date.parse(t.created_at || t.createdAt || 0) || when(custs[0]) || Date.now();
  if (Date.now() - created > 31 * 864e5) return "old";
  mood ||= await read(text, subject).catch(() => null);
  if (!mood) return "unread";
  const topic = topicOf(mood), id = "n" + number;
  await putDoc("svc_tstat", id, { d: day(created), t: topic });
  const last = comments[comments.length - 1], closed = String(t.status || "").toUpperCase() === "CLOSED";
  const waiting = !closed && !!last && !isOp(last);
  if (!waiting && Date.now() - created > 7 * 864e5) return "stat only";
  const reply = [...comments].reverse().find(isOp), cp = t.customer_profile || {};
  const prev = await getDoc("svc_topics", id), msgKey = String(lastCust.id || when(lastCust));
  const lane = ["return", "exchange"].includes(topic) || ["return", "exchange"].includes(mood.intent) ? "returns" : "topics";
  const doc = { number: String(number), ticketId: t.id, customer: cp.name || [cp.firstName || cp.first_name, cp.lastName || cp.last_name].filter(Boolean).join(" ") || prev?.customer || null,
    email: cp.email || t.via?.source?.from?.address || prev?.email || null, subject: subject.slice(0, 200), message: text.slice(0, 1500), msgs: custs.length,
    earlier: custs.length > 1 ? clean(custs[0]).slice(0, 500) : null, topic, intent: mood.intent || null, mood: mood.mood || null, summary: mood.summary || null, lane,
    receivedAt: created, lastAt: when(lastCust) || created, waiting, closed, teamReply: reply ? clean(reply).slice(0, 800) : null,
    repliedAfter: !!reply && when(reply) > when(lastCust), lastMsg: msgKey };
  if (topic === "spam") { doc.waiting = false; doc.status = "skip"; }
  else if (lane === "topics" && waiting && (prev?.lastMsg !== msgKey || !prev?.draft) && prev?.status !== "drafting") Object.assign(doc, { status: "queued" });
  else if (!waiting && prev?.status === "queued") doc.status = "answered";
  else if (!prev?.status) doc.status = lane === "returns" ? "returns" : "answered";
  await putDoc("svc_topics", id, doc, true);
  return topic;
}

const GUIDE = {
  product: "Answer their product question from the catalog and size facts. If you aren't sure, say you'll check and get right back.",
  tracking: "Where's their order: use the order facts. Shipped with tracking: share the tracking link and what it shows. Not shipped yet: apologize sincerely and say you're personally looking into it. Never promise a date.",
  refund_status: "Where's their refund: use the order facts. If the facts show a refund, tell them the amount and that it can take a few business days to show on their statement. If not, apologize and say you're checking on it with the team right now. Never promise a refund or a date.",
  damaged: "Damaged or defective item: apologize, believe them, ask for a quick photo if they didn't send one, and say we'll make it right with a replacement. Never offer a refund (a person decides).",
  shrinkage: "Shrinkage after washing: be kind. Fact you may use: we pre-shrink the fabric twice before cutting. There is no official rule yet on washed items, so don't promise an exchange or refund for a washed shirt; say you're checking with the team. Unwashed shirts can be exchanged as usual.",
  missing_item: "Missing item: check the order lines and shipments first. Apologize, believe them, take it off their plate and say we're sending what's missing (a person confirms).",
  wrong_item: "Wrong item shipped: check the order lines first. If it really is our mistake, apologize, take it off their plate and say we're sending the right one (a person confirms).",
  cancel_change: "Cancel or change: if the order hasn't shipped, say you're on it right now. If it already shipped, say so kindly and that they can return or exchange it once it arrives.",
  discount: "Discount or promo code: never create or give out a code. BLACK FRIDAY (David, Nov 24): the sale is already in the item prices (up to 60% off is what's shown on the product); there is no extra code and no additional discount at checkout. If they ask where their 60% or a code is, kindly explain the price they see already includes it. If a different code didn't work, say you're checking it.",
  billing: "Unexpected charge: apologize, take it seriously, check the order facts (was there a second order, a shipping charge, protection?). Explain what you can see. Never promise a refund (a person decides); say you're checking it right now.",
  website: "Website or checkout problem: apologize, ask what they see (device, the step it fails at) and offer to help place the order. Don't promise a fix date.",
  praise: "They're thanking us: a short, warm, personal thank-you. No selling.",
  feedback: "Feedback or complaint: thank them for telling us, own it simply, say you're passing it to the team. No excuses.",
  suggestion: "Product suggestion: thank them, say you've passed it to the product team. Never promise it will be made.",
  account: "Account, emails or unsubscribe: help simply. To stop marketing emails, confirm you'll take care of it.",
  other: "Answer what they actually asked, simply and kindly."
};
async function claude(prompt, ms = 38000) {
  const r = await fetch("https://api.anthropic.com/v1/messages", { signal: AbortSignal.timeout(Math.max(5000, ms)), method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY || "", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || "claude-opus-5-5", max_tokens: 1500, messages: [{ role: "user", content: prompt }] }) });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error?.message || `Claude ${r.status}`);
  return (j.content || []).map(b => b.text || "").join("");
}
// Ella's draft for one card (training only, never sent). note = David's/Michelle's teaching for this reply.
// Everything is awaited and time-boxed: nothing keeps running after the job answers (Nov 19: a save left running after the
// job ended was frozen mid-way by Vercel and kept a database row locked).
const within = (p, ms, fallback) => Promise.race([p.catch(() => fallback), new Promise(r => setTimeout(() => r(fallback), Math.max(500, ms)))]);
export async function draftTopic(id, note = "", deadline = Date.now() + 50000) { return draftTopic1(id, note, deadline, { at: "start" }); }
async function draftTopic1(id, note, deadline, st) {
  const d = await getDoc("svc_topics", id); if (!d) throw new Error("Not found");
  await putDoc("svc_topics", id, { status: "drafting", draftStartedAt: Date.now() }, true);
  try {
    st.at = "order lookup";
    const [orders, track, cat] = await Promise.all([within(findOrders(d.message, d.email), 10000, []), within(orderFacts(d.message, d.email), 10000, []),
      ["product", "shrinkage", "other"].includes(d.topic) ? getDoc("svc_meta", "catalog").then(c => c?.text || "").catch(() => "") : ""]);
    const ft = track.length ? track.map(o => `Order ${o.order} placed ${o.placed}: ${o.shipping}, ${o.paid}${o.refunded ? `, refunded $${o.refunded} of $${o.total}` : ""}. Items: ${o.items.join(", ")}. ${o.shipments.map(s => `Shipment ${s.status || ""}${s.shipped ? ` sent ${s.shipped}` : ""}${s.delivered ? ` delivered ${s.delivered}` : ""}${s.tracking.map(x => ` (${x.company || "carrier"} ${x.number || ""}${x.url ? " " + x.url : ""})`).join("")}`).join("; ")}`).join("\n") : "No order found.";
    st.at = "lessons"; const lessons = await lessonsForPrompt().catch(() => "");
    st.at = "writing";
    const t = await claude(`You are Ella from CO36 (men's clothing), the customer care concierge. Warm, personal, short (20 to 90 words), never corporate, never mention AI.
Never refund or promise a refund, never give discount codes, never promise a date or time frame. Sign off exactly:
Talk soon,
Ella · CO36
This is a DRAFT for training: a teammate reads it before anything is sent.
${lessons}
Why they wrote: ${TOPICS[d.topic] || "Other"}. ${GUIDE[d.topic] || GUIDE.other}
${note ? `\nINSTRUCTION FOR THIS REPLY (follow it): ${note}\n` : ""}
Customer: ${d.customer || "unknown"}
Subject: ${d.subject || ""}
${d.earlier ? `Their first message in this conversation: ${d.earlier}\n` : ""}${d.teamReply ? `Our last reply to them: ${d.teamReply}\n` : ""}Their newest message:
${String(d.message || "").slice(0, 2500)}
${sizeFacts(d.message || "") || ""}
Order and shipping facts:
${ft}
${orders.length ? `Stock for what they bought:\n${facts(orders)}` : ""}
${cat ? `Catalog (active products, "(sold out)" = not in stock):\n${cat}` : ""}

Answer with JSON only: {"plan":"what you're doing, under 12 words","confidence":"known"|"new","needs":"what a teammate must check or do before this goes out, or empty","reply":"the email"}
"known" only if everything in the reply comes straight from the facts above or the teachings.`, deadline - Date.now() - 4000);
    const o = JSON.parse(t.match(/\{[\s\S]*\}/)?.[0] || "{}"); if (!o.reply) throw new Error("no reply came back");
    await putDoc("svc_topics", id, { status: "draft", draft: o.reply, plan: o.plan || "", needs: o.needs || "", confidence: o.confidence === "known" && !note ? "known" : "new",
      factsText: ft.slice(0, 900), draftedAt: Date.now(), error: null, ...(note ? { lastNote: note } : {}) }, true);
  } catch (e) { await putDoc("svc_topics", id, { status: "error", error: String(e.message || e).slice(0, 200), tries: (d.tries || 0) + 1 }, true); }
}
