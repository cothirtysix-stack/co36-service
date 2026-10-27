// Runs every minute (vercel.json). Sends Ella's due, safe return/exchange replies while autopilot is on.
import { db, init, getDoc, putDoc } from "../lib/server.js";
import { AUTOPILOT } from "../lib/autopilot.js";
import { loadTicket, isOp, isNoise } from "../lib/ella.js";

const SAFE_INTENTS = ["return", "exchange"];
const delayMs = id => { // stable 10–20 min per conversation, so it doesn't look automatic
  let h = 0; for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (AUTOPILOT.minDelayMin + (h % (AUTOPILOT.maxDelayMin - AUTOPILOT.minDelayMin + 1))) * 6e4;
};

// Shadow mode: copy each new draft into the Richpanel conversation as a PRIVATE note (customers never see notes),
// so the team and Claude can compare Ella with Sarah.
async function postNotes() {
  await init();
  const rows = await db()`select id, data from hub.docs where coll = 'svc_returns' and not deleted and data->>'status' = 'draft' and (data->>'notedAt') is null order by seq desc limit 10`;
  for (const { id, data: r } of rows) {
    const body = `ELLA'S DRAFT · NOT SENT (private note, customer can't see this)\nPlan: ${r.plan || "-"}${(r.flags || []).length ? `\nFlags: ${r.flags.join(", ")}` : ""}\n\n${r.draft}`;
    const x = await fetch(`https://api.richpanel.com/v1/tickets/${encodeURIComponent(r.ticketId)}`, { method: "PUT",
      headers: { "content-type": "application/json", "x-richpanel-key": process.env.RICHPANEL_API_KEY || "" },
      body: JSON.stringify({ ticket: { comment: { body, sender_type: "operator", public: false, author_id: process.env.RICHPANEL_AUTHOR_ID || "operator" } } }) });
    await putDoc("svc_returns", id, x.ok ? { notedAt: Date.now() } : { noteError: `Richpanel ${x.status}`, notedAt: Date.now() }, true);
  }
}

export default async function handler(req, res) {
  await postNotes().catch(() => {});
  const off = await getDoc("svc_meta", "autopilot");
  const live = AUTOPILOT.on && Date.now() < Date.parse(AUTOPILOT.until) && !off?.off;
  if (!live) return res.json({ ok: true, live: false });
  await init();
  const rows = await db()`select id, data from hub.docs where coll = 'svc_returns' and not deleted and data->>'status' = 'draft' order by seq limit 50`;
  const sent = [], held = [];
  for (const { id, data: r } of rows) {
    if (!SAFE_INTENTS.includes(r.intent) || (r.flags || []).length || r.sarahAt || r.vip || !r.draft) { held.push(id); continue; }
    if (Date.now() < (r.receivedAt || 0) + delayMs(id)) continue;
    // Last check right before sending: still open, and the newest message is still the customer's.
    const t = r.number ? await loadTicket(r.number) : null, real = (t?.comments || []).filter(c => !isNoise(c)), last = real[real.length - 1];
    if (!t || String(t.status).toUpperCase() === "CLOSED" || (last && isOp(last))) {
      await putDoc("svc_returns", id, { sarahAt: Date.now(), autoSkipped: "someone already replied or it was closed" }, true); continue;
    }
    const r2 = await fetch(`https://api.richpanel.com/v1/tickets/${encodeURIComponent(r.ticketId)}`, { method: "PUT",
      headers: { "content-type": "application/json", "x-richpanel-key": process.env.RICHPANEL_API_KEY || "" },
      body: JSON.stringify({ ticket: { comment: { body: r.draft, sender_type: "operator", public: true, author_id: process.env.RICHPANEL_AUTHOR_ID || "operator" } } }) });
    if (!r2.ok) { await putDoc("svc_returns", id, { autoError: `Richpanel ${r2.status}` }, true); continue; }
    await putDoc("svc_returns", id, { status: "sent", sentAt: Date.now(), sentBy: "Ella (autopilot)", sentText: r.draft, edited: false }, true);
    await putDoc("svc_cases", `auto-${id}-${Date.now().toString(36)}`, { at: Date.now(), by: "Ella (autopilot)", source: "returns", ref: id, customer: r.customer || r.email, email: r.email,
      order: (r.orders || [])[0], product: (r.items || [])[0], type: r.intent, what: r.intent === "exchange" ? "Exchange request" : "Return request", did: `Ella: ${r.plan || "replied"}`, message: r.draft });
    sent.push(id);
  }
  res.json({ ok: true, live: true, sent, held: held.length });
}
