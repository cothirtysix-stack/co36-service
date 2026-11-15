// "Where's my order" / "where's my refund" → Michelle (David, Nov 15). PREP MODE: nothing here is sent to customers.
// 1) Ella drafts a short holding reply (sorry, I'm looking into it). 2) A pinned "Needs Michelle" card shows the facts.
// 3) Michelle tells Ella what happened (to Ella, not the customer). 4) Ella drafts the follow-up from Michelle's note.
import { shopify } from "./shopify.js";
import { putDoc, getDoc } from "./server.js";
import { plainText } from "./ella.js";
import { lessonsForPrompt } from "./learn.js";

export const ASKS_SEND = false; // prep only until David says go

// The facts Michelle needs on the card: order, fulfillment + tracking, refunds, returns.
export async function orderFacts(text, email) {
  const nums = [...new Set((String(text).match(/#?\b(1\d{5}|[2-9]\d{4})\b/g) || []).map(n => n.replace("#", "")))].slice(0, 2);
  const q = nums.length ? nums.map(n => `name:${n}`).join(" OR ") : email ? `email:${String(email).toLowerCase()}` : "";
  if (!q) return [];
  const j = await shopify(`query($q:String){ orders(first: 2, query: $q, sortKey: CREATED_AT, reverse: true){ nodes { name createdAt displayFinancialStatus displayFulfillmentStatus returnStatus
    totalPriceSet { shopMoney { amount } } totalRefundedSet { shopMoney { amount } }
    fulfillments(first: 3) { createdAt displayStatus deliveredAt inTransitAt estimatedDeliveryAt trackingInfo(first: 2) { company number url } }
    lineItems(first: 10) { nodes { title variantTitle quantity } } } } }`, { q });
  return (j.data?.orders?.nodes || []).map(o => ({
    order: o.name, placed: String(o.createdAt).slice(0, 10), paid: o.displayFinancialStatus, shipping: o.displayFulfillmentStatus, returnStatus: o.returnStatus,
    total: +o.totalPriceSet.shopMoney.amount || 0, refunded: +o.totalRefundedSet.shopMoney.amount || 0,
    items: o.lineItems.nodes.filter(l => !/protection|gift ?card/i.test(l.title)).map(l => `${l.quantity}x ${l.title}${l.variantTitle ? " " + l.variantTitle : ""}`),
    shipments: (o.fulfillments || []).map(f => ({ status: f.displayStatus, shipped: f.createdAt ? String(f.createdAt).slice(0, 10) : null, delivered: f.deliveredAt ? String(f.deliveredAt).slice(0, 10) : null,
      eta: f.estimatedDeliveryAt ? String(f.estimatedDeliveryAt).slice(0, 10) : null, tracking: (f.trackingInfo || []).map(t => ({ company: t.company, number: t.number, url: t.url })) }))
  }));
}
const factsText = orders => orders.length ? orders.map(o => `Order ${o.order} placed ${o.placed}: ${o.shipping}, ${o.paid}${o.refunded ? `, refunded $${o.refunded} of $${o.total}` : ""}${o.returnStatus && o.returnStatus !== "NO_RETURN" ? `, return ${o.returnStatus.toLowerCase()}` : ""}. Items: ${o.items.join(", ")}. ${o.shipments.map(s => `Shipment ${s.status || ""}${s.shipped ? ` sent ${s.shipped}` : ""}${s.delivered ? ` delivered ${s.delivered}` : ""}${s.tracking.map(t => ` (${t.company || "carrier"} ${t.number || ""})`).join("")}`).join("; ")}`).join("\n") : "No order found.";

async function claude(prompt) {
  const r = await fetch("https://api.anthropic.com/v1/messages", { signal: AbortSignal.timeout(40000), method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY || "", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || "claude-opus-5-5", max_tokens: 2000, messages: [{ role: "user", content: prompt }] }) });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error?.message || `Claude ${r.status}`);
  return (j.content || []).map(b => b.text || "").join("").trim();
}
const VOICE = `You are Ella from CO36 (men's clothing). Short (15 to 60 words), warm, personal, never corporate, never mention AI. No discount codes. Never promise a date or a time frame. Sign off exactly:
Talk soon,
Ella · CO36`;

// Step 1: the holding reply + the card for Michelle.
export async function draftAsk(id, { kind, who, mail, subject, message }) {
  try {
    const orders = await orderFacts(message, mail).catch(() => []);
    const holding = await claude(`${VOICE}
${await lessonsForPrompt().catch(() => "")}
The customer is asking ${kind === "refund" ? "where their refund is" : "where their order is"}. Write a short, sincere first reply: apologize for the wait, say you're personally looking into it right now. Don't explain what went wrong, don't guess, don't share tracking yet, no time promises.
Customer: ${who || "unknown"}
Their message: ${plainText(message).slice(0, 2000)}
Write only the email.`);
    await putDoc("svc_asks", id, { status: "needs_michelle", holding, orders, factsText: factsText(orders), draftedAt: Date.now() }, true);
  } catch (e) { await putDoc("svc_asks", id, { status: "error", error: String(e.message || e).slice(0, 200) }, true); }
}

// Step 3→4: Michelle's note (to Ella) becomes the follow-up draft to the customer.
export async function followUp(id, note, by) {
  const a = await getDoc("svc_asks", id); if (!a) throw new Error("Not found");
  const orders = await orderFacts(a.message, a.email).catch(() => a.orders || []);
  const reply = await claude(`${VOICE}
${await lessonsForPrompt().catch(() => "")}
You already told the customer you were looking into ${a.kind === "refund" ? "their refund" : "their order"}. Your teammate Michelle checked and told you (internal, don't quote her or mention her name): "${note}"
Write the follow-up to the customer based on what she found. If there's tracking in the facts and it's relevant, include the tracking link. Be honest and kind; if something went wrong on our side, own it simply.
Customer: ${a.customer || "unknown"}
Their message: ${plainText(a.message).slice(0, 1500)}
Facts: ${factsText(orders)}
${orders.flatMap(o => o.shipments.flatMap(s => s.tracking)).filter(t => t.url).map(t => `Tracking link: ${t.url}`).join("\n")}
Write only the email.`);
  await putDoc("svc_asks", id, { status: "follow_up_ready", michelleNote: note, michelleBy: by || "", michelleAt: Date.now(), followUp: reply, orders, factsText: factsText(orders) }, true);
  return reply;
}
