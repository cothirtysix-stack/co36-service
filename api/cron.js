// Runs every minute (vercel.json). Sends Ella's due, safe return/exchange replies while autopilot is on.
import { db, init, getDoc, putDoc } from "../lib/server.js";
import { AUTOPILOT } from "../lib/autopilot.js";
import { loadTicket, isOp, isNoise } from "../lib/ella.js";
import { pollAfterQc, notifyRefunds, scanQcThreads } from "../lib/afterqc.js";

const SAFE_INTENTS = ["return", "exchange"];
const delayMs = (id, s = {}) => { // stable wait per conversation (Settings page, default 8–12 min), so it doesn't look automatic
  const lo = +s.minDelay || AUTOPILOT.minDelayMin, hi = Math.max(lo, +s.maxDelay || AUTOPILOT.maxDelayMin);
  let h = 0; for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (lo + (h % (hi - lo + 1))) * 6e4;
};

// Shadow mode: copy each new draft into the Richpanel conversation as a PRIVATE note (customers never see notes),
// so the team and Claude can compare Ella with Sarah.
async function postNotes() {
  await init();
  const rows = await db()`select id, data from hub.docs where coll = 'svc_returns' and not deleted and data->>'status' = 'draft' and (data->>'notedAt') is null and data->>'ticketId' is not null order by seq desc limit 10`;
  for (const { id, data: r } of rows) {
    const body = `ELLA'S DRAFT · NOT SENT (private note, customer can't see this)\nPlan: ${r.plan || "-"}${(r.flags || []).length ? `\nFlags: ${r.flags.join(", ")}` : ""}\n\n${r.draft}`;
    const x = await fetch(`https://api.richpanel.com/v1/tickets/${encodeURIComponent(r.ticketId)}`, { method: "PUT",
      headers: { "content-type": "application/json", "x-richpanel-key": process.env.RICHPANEL_API_KEY || "" },
      body: JSON.stringify({ ticket: { comment: { body, sender_type: "operator", public: false, author_id: process.env.RICHPANEL_AUTHOR_ID || "operator" } } }) });
    await putDoc("svc_returns", id, x.ok ? { notedAt: Date.now() } : { noteError: `Richpanel ${x.status}`, notedAt: Date.now() }, true);
  }
}

export default async function handler(req, res) {
  // After-return follow-ups: draft only (intent "after_qc" is never auto-sent below).
  await scanQcThreads().catch(() => {});
  const qc = await pollAfterQc().catch(e => ({ error: String(e.message || e).slice(0, 200) }));
  if (qc.error || qc.made) await putDoc("svc_meta", "afterqc", { ...qc, at: Date.now() }, true).catch(() => {});
  await postNotes().catch(() => {});
  const off = await getDoc("svc_meta", "autopilot");
  await notifyRefunds(off || {}).catch(e => putDoc("svc_meta", "afterqc", { notifyError: String(e.message || e).slice(0, 200), at: Date.now() }, true).catch(() => {}));
  const live = AUTOPILOT.on && Date.now() < Date.parse(AUTOPILOT.until) && !off?.off;
  if (!live) return res.json({ ok: true, live: false });
  await init();
  const rows = await db()`select id, data from hub.docs where coll = 'svc_returns' and not deleted and data->>'status' = 'draft'
    and coalesce((data->>'lastAt')::bigint, (data->>'receivedAt')::bigint, 0) >= ${Date.parse(AUTOPILOT.since || 0) || 0} order by seq limit 50`;
  const sent = [], held = [];
  for (const { id, data: r } of rows) {
    // "no_order" is safe: that reply just asks for the order number.
    const blocking = (r.flags || []).filter(f => f !== "no_order");
    const safe = SAFE_INTENTS.includes(r.intent) || (r.intent === "after_qc" && off?.afterQcAuto);
    if (!safe || blocking.length || r.sarahAt || r.vip || !r.draft) { held.push(id); continue; }
    if (Date.now() < (r.lastAt || r.receivedAt || 0) + delayMs(id, off || {})) continue;
    // Last check right before sending: still open, and the newest message is still the customer's.
    const t = r.number ? await loadTicket(r.number) : null, real = (t?.comments || []).filter(c => !isNoise(c)), last = real[real.length - 1];
    // After-QC follow-ups are ours to start, so "our message is last" is expected there; only a newer customer message stops them.
    const stale = r.intent === "after_qc" ? !t : !t || String(t.status).toUpperCase() === "CLOSED" || (last && isOp(last));
    if (stale) {
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
