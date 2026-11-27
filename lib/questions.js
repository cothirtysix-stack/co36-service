// Product questions (David, Nov 15): sizing, fit, fabric, care, colors, what's in stock. Ella writes a DRAFT only;
// nothing is sent from here. The team reads them on the Questions page and sends by hand until David says go.
import { shopify } from "./shopify.js";
import { putDoc, getDoc } from "./server.js";
import { findOrders, facts, plainText } from "./ella.js";
import { nextArrival } from "./incoming.js";
import { lessonsForPrompt } from "./learn.js";
import { sizeFacts } from "./sizefinder.js";

// What we sell right now: every active product with its colors, sizes and what's in stock. Cached for an hour.
export async function catalog() {
  const had = await getDoc("svc_meta", "catalog");
  if (had?.text && Date.now() - had.at < 3600e3) return had.text;
  const lines = []; let after = null;
  for (let page = 0; page < 4; page++) {
    const j = await shopify(`query($a:String){ products(first: 50, after: $a, query: "status:active"){ nodes { title productType
      priceRangeV2 { minVariantPrice { amount } } hidden: metafield(namespace: "co36", key: "hidden_colors") { value } variants(first: 100) { nodes { title inventoryQuantity } } } pageInfo { hasNextPage endCursor } } }`, { a: after });
    const c = j.data?.products; if (!c) break;
    for (const p of c.nodes) {
      if (/gift ?card|protection|^pre[\s-]*order/i.test(p.title)) continue;
      // Colors hidden on the website (co36.hidden_colors, e.g. polo new colors) are not for sale: leave them out (Nov 26).
      const hidden = String(p.hidden?.value || "").split("|").map(x => x.trim().toLowerCase()).filter(Boolean);
      const byColor = {};
      p.variants.nodes.forEach(v => { const [color, size] = v.title.split(" / "); if (!size || hidden.includes(String(color).trim().toLowerCase())) return; (byColor[color] ||= []).push(`${size}${v.inventoryQuantity > 0 ? "" : " (sold out)"}`); });
      const colors = Object.entries(byColor).map(([c, s]) => `${c}: ${s.join(", ")}`).join("; ");
      lines.push(`- ${p.title} ($${Math.round(+p.priceRangeV2.minVariantPrice.amount)})${colors ? ` · ${colors}` : ""}`);
    }
    if (!c.pageInfo.hasNextPage) break; after = c.pageInfo.endCursor;
  }
  const text = lines.join("\n").slice(0, 12000);
  await putDoc("svc_meta", "catalog", { text, at: Date.now() });
  return text;
}

// Product facts from the store's own product pages (fabric, fit, care), cached a day (Nov 26: ~75 product questions a week came back
// "needs_answer" because Ella only saw stock and sizes, not what the products are made of).
export async function productFacts() {
  const had = await getDoc("svc_meta", "productFacts");
  if (had?.text && Date.now() - had.at < 864e5) return had.text;
  const lines = []; let after = null;
  for (let page = 0; page < 4; page++) {
    const j = await shopify(`query($a:String){ products(first: 50, after: $a, query: "status:active"){ nodes { title description(truncateAt: 300) care: metafield(namespace: "arena", key: "product_detail_care") { value } chart: metafield(namespace: "arena", key: "product_size_chart") { value } } pageInfo { hasNextPage endCursor } } }`, { a: after });
    const c = j.data?.products; if (!c) break;
    // Material & care and the size chart live in the product's "arena" fields (Nov 26: e.g. Mock Neck 96% cotton / 4% spandex).
    const txt = h => String(h || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
    for (const p of c.nodes) {
      if (/gift ?card|protection|^pre[\s-]*order/i.test(p.title)) continue;
      const care = txt(p.care?.value), chart = txt(p.chart?.value).slice(0, 400), d = txt(p.description);
      if (!care && !chart && !d) continue;
      lines.push(`- ${p.title}:${care ? ` MATERIAL & CARE: ${care}.` : ""}${chart ? ` SIZE CHART: ${chart}.` : ""}${d ? ` About: ${d}` : ""}`);
    }
    if (!c.pageInfo.hasNextPage) break; after = c.pageInfo.endCursor;
  }
  const text = lines.join("\n").slice(0, 20000);
  await putDoc("svc_meta", "productFacts", { text, at: Date.now() });
  return text;
}

const RULES = `You are {NAME}, the customer care concierge for CO36, a men's clothing brand (the Mock Neck T-Shirt is the core product).
A customer asked a question about our products. Write the reply email.
- Short (15 to 70 words), warm, simple, like a helpful personal shopper. Never salesy, no discount codes, no "shop now".
- Answer ONLY from the facts below (catalog, fit facts, their orders). Never invent fabric details, measurements, prices, dates or policies. If the answer isn't in the facts, say you'll find out, and add the flag "needs_answer" (a teammate fills it in).
- Sizing: if a "Size finder" line is given below, recommend exactly that size (it is the same tool as on our product pages). If they gave no height/weight, ask for both so you can give an exact size; you can mention what they bought before. Exchanges are easy.
- Stock: only say something is available if the catalog shows it in stock in that size. If it's sold out, say so kindly and offer the closest in-stock color or style.
- Fabric, material, fit, care, features: answer from the PRODUCT PAGES section below (it's the text on our own product pages). If it isn't there, say you'll check and flag needs_answer.
- Price / discount / Black Friday (David, Nov 24): the sale prices are on the items and the welcome email's "up to 60% off" is already taken off at checkout. It is not a mistake and there's no extra code or additional discount. Never create or give a code.
- Pre-shrunk (David): say "we pre-shrink it twice before cutting", never "it won't shrink".
- Policy questions (shipping times, returns or exchange policy, international shipping, gift wrap): topic "policy". Answer only if the facts say it; otherwise say you'll check and flag needs_answer.
- Misty Blue isn't coming back (maybe spring 2027, never a promise).
- Never say or hint you are AI, a bot or automated. Never promise future actions you can't guarantee.
- If it's really a complaint, a return/exchange, a refund or an order problem rather than a product question, add the flag "not_a_question".
FIT FACTS (from David):
- 5-Pocket pants run small: suggest sizing up. 5-Pocket too skinny: offer the EVO Chinos (Relaxed fit).
- Chinos run big: suggest sizing down.
- Joggers are true to size.
- NEW COLORS (David, Nov 26, his words): "We did just add new colors, and we try to stay a more elevated, simple brand. We don't want to be fast fashion; our goal is actually to simplify your wardrobe. That being said, we do drop some new colors every month. Is there a color you'd want us to drop?" Say it in that spirit, mention the newest colors that are in stock for what they asked about (from the catalog), and always end by asking which color they'd love to see.
- MIXED SIZES IN A PACK (David, Nov 26): a 3-pack is one size for all three shirts; there's no way to mix sizes inside one pack right now. Say it kindly and help: they can pick the pack in their main size and add the other size as a single, or get a second pack. Don't promise a mixed-size option.
- TALL (David, Nov 26): our shirts don't come in tall sizes yet. Say it warmly and that we really hope to bring tall sizes soon (never promise a date). Our EVO pants DO come in a Tall 34" inseam, so mention that if it helps.
- Shorter inseam lengths: "We know we need them. They're not on the way yet, but they're definitely coming in the future. In the meantime, a quick small hem at a tailor does the trick." Don't promise a date.
Sign off exactly:
Talk soon,
{NAME} · CO36`;

export async function draftQuestion(id, { who, mail, subject, message, history = [], note = "" }) {
  try {
    const [cat, orders, pf] = await Promise.all([catalog(), findOrders(message, mail).catch(() => []), productFacts().catch(() => "")]);
    const prompt = `${RULES.replaceAll("{NAME}", "Ella")}
${await lessonsForPrompt().catch(() => "")}
Customer: ${who || "unknown"}
Subject: ${String(subject || "").slice(0, 200)}
${history.length ? `Earlier in this conversation (oldest first):\n${history.map((t, i) => `${i + 1}. Customer: ${plainText(t.msg).slice(0, 800)}\n   Our reply: ${String(t.sent || t.draft || "(not answered)").slice(0, 800)}`).join("\n")}\n\nTheir newest message:` : "Their question:"}
${plainText(message).slice(0, 3000)}
${sizeFacts([message, ...history.map(t => t.msg)].join(" ")) || ""}
${note ? `\nINSTRUCTION FROM DAVID FOR THIS REPLY (follow it): ${note}` : ""}

Their orders (may be empty):
${orders.length ? facts(orders) : "No orders found."}

${pf ? `PRODUCT PAGES (our own product descriptions: fabric, fit, care, features):\n${pf}\n\n` : ""}Catalog (active products, colors and sizes; "(sold out)" = not in stock):
${cat}

CONFIDENCE (David, Nov 15): "known" ONLY if every part of your answer comes straight from the facts above (catalog stock, the size finder, the fit facts, or David's teachings) and nothing is a guess; otherwise "new" (David will look at it first). Any flag = "new".
Answer with JSON only: {"topic":"sizing"|"fit"|"fabric"|"care"|"stock"|"price"|"policy"|"other","plan":"what you're answering, under 12 words","confidence":"known"|"new","summary":"${history.length ? "the earlier conversation in one or two short sentences" : ""}","reply":"the email","flags":["needs_answer"|"not_a_question"]}`;
    const r = await fetch("https://api.anthropic.com/v1/messages", { signal: AbortSignal.timeout(45000), method: "POST",
      headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY || "", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || "claude-opus-5-5", max_tokens: 4000, messages: [{ role: "user", content: prompt }] }) });
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error?.message || `Claude ${r.status}`);
    const t = (j.content || []).map(b => b.text || "").join(""), o = JSON.parse(t.match(/\{[\s\S]*\}/)?.[0] || "{}");
    if (!o.reply) throw new Error("no reply came back");
    const flags = (Array.isArray(o.flags) ? o.flags : []).filter(f => ["needs_answer", "not_a_question"].includes(f));
    await putDoc("svc_questions", id, { status: "draft", draft: o.reply, plan: o.plan || "", topic: o.topic || "other", flags, draftedAt: Date.now(),
      confidence: o.confidence === "known" && !flags.length && !note ? "known" : "new", orders: orders.map(x => x.name).slice(0, 3),
      ...(history.length && o.summary ? { summary: o.summary } : {}), ...(note ? { lastNote: note } : {}) }, true);
  } catch (e) { await putDoc("svc_questions", id, { status: "error", error: String(e.message || e).slice(0, 200) }, true); }
}
