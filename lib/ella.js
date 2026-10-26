// Ella: drafts replies to return and exchange emails from the real order, stock and history. Drafts only; a person sends.
import { shopify } from "./shopify.js";
import { putDoc } from "./server.js";

const PORTAL = "https://cothirtysix.return.richpanel.com/";
const notPhysical = t => /gift ?card|package protection/i.test(t || "");
const titleCase = s => String(s || "").toLowerCase().replace(/\b\w/g, c => c.toUpperCase());

const ORDER_FIELDS = `name createdAt displayFulfillmentStatus totalPriceSet { shopMoney { amount } }
  customer { firstName numberOfOrders amountSpent { amount } }
  fulfillments(first: 3) { deliveredAt displayStatus }
  returns(first: 3) { nodes { name status } }
  refunds { totalRefundedSet { shopMoney { amount } } }
  lineItems(first: 20) { nodes { title variantTitle quantity originalUnitPriceSet { shopMoney { amount } }
    product { title variants(first: 60) { nodes { title inventoryQuantity } } } } }`;

// Find the order: the number they wrote, else their most recent orders by email.
export async function findOrders(text, email) {
  const nums = [...new Set((String(text).match(/#?\b(1\d{5}|[2-9]\d{4})\b/g) || []).map(n => n.replace("#", "")))].slice(0, 3);
  const q = nums.length ? nums.map(n => `name:${n}`).join(" OR ") : email ? `email:${email}` : null;
  if (!q) return [];
  const j = await shopify(`query($q:String){ orders(first: 3, query: $q, sortKey: CREATED_AT, reverse: true) { nodes { ${ORDER_FIELDS} } } }`, { q });
  return j.data?.orders?.nodes || [];
}

// Compact facts for the prompt: what they bought, sizes that exist, what's in stock in their color.
export function facts(orders) {
  return orders.map(o => {
    const delivered = o.fulfillments?.map(f => f.deliveredAt).filter(Boolean).sort().pop() || null;
    const days = delivered ? Math.floor((Date.now() - Date.parse(delivered)) / 864e5) : null;
    const items = o.lineItems.nodes.filter(l => !notPhysical(l.title)).map(l => {
      const [color, size] = String(l.variantTitle || "").split(" / ");
      const vs = l.product?.variants?.nodes || [];
      const sizes = [...new Set(vs.map(v => v.title.split(" / ")[1]).filter(Boolean))];
      const sameColor = vs.filter(v => v.title.split(" / ")[0] === color).map(v => `${v.title.split(" / ")[1]}:${v.inventoryQuantity > 0 ? "in stock" : "sold out"}`);
      return `- ${l.quantity}x ${l.title} ${l.variantTitle || ""} ($${l.originalUnitPriceSet.shopMoney.amount}). Sizes made: ${sizes.join(", ") || "?"}. Same color stock: ${sameColor.join(", ") || "?"}`;
    });
    return `Order ${o.name}, placed ${o.createdAt.slice(0, 10)}, ${o.displayFulfillmentStatus}${delivered ? `, delivered ${delivered.slice(0, 10)} (${days} days ago; return window is 40 days from delivery)` : ", not delivered yet"}. Total $${o.totalPriceSet.shopMoney.amount}.` +
      (o.returns?.nodes?.length ? ` Returns already open: ${o.returns.nodes.map(r => `${r.name} ${r.status}`).join(", ")}.` : "") +
      ` Customer has ${o.customer?.numberOfOrders || "?"} orders, $${o.customer?.amountSpent?.amount || "?"} spent.\n${items.join("\n")}`;
  }).join("\n\n");
}

const RULES = `You are Ella, the customer care concierge for CO36, a men's clothing brand (Mock Neck T-Shirt is the core product).
Standard: Ritz-Carlton service. Warm, calm, sure of yourself. Short: 50 to 110 words. Plain text, no markdown, no subject line.
Use the customer's first name in normal capitalization. Say sorry at most once. Never blame the customer, the carrier or "the system".

The goal is to keep the customer happy first and keep the sale second. One honest try per customer, never pushy, never hold a refund hostage.
- If you don't know why they're returning, ask in one friendly line, and in the same reply say the label is easy (so it's never a dead end).
- Too big / too small: offer the exact other size in the same item and color, only if it's in stock per the facts. If they're already in the largest (or smallest) size made, don't offer a bigger (or smaller) size: just make the return easy.
- Mock Neck too tight at the neck: suggest the Crew Neck or V-Neck in the same size, if in stock.
- They "don't need" it or changed their mind: offer once to turn it into store credit plus an extra 10%, otherwise the return is easy.
- Didn't like the fabric or the style: kind and quick, no push.
- Bought two sizes and returning one: send them to the return, no questions, no push.
- Customer with 3 or more orders: you may offer store credit plus 10% as an option.
- If they asked to exchange: confirm the exact swap (item, color, size) and say it ships as soon as the return is on its way. Never tell them to "place a new order".
- Labels: the customer starts the return at ${PORTAL} with their order number and email, picks the items, and the prepaid label is made right away. Mention it only when they need a label.
- Past the 40-day window: be gentle and don't promise; say you'll check with the team (add the flag "past_window").
- Never promise anything that's sold out or not in the facts. Never invent dates, prices or policies.
- Missing item, wrong item or damaged: don't argue, believe them, say it will be fixed, and add the flag "needs_human".
Sign off exactly:
Talk soon,
Ella · CO36`;

export async function draftReply({ name, thread, latest, orderFacts }) {
  const key = process.env.ANTHROPIC_API_KEY; if (!key) throw new Error("ANTHROPIC_API_KEY is not set in Vercel");
  const prompt = `${RULES}

Customer: ${titleCase(name) || "unknown"}
Conversation so far (oldest first; "CO36" lines are earlier replies from our side, including Sarah, our other assistant):
${thread}

Their latest message:
${latest}

Facts from Shopify:
${orderFacts || "No order found. Ask for the order number in a friendly way."}

Answer with JSON only: {"intent":"return"|"exchange"|"question","plan":"what you're offering, under 15 words","reply":"the email","flags":["needs_human"|"past_window"|"out_of_stock"|"no_order"]}`;
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || "claude-opus-5-5", max_tokens: 1200, messages: [{ role: "user", content: prompt }] }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || `Claude ${r.status}`);
  const t = (j.content || []).map(b => b.text || "").join("");
  const o = JSON.parse(t.match(/\{[\s\S]*\}/)?.[0] || "{}");
  if (!o.reply) throw new Error("Claude returned no reply");
  return { intent: o.intent || "return", plan: o.plan || "", reply: String(o.reply).trim(), flags: Array.isArray(o.flags) ? o.flags : [] };
}

// Look a Richpanel conversation up by its number (used by "Rewrite").
export async function loadTicket(number) {
  const r = await fetch(`https://api.richpanel.com/v1/tickets/number/${number}`, { headers: { "x-richpanel-key": process.env.RICHPANEL_API_KEY || "" } });
  return r.ok ? (await r.json()).ticket : null;
}
export const isOp = c => !!(c.is_operator ?? c.isOperator);

// Draft (or redraft) Ella's reply for one conversation and save it for the hub. `note` = extra instruction from the person, e.g. "offer credit instead".
export async function draftFor(id, { who, mail, subject, message, comments = [], note = "" }) {
  try {
    const thread = comments.slice(-10).map(c => `${isOp(c) ? "CO36" : "Customer"}: ${String(c.plain_body || c.body || "").replace(/\s+/g, " ").slice(0, 600)}`).join("\n") || `Customer: ${message}`;
    const orders = await findOrders(`${subject || ""} ${thread}`, mail);
    const d = await draftReply({ name: who, thread, latest: message + (note ? `\n\n(Instruction from the CO36 manager for this reply: ${note})` : ""), orderFacts: facts(orders) });
    await putDoc("svc_returns", id, { status: "draft", draft: d.reply, plan: d.plan, flags: d.flags, intent: d.intent, orders: orders.map(o => o.name),
      items: orders.flatMap(o => o.lineItems.nodes.filter(l => !notPhysical(l.title)).map(l => `${l.title} ${l.variantTitle || ""}`.trim())).slice(0, 8), draftedAt: Date.now(), error: null }, true);
  } catch (e) { await putDoc("svc_returns", id, { status: "error", error: String(e.message || e).slice(0, 200) }, true); }
}
