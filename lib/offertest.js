// Save-offer A/B test (David, Nov 19: "test different wordings until you see what makes people willing to try another size, color or style").
// Versions live in svc_experiments (the "Save-offer test" box on the Returns page). Each refund request gets one live version, split evenly
// by conversation; we count sends, and a save when the customer switches to an exchange.
import { db, init, getDoc, putDoc } from "./server.js";

let cache = null;
async function live() {
  if (cache && Date.now() - cache.t < 5 * 60e3) return cache.rows;
  await init();
  const rows = (await db()`select id, data from hub.docs where coll = 'svc_experiments' and not deleted and coalesce(data->>'context', 'save') = 'save' and (data->>'on')::boolean is true order by id`).map(r => ({ id: r.id, ...r.data }));
  cache = { t: Date.now(), rows }; return rows;
}
const hash = s => { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; };
export async function pickOffer(convId) { const vs = await live(); return vs.length ? vs[hash(convId) % vs.length] : null; }
async function bump(id, field) { if (!id) return; const v = await getDoc("svc_experiments", id); if (v) await putDoc("svc_experiments", id, { [field]: (+v[field] || 0) + 1 }, true); }
export const countSent = id => bump(id, "sent").catch(() => {});
export const countSave = id => bump(id, "exchanges").catch(() => {});
