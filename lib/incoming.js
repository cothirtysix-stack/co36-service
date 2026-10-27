// Incoming stock for Ella: when is a sold-out product/color arriving? Reads the inbound deliveries Google Sheet
// (same sheet as CO36 HQ, shared by link): "Master" = one row per PO line with style, color, qty, arrival date;
// "Overview" = one row per delivery with its status (Arrived / In transit / Planned).
const SHEET = () => process.env.DELIVERY_SHEET_ID || "1mla9KCtcegfqjmwyfo5BxkIzLbFQa_2dU2fhK9dDUis";
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

const parseCsv = t => { const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < t.length; i++) { const c = t[i];
    if (q) { if (c === '"' && t[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true; else if (c === ",") { row.push(cell); cell = ""; } else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; } else if (c !== "\r") cell += c; }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows; };
const csv = async gid => { const r = await fetch(`https://docs.google.com/spreadsheets/d/${SHEET()}/export?format=csv&gid=${gid}`, { redirect: "follow" });
  const t = await r.text(); return !r.ok || /^\s*<!doctype html/i.test(t) ? [] : parseCsv(t); };
const date = v => { const m = String(v || "").trim().match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,\s*(\d{4}))?/); if (!m || MONTHS[m[1].toLowerCase()] == null) return null;
  return Date.UTC(+(m[3] || new Date().getUTCFullYear()), MONTHS[m[1].toLowerCase()], +m[2]); };
// "Mock Neck T-Shirt" and "Mock Neck Tee" → "mock neck"
export const styleKey = t => String(t || "").toLowerCase().replace(/[™®]/g, "").replace(/\b(t-?shirts?|tees?|shirts?)\b/g, "").replace(/[^a-z0-9]+/g, " ").replace(/crewneck/g, "crew neck").trim();

let cache = null;
export async function incoming() {
  if (cache && Date.now() - cache.at < 15 * 60e3) return cache.rows;
  const [master, overview] = await Promise.all([csv(process.env.DELIVERY_MASTER_GID || "707708892"), csv(process.env.DELIVERY_OVERVIEW_GID || "0")]);
  const h = master.findIndex(r => r.some(c => /^po$/i.test(String(c).trim())) && r.some(c => /^colou?r$/i.test(String(c).trim())));
  if (h < 0) return [];
  const H = master[h], col = re => H.findIndex(c => re.test(String(c).trim()));
  const cS = col(/style name/i), cC = col(/^colou?r$/i), cQ = col(/^qty|quantity/i), cA = col(/arrival/i);
  // Delivery status by arrival date (Overview), so "Planned" shipments get softer wording.
  const oh = overview.findIndex(r => r.some(c => /^delivery$/i.test(String(c).trim())) && r.some(c => /^status$/i.test(String(c).trim())));
  const st = []; if (oh >= 0) { const O = overview[oh], sI = O.findIndex(c => /^status$/i.test(String(c).trim())), aI = O.findIndex(c => /arrival/i.test(String(c)));
    overview.slice(oh + 1).forEach(r => { const d = date(r[aI]); if (d) st.push({ d, status: String(r[sI] || "").trim() }); }); }
  const rows = master.slice(h + 1).map(r => { const at = date(r[cA]); const near = at && st.sort((a, b) => Math.abs(a.d - at) - Math.abs(b.d - at))[0];
    return { style: styleKey(r[cS]), color: String(r[cC] || "").trim().toLowerCase(), qty: +String(r[cQ] || "0").replace(/[^\d]/g, "") || 0, at,
      status: near && Math.abs(near.d - at) < 4 * 864e5 ? near.status : "" }; }).filter(x => x.style && x.color && x.qty > 0 && x.at);
  cache = { at: Date.now(), rows }; return rows;
}

// Next arrival for a product + color that's on its way (today or later).
export async function nextArrival(productTitle, color) {
  const k = styleKey(productTitle), c = String(color || "").trim().toLowerCase(), now = Date.now() - 864e5;
  const hit = (await incoming()).filter(x => x.style === k && x.color === c && x.at >= now && !/^arrived$/i.test(x.status)).sort((a, b) => a.at - b.at)[0];
  if (!hit) return null;
  return { date: new Date(hit.at).toISOString().slice(0, 10), days: Math.round((hit.at - Date.now()) / 864e5), planned: /planned/i.test(hit.status), qty: hit.qty };
}
