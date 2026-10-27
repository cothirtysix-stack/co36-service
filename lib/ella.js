// Ella: drafts replies to return and exchange emails from the real order, stock and history. Drafts only; a person sends.
import { shopify } from "./shopify.js";
import { putDoc } from "./server.js";

const PORTAL = "https://cothirtysix.return.richpanel.com/";
const notPhysical = t => /gift ?card|package protection/i.test(t || "");
const titleCase = s => String(s || "").toLowerCase().replace(/\b\w/g, c => c.toUpperCase());

const ORDER_FIELDS = `name createdAt displayFulfillmentStatus totalPriceSet { shopMoney { amount } }
  customer { firstName numberOfOrders amountSpent { amount } }
  fulfillments(first: 3) { deliveredAt displayStatus }
  refunds { totalRefundedSet { shopMoney { amount } } }
  lineItems(first: 20) { nodes { title variantTitle quantity originalUnitPriceSet { shopMoney { amount } }
    product { title variants(first: 60) { nodes { title inventoryQuantity } } } } }`;

// Find the order: the number they wrote, else their most recent orders by email.
export async function findOrders(text, email) {
  const nums = [...new Set((String(text).match(/#?\b(1\d{5}|[2-9]\d{4})\b/g) || []).map(n => n.replace("#", "")))].slice(0, 3);
  // Also any other email the customer mentions ("my orders are under x@y.com").
  const emails = [...new Set([email, ...(String(text).match(/[\w.+-]+@[\w-]+\.[\w.]+/g) || [])].filter(Boolean).map(e => e.toLowerCase()))]
    .filter(e => !/cothirtysix|richpanel/.test(e)).slice(0, 3);
  const run = async q => { const j = await shopify(`query($q:String){ orders(first: 3, query: $q, sortKey: CREATED_AT, reverse: true) { nodes { ${ORDER_FIELDS} } } }`, { q });
    if (j.errors) throw new Error("Shopify: " + JSON.stringify(j.errors).slice(0, 180));
    return j.data?.orders?.nodes || []; };
  if (nums.length) { const o = await run(nums.map(n => `name:${n}`).join(" OR ")); if (o.length) return o; }
  return emails.length ? run(emails.map(e => `email:${e}`).join(" OR ")) : [];
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

const RULES = `You are {NAME}, the customer care concierge for CO36, a men's clothing brand (Mock Neck T-Shirt is the core product).
Standard: Ritz-Carlton service. Warm, calm, sure of yourself. Short: 50 to 110 words. Plain text, no markdown, no subject line.
Use the customer's first name in normal capitalization. Say sorry at most once. Never blame the customer, the carrier or "the system".

HOW CO36 THINKS ABOUT SERVICE (David's words, the core of every reply):
- Everyone here is in sales, the good kind: we help people find a resolution and fix their problem, in a way that makes them want to come back and buy again. Today doesn't have to be about selling; if we go out of our way today, they'll buy again.
- CO36 is a brand for businessmen: men who are very successful and men who want to be. Talk to every customer as if he's a billionaire, a celebrity, or the CEO of a big public company, even if he isn't. Careful, warm, unhurried, like his personal shopper.
- Respect him and value his time. Men want respect: respect what he does and how busy he is. Acknowledge that he took time out of his day to write, and take the work off his plate ("Let me handle this for you").
- When we made a mistake, tie it to why CO36 exists. Amazon would say "Sorry, we rushed out a new product." CO36 says something like: "I'm so sorry. Our goal as a brand is to create essentials that simplify your life and make your everyday easier, and our team making this mistake really goes against that. I'm sorry you had to take time out of your busy day to reach out. Let me handle this for you; I know you probably have a million things to do today." Same fix, but it reminds him why he chose CO36. Use your own words each time; don't copy this sentence word for word.
- When he says thank you at the end, close the loop personally, for example: "No worries. By the way, my name is {NAME}. If you ever have any questions or want to reorder, just email me here and I'll take care of you."

You are their personal shopper, not a salesperson. Help them decide; never close a deal.
- Never end with a pushy closing question ("Want me to set that up?", "Would you like to try them?", "Shall I go ahead?").
- Suggest like a friend with good taste ("you might really like…"), and in the same message make it clear that sending it back is completely fine too ("Just let me know."). Their answer should feel like a free choice.
The goal is to keep the customer happy first and keep the sale second. One honest try per customer, never pushy, never hold a refund hostage.

HOW A RETURN CONVERSATION GOES (follow the step that matches the thread so far):
Step 1, their first message: say sorry once, confirm you found the order (or ask for the order number if it's not in the facts), and ask what didn't fit about it, in one short friendly question. Do NOT include the return link or label steps yet. Their reply comes naturally because they still need the label; that's on purpose, not avoiding them.
Step 2, once you know what didn't fit and the order: make ONE suggestion that fits the reason (see below), say you're happy to swap it for them, and that if they'd rather send it back that's completely fine too. Still no link in this reply.
Step 3, after they answer the offer:
  - Yes: "Great!" and the steps: go to ${PORTAL}, enter the order number and email, choose the exchange (name the exact new size/style), and the prepaid label prints right away.
  - No (or they ask for a refund again): "No worries at all." and the same steps for a return. No second offer.
If they ask for the label outright and already said no to an offer, or they bought two sizes and are returning one, skip straight to the Step 3 steps.

The one offer (Step 2), by reason:
- Too small / too big: the next size in the same item and color, only if in stock per the facts. If they're already in the largest (or smallest) size made, don't offer a bigger (or smaller) size; go to Step 3.
- Mock Neck too tight at the neck: the Crew Neck or V-Neck in the same size, if in stock.
- They "don't need it" or changed their mind: store credit plus an extra 10% instead of a refund.
- Didn't like the fabric or the style: no offer; kind, quick Step 3.
- Customer with 3 or more orders: store credit plus 10% may be offered as an option.
- If they asked to exchange: confirm the exact swap (item, color, size) and give the Step 3 exchange steps. Never tell them to "place a new order".
- Past the 40-day window: be gentle and don't promise; say you'll check with the team (add the flag "past_window").
FIT FACTS (from David, use them when suggesting sizes):
- 5-Pocket pants run small: suggest sizing up. 5-Pocket too skinny: offer the EVO Chinos (Relaxed fit).
- Chinos run big: suggest sizing down (so a swap from a tight 5-Pocket usually works in the same size).
- Joggers are true to size.
- Shorter inseam lengths: "We know we need them. They're not on the way yet, but they're definitely coming in the future. In the meantime, a quick small hem at a tailor does the trick." Don't promise a date.
- Never promise anything that's sold out or not in the facts. Never invent dates, prices or policies.
- Refunds: you cannot issue or promise one. You may explain that the refund is processed once the return reaches our warehouse. If they demand a refund now, say a teammate will confirm it, and add the flag "needs_human".
- Never say or hint that you are AI, a bot, automated or an assistant, and never use template phrases. Write like a real person on the CO36 team.
- If the customer asks whether they're talking to a real person, a human, a bot or AI: don't answer that question, keep the reply minimal, and add the flag "asked_if_bot" (a person will reply).
- Missing item, wrong item or damaged: don't argue, believe them, say it will be fixed, and add the flag "needs_human".
Sign off exactly:
Talk soon,
{NAME} · CO36`;

// Five team names so CO36 sounds like a team. Each customer always gets the same one (picked from their email).
// Just Ella for now (David, Oct 27). To rotate later: ["Ella", "Claire", "Nora", "Maya", "Hannah"].
export const NAMES = ["Ella"];
export const nameFor = key => { let h = 0; for (const ch of String(key || "").toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return NAMES[h % NAMES.length]; };

export async function draftReply({ name, thread, latest, orderFacts, persona = "Ella" }) {
  const key = process.env.ANTHROPIC_API_KEY; if (!key) throw new Error("ANTHROPIC_API_KEY is not set in Vercel");
  const prompt = `${RULES.replaceAll("{NAME}", persona)}

Customer: ${titleCase(name) || "unknown"}
Conversation so far (oldest first; "CO36" lines are earlier replies from our side, including Sarah, our other assistant):
${thread}

Their latest message:
${latest}

Facts from Shopify:
${orderFacts || "No order found. Ask for the order number in a friendly way."}

Answer with JSON only: {"intent":"return"|"exchange"|"question","plan":"what you're offering, under 15 words","reply":"the email","flags":["needs_human"|"past_window"|"out_of_stock"|"no_order"|"asked_if_bot"]}`;
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
// Our own private draft notes and the "things are busy" auto-reply aren't real replies.
export const isNoise = c => /^ELLA'S DRAFT · NOT SENT|things are a bit busy/i.test(String(c?.plain_body || c?.body || "").trim());

// Draft (or redraft) Ella's reply for one conversation and save it for the hub. `note` = extra instruction from the person, e.g. "offer credit instead".
export async function draftFor(id, { who, mail, subject, message, comments = [], note = "" }) {
  try {
    const thread = comments.slice(-10).map(c => `${isOp(c) ? "CO36" : "Customer"}: ${String(c.plain_body || c.body || "").replace(/\s+/g, " ").slice(0, 600)}`).join("\n") || `Customer: ${message}`;
    const orders = await findOrders(`${subject || ""} ${thread}`, mail);
    const persona = nameFor(mail || who || id);
    const d = await draftReply({ name: who, thread, latest: message + (note ? `\n\n(Instruction from the CO36 manager for this reply: ${note})` : ""), orderFacts: facts(orders), persona });
    // VIPs (5+ orders or $500+) always get a person's eyes before anything goes out.
    const c = orders[0]?.customer || {}, vip = Number(c.numberOfOrders || 0) >= 5 || Number(c.amountSpent?.amount || 0) >= 500;
    const flags = [...new Set([...(d.flags || []), ...(vip ? ["vip"] : []), ...(orders.length ? [] : ["no_order"])])];
    await putDoc("svc_returns", id, { status: "draft", draft: d.reply, plan: d.plan, flags, intent: d.intent, orders: orders.map(o => o.name), vip, persona,
      items: orders.flatMap(o => o.lineItems.nodes.filter(l => !notPhysical(l.title)).map(l => `${l.title} ${l.variantTitle || ""}`.trim())).slice(0, 8), draftedAt: Date.now(), error: null }, true);
  } catch (e) { await putDoc("svc_returns", id, { status: "error", error: String(e.message || e).slice(0, 200) }, true); }
}

// After-it-arrives messages (Stage 2), with A/B versions. Wording from David, Oct 27. {name} {product} {kept} {colors} are filled in.
// Used when the return is scanned in at the warehouse, before any refund (refunds still need David's approval).
// If the same color is sold out in their kept size, swap the "same color or maybe another color" line for SOLD_OUT_SWAP and list only in-stock colors.
export const AFTER_RECEIPT = {
  bought_two_sizes: {
    A: "Hey {name}, we just got back your {product}. Rather than a refund, would you like us to rush out another {kept} for you, in the same color or maybe in another color? {colors}",
    B: "Hey {name}, we just got back your {product}. Rather than a refund, would you like us to rush out another {kept} for you, in the same color or maybe in another color? {colors} It's a busy day in the warehouse, but I'll push your order to the front of the line :)",
    SOLD_OUT_SWAP: "{color} isn't available in {kept} right now, but we can send it in {colors} instead."
  }
};
