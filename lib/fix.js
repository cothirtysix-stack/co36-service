// "Fix it before they know": find shipping problems in Shopify before the customer writes in.
// One Shopify bulk export of the last 30 days of orders, then a closer look at packages that have been moving too long.

const DAY = 864e5;
export const SKIP_TAGS = ["Pre order Mock", "original-merged", "sample-request"]; // left out of "not shipped": pre-orders wait on stock, merged originals never ship themselves, creator samples
const notPhysical = t => /gift ?card|package protection|e-gift/i.test(t || "");

export const bulkQuery = sinceIso => `{ orders(query: "created_at:>=${sinceIso} -status:cancelled") { edges { node {
  id name createdAt tags displayFulfillmentStatus email customer { firstName lastName }
  fulfillments { id createdAt inTransitAt deliveredAt displayStatus estimatedDeliveryAt trackingInfo { number company url } }
  lineItems { edges { node { title variantTitle quantity } } } } } } }`;

// Bulk JSONL: one line per order, then one line per line item carrying __parentId.
export function parseBulk(text) {
  const orders = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const o = JSON.parse(line);
    if (o.__parentId) { const p = orders.get(o.__parentId); if (p) p.items.push({ title: o.title, variant: o.variantTitle, qty: o.quantity }); }
    else orders.set(o.id, { ...o, items: [] });
  }
  return [...orders.values()];
}

const who = o => [o.customer?.firstName, o.customer?.lastName ? o.customer.lastName[0] + "." : ""].filter(Boolean).join(" ") || o.email || "Customer";
const product = o => { const it = o.items.filter(i => !notPhysical(i.title)); if (!it.length) return ""; const f = it[0];
  return [f.title, f.variant].filter(Boolean).join(" · ") + (it.length > 1 ? ` +${it.length - 1} more` : ""); };
const base = (o, f) => ({ order: o.name, orderId: o.id, customer: who(o), email: o.email || null, product: product(o),
  carrier: f?.trackingInfo?.[0]?.company || null, tracking: f?.trackingInfo?.[0]?.number || null, trackingUrl: f?.trackingInfo?.[0]?.url || null, ordered: o.createdAt });

// First pass. Returns problems plus fulfillments that need their last carrier scan checked.
export function classify(orders, now = Date.now()) {
  const problems = [], needEvents = [], notShipped = { count: 0, byProduct: {}, oldest: [] }, onHold = { count: 0 };
  for (const o of orders) {
    const tags = o.tags || [];
    if (!o.items.some(i => !notPhysical(i.title))) continue;
    const age = (now - Date.parse(o.createdAt)) / DAY;
    if (o.displayFulfillmentStatus === "ON_HOLD") { onHold.count++; continue; }
    if (o.displayFulfillmentStatus === "UNFULFILLED") {
      if (age < 5 || tags.some(t => SKIP_TAGS.includes(t)) || o.items.some(i => /^pre ?order/i.test(i.title || ""))) continue;
      notShipped.count++;
      o.items.filter(i => !notPhysical(i.title)).forEach(i => { notShipped.byProduct[i.title] = (notShipped.byProduct[i.title] || 0) + (i.qty || 1); });
      notShipped.oldest.push({ ...base(o), days: Math.floor(age) });
      continue;
    }
    for (const f of o.fulfillments || []) {
      if (!f.trackingInfo?.length || f.displayStatus === "DELIVERED" || f.deliveredAt) continue;
      const made = Date.parse(f.createdAt), moved = f.inTransitAt ? Date.parse(f.inTransitAt) : null;
      const late = f.estimatedDeliveryAt && now - Date.parse(f.estimatedDeliveryAt) > 2 * DAY;
      const p = { ...base(o, f), fulfillmentId: f.id, labelAt: f.createdAt, firstScanAt: f.inTransitAt, eta: f.estimatedDeliveryAt };
      if (f.displayStatus === "FAILURE" || f.displayStatus === "NOT_DELIVERED") problems.push({ ...p, type: "failed", what: "Carrier couldn't deliver it", since: f.createdAt });
      else if (f.displayStatus === "ATTEMPTED_DELIVERY") problems.push({ ...p, type: "attempted", what: "Delivery attempt failed", since: f.createdAt });
      else if (!moved && now - made > 2 * DAY) problems.push({ ...p, type: "notscanned", what: `Label made ${Math.round((now - made) / 36e5)}h ago, carrier never scanned it`, since: f.createdAt });
      else if (moved && (now - moved > 5 * DAY || late)) needEvents.push(p);
    }
  }
  notShipped.oldest.sort((a, b) => b.days - a.days); notShipped.oldest = notShipped.oldest.slice(0, 50);
  return { problems, needEvents, notShipped, onHold };
}

export const eventsQuery = `query($ids:[ID!]!){ nodes(ids:$ids){ ... on Fulfillment { id displayStatus events(first: 1, reverse: true, sortKey: HAPPENED_AT) { nodes { status happenedAt city province } } } } }`;

// Second pass: with the last carrier scan, decide "no movement" vs "late" vs fine.
export function classifyMoving(p, last, now = Date.now()) {
  const at = last?.happenedAt ? Date.parse(last.happenedAt) : Date.parse(p.firstScanAt);
  const where = last ? [last.city, last.province].filter(Boolean).join(", ") : "";
  const day = new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
  if (last?.status === "FAILURE") return { ...p, type: "failed", what: "Carrier couldn't deliver it", since: last.happenedAt };
  if (last?.status === "ATTEMPTED_DELIVERY") return { ...p, type: "attempted", what: "Delivery attempt failed", since: last.happenedAt };
  if (last?.status === "DELAYED") return { ...p, type: "late", what: `Carrier reported a delay${where ? " in " + where : ""}`, since: last.happenedAt };
  if (now - at > 5 * DAY) return { ...p, type: "stuck", what: `Last scan ${day}${where ? " in " + where : ""}`, since: new Date(at).toISOString() };
  if (p.eta && now - Date.parse(p.eta) > 2 * DAY) return { ...p, type: "late", what: `Was due ${new Date(p.eta).toLocaleDateString("en-US", { month: "short", day: "numeric" })}, still moving`, since: p.eta };
  return null;
}
