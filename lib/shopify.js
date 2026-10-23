export const need = k => { const v = process.env[k]; if (!v) throw Object.assign(new Error(`${k} is not set in Vercel`), { status: 500, code: "tool_error" }); return v; };

let tok = null;
async function shopToken(store) {
  if (process.env.SHOPIFY_ADMIN_TOKEN) return process.env.SHOPIFY_ADMIN_TOKEN;
  if (tok && tok.exp > Date.now() + 60000) return tok.v;
  const r = await fetch(`https://${store}/admin/oauth/access_token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: need("SHOPIFY_CLIENT_ID"), client_secret: need("SHOPIFY_CLIENT_SECRET") }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw Object.assign(new Error("Shopify login failed: " + JSON.stringify(j).slice(0, 200)), { status: 502 });
  tok = { v: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 }; return tok.v;
}
export async function shopify(query, variables) {
  const store = need("SHOPIFY_STORE").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const ver = process.env.SHOPIFY_API_VERSION || "2025-10";
  const r = await fetch(`https://${store}/admin/api/${ver}/graphql.json`, { method: "POST", headers: { "content-type": "application/json", "X-Shopify-Access-Token": await shopToken(store) }, body: JSON.stringify({ query, variables }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`Shopify ${r.status}: ${JSON.stringify(j.errors || j).slice(0, 300)}`), { status: 502 });
  return j;
}
