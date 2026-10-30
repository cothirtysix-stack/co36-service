// Create exchanges the way the team does in the returns portal (cothirtysix.return.richpanel.com): order number + ZIP,
// pick the items, the reason and the new size/color, submit. Richpanel then emails the customer the prepaid label itself.
// Same GraphQL calls the portal makes (captured Oct 30 on Julian Perez #132313). Exchanges only: refunds stay with the customer.
import crypto from "node:crypto";

const API = "https://returns-api.richpanel.com/graphql", STORE = "co361141";
const HEAD = { "content-type": "application/json", origin: "https://cothirtysix.return.richpanel.com", referer: "https://cothirtysix.return.richpanel.com/create" };

async function gql(query, variables, token) {
  const r = await fetch(API, { method: "POST", headers: { ...HEAD, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query, variables }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.errors?.length) throw new Error(`Portal: ${JSON.stringify(j.errors || j).slice(0, 300)}`);
  return j.data;
}

const Q = {
  auth: `mutation Authenticate($input: AuthRequest!) { authenticate(input: $input) { accessToken success } }`,
  search: `query SearchOrder($query: StoreOrderSearchQuery!) { searchStoreOrders(query: $query) { orders { id name } } }`,
  authOrder: `mutation AuthenticateOrder($input: OrderVerificationRequest!) { authenticateOrder(input: $input) { success accessToken message } }`,
  order: `query AuthenticateStoreOrder($query: StoreOrderAuthenticationQuery!) { authenticateStoreOrder(query: $query) { success message
    order { id name email shippingAddress { zip address1 address2 city country countryCode firstName lastName phone province provinceCode }
      bundles { id nativeBundleGroupId bundleInstances { _id components { _id variantId status } } }
      lineItems { id imageUrl title name fulfillmentId fulfillmentLineItemId price quantity locationId refundableQuantity sku unitPrice unitDiscount unitLineItemTax discountedUnitPrice
        variantId variantTitle bundleId bundleSource nativeBundleGroupId nativeBundleVariantId hasReturn isStandardFlowBlocked productDetails { id productType } }
      customer { email firstName id lastName phone } }
    customer { email firstName id lastName phone } } }`,
  policies: `query GetReturnPolicies($storeId: String!, $query: ReturnPolicyQuery) { getReturnPolicies(storeId: $storeId, query: $query) { data { _id name status exchange { enabled } } } }`,
  reasons: `query R($storeId: String!, $productType: String, $lang: String, $sku: String, $returnType: String) { returnReasonsNestedByProductType(storeId: $storeId, productType: $productType, lang: $lang, sku: $sku, returnType: $returnType) { _id title outcome children { _id title outcome children { _id title outcome } } } }`,
  variants: `query V($productId: String!, $storeId: String!, $storeType: StoreType!, $currencyCode: String) { getStoreProductVariants(query: {first: 250, productId: $productId, storeId: $storeId, storeType: $storeType, currencyCode: $currencyCode}) { variants { id title inventoryQuantity price image { url } } } }`,
  create: `mutation CreateReturns($returns: CreateReturnsSimple!) { createReturns(returns: $returns) { _id status statusPageUrl orderNumber total { amount refund } exchanges { id title price quantity } } }`
};

const norm = s => String(s || "").toLowerCase().replace(/\bgrey\b/g, "gray").replace(/\s+/g, " ").trim();
// The portal's line title is "Mock Neck T-Shirt - Navy / L" (variantTitle is often empty).
const variantOf = li => li.variantTitle || String(li.title || "").split(" - ").slice(1).join(" - ");
const baseOf = li => String(li.title || "").split(" - ")[0];
const flat = list => list.flatMap(r => [r, ...flat(r.children || [])]);

// swaps: [{ from: "Black / S", to: "Black / M", qty: 3 }]   reason: "small" | "big" | "other"
// Returns { ok, dryRun, payload?, returnId, name, statusPageUrl, items } or { ok:false, why }.
export async function createExchange({ orderNumber, zip, swaps, reason = "small", dryRun = false }) {
  const num = String(orderNumber).replace(/^#+/, ""), z = String(zip || "").trim().slice(0, 5);
  const t0 = (await gql(Q.auth, { input: { userType: "CUSTOMER" } })).authenticate?.accessToken;
  const found = (await gql(Q.search, { query: { orderNumber: num, zipCode: z, storeId: STORE, storeType: "SHOPIFY" } }, t0)).searchStoreOrders?.orders?.[0];
  if (!found) return { ok: false, why: "order not found in the returns portal (order number + ZIP)" };
  const t1 = (await gql(Q.authOrder, { input: { storeId: STORE, orderNumber: `#${num}`, zipCode: z } }, t0)).authenticateOrder?.accessToken;
  const a = (await gql(Q.order, { query: { orderId: String(found.id), zipCode: "", storeId: STORE, storeType: "SHOPIFY" } }, t1)).authenticateStoreOrder;
  const o = a?.order; if (!o) return { ok: false, why: a?.message || "order details not available" };
  const addr = o.shippingAddress || {};
  const pol = (await gql(Q.policies, { storeId: STORE, query: { status: "ENABLED", countryCode: addr.countryCode || "US", stateCode: addr.provinceCode || "" } }, t1)).getReturnPolicies?.data || [];
  const policy = pol.find(p => p.exchange?.enabled) || pol[0]; if (!policy) return { ok: false, why: "no return policy for this address" };

  // Bundle components, in order, so identical lines map to distinct components (as the portal does).
  const comps = {}; (o.bundles || []).forEach(b => (b.bundleInstances || []).forEach(inst => (inst.components || []).forEach(c => (comps[`${b.nativeBundleGroupId}|${c.variantId}`] ||= []).push({ instanceId: inst._id, componentId: c._id }))));
  const used = new Set(), lineItems = [], items = [];
  for (const sw of swaps) {
    let need = Math.max(1, +sw.qty || 1);
    const pool = o.lineItems.filter(l => norm(variantOf(l)) === norm(sw.from) && !l.hasReturn && !l.isStandardFlowBlocked && (l.refundableQuantity ?? l.quantity) > 0 && !used.has(l.id));
    if (pool.length < need) return { ok: false, why: `only ${pool.length} returnable "${sw.from}" on the order (asked for ${need})` };
    for (const li of pool.slice(0, need)) {
      used.add(li.id);
      const vs = (await gql(Q.variants, { productId: String(li.productDetails?.id), storeId: STORE, storeType: "SHOPIFY", currencyCode: "USD" }, t1)).getStoreProductVariants?.variants || [];
      const to = vs.find(v => norm(v.title) === norm(sw.to));
      if (!to) return { ok: false, why: `"${sw.to}" doesn't exist for ${li.title}` };
      if (!(to.inventoryQuantity > 0)) return { ok: false, why: `"${sw.to}" is out of stock`, outOfStock: true };
      const rs = flat((await gql(Q.reasons, { storeId: STORE, productType: li.productDetails?.productType || "", lang: "en", sku: li.sku, returnType: "standard" }, t1)).returnReasonsNestedByProductType || []);
      const want = reason === "big" ? /too (big|large)/i : reason === "small" ? /too small/i : /different item|didn.t fit/i;
      const rr = rs.find(r => want.test(r.title)) || rs.find(r => /didn.t fit/i.test(r.title)); if (!rr) return { ok: false, why: "no matching return reason" };
      // As the portal sends it: price = unitPrice (already after the discount, e.g. 48 - 4.80 = 43.20), plus the discount itself.
      const disc = +li.unitDiscount || 0, price = li.unitPrice != null ? +li.unitPrice : Math.round((+li.price - disc) * 100) / 100;
      const comp = li.nativeBundleGroupId ? (comps[`${li.nativeBundleGroupId}|${li.variantId}`] || []).shift() : null;
      lineItems.push({ name: li.name || li.title, locationId: li.locationId, lineItemId: li.id, discount: disc, price, tax: +li.unitLineItemTax || 0, sku: li.sku,
        imageUrl: li.imageUrl, quantity: 1, outcome: "EXCHANGE", fulfillmentId: li.fulfillmentId, reason: rr._id, comments: "", attachments: [], customerInputs: [], fulfillmentLineItemId: li.fulfillmentLineItemId,
        ...(li.bundleId ? { bundleId: li.bundleId, bundleSource: li.bundleSource, nativeBundleGroupId: li.nativeBundleGroupId, nativeBundleVariantId: li.nativeBundleVariantId } : {}),
        ...(comp ? { instanceId: comp.instanceId, componentId: comp.componentId } : {}),
        exchanges: [{ lineItemId: li.id, exchangeToId: li.id, variantId: String(to.id).replace(/\D/g, ""), image: to.image?.url || li.imageUrl, price: +to.price, quantity: 1, title: `${baseOf(li)} - ${to.title}`, discount: disc, tax: 0 }] });
      items.push(`${baseOf(li)} ${variantOf(li)} → ${to.title}`);
    }
  }
  const c = o.customer || a.customer || {};
  const payload = { customer: { id: String(c.id || ""), email: c.email || o.email, name: [c.firstName || addr.firstName, c.lastName || addr.lastName].filter(Boolean).join(" "), phone: c.phone || addr.phone || "",
      address1: addr.address1 || "", address2: addr.address2 || "", city: addr.city || "", province: addr.province || "", provinceCode: addr.provinceCode || "", country: addr.country || "", countryCode: addr.countryCode || "", postalCode: addr.zip || z },
    lineItems, orderId: String(o.id), orderNumber: `#${num}`, store: { storeId: STORE, type: "SHOPIFY" }, type: "NORMAL_RETURN", policyId: policy._id, clientSubmissionId: crypto.randomUUID() };
  if (dryRun) return { ok: true, dryRun: true, items, policy: policy.name, payload };
  const made = (await gql(Q.create, { returns: payload }, t1)).createReturns;
  return { ok: !!made?._id, returnId: made?._id, name: made?.orderNumber ? `${made.orderNumber}` : null, statusPageUrl: made?.statusPageUrl, items, total: made?.total };
}
