// Runs every minute (vercel.json). Sends Ella's due, safe return/exchange replies while autopilot is on.
import { db, init, getDoc, putDoc } from "../lib/server.js";
import { AUTOPILOT } from "../lib/autopilot.js";
import { loadTicket, isOp, isNoise, draftFor } from "../lib/ella.js";
import { pollAfterQc, notifyRefunds, scanQcThreads } from "../lib/afterqc.js";
import { buildLessons } from "../lib/learn.js";

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

// Held drafts go to a person (David, Oct 28: "assign the ticket to Michelle"): assign the Richpanel conversation,
// reopen it, and leave a private note with why it's held, what Ella suggests, and her draft to send or edit.
const HANDOFF_TO = () => process.env.SERVICE_HANDOFF_TO || "d50e81de-edcc-49f3-bbb9-bbe4b6dc3fe6"; // Michelle Aguinalde
const WHY = { needs_human: "needs a person (our mistake, a refund they insist on, or an upset customer)", out_of_stock: "what they want is sold out",
  past_window: "past the 40-day return window", asked_if_bot: "they asked if they're talking to a real person", vip: "VIP customer (5+ orders or $500+), a person should reply" };
async function handOff(since) {
  const rows = await db()`select id, data from hub.docs where coll = 'svc_returns' and not deleted and id like 'n%' and data->>'status' = 'draft'
    and data->>'handedAt' is null and data->>'sarahAt' is null and coalesce((data->>'lastAt')::bigint, (data->>'receivedAt')::bigint, 0) >= ${since} order by seq limit 5`;
  for (const { id, data: r } of rows) {
    const why = (r.flags || []).filter(f => WHY[f]).map(f => WHY[f]);
    if (r.vip && !why.includes(WHY.vip)) why.push(WHY.vip);
    if (!why.length || !r.ticketId) continue; // not held: autopilot answers it
    const body = `FOR MICHELLE · Ella held this one\nWhy: ${why.join("; ")}.\nElla suggests: ${r.plan || "-"}\n\nHer draft (edit and send, or reply your own way):\n${r.draft || "-"}`;
    const x = await fetch(`https://api.richpanel.com/v1/tickets/${encodeURIComponent(r.ticketId)}`, { method: "PUT",
      headers: { "content-type": "application/json", "x-richpanel-key": process.env.RICHPANEL_API_KEY || "" },
      body: JSON.stringify({ ticket: { status: "OPEN", assignee_id: HANDOFF_TO(), comment: { body, sender_type: "operator", public: false, author_id: process.env.RICHPANEL_AUTHOR_ID || "operator" } } }) });
    await putDoc("svc_returns", id, { handedAt: Date.now(), handedTo: "Michelle", handedOk: x.ok }, true);
  }
}

// Runs every minute with a 60s limit. Sending Ella's due replies comes FIRST (Oct 28: the extra jobs ran first and the
// function timed out before anything was sent); everything else only runs while there's time left.
export default async function handler(req, res) {
  const t0 = Date.now(), left = () => 50000 - (Date.now() - t0);
  await init();
  const off = await getDoc("svc_meta", "autopilot");
  const live = AUTOPILOT.on && Date.now() < Date.parse(AUTOPILOT.until) && !off?.off;
  const since = Date.parse(AUTOPILOT.since || 0) || 0;
  const sent = [], held = [];
  if (live) {
  const rows = await db()`select id, data from hub.docs where coll = 'svc_returns' and not deleted and data->>'status' = 'draft'
    and coalesce((data->>'lastAt')::bigint, (data->>'receivedAt')::bigint, 0) >= ${Date.parse(AUTOPILOT.since || 0) || 0} and data->>'handedAt' is null and data->>'sarahAt' is null order by seq desc limit 40`;
  const sent = [], held = [];
  for (const { id, data: r } of rows) {
    if (left() < 8000) break;
    // "no_order" is safe: that reply just asks for the order number.
    const blocking = (r.flags || []).filter(f => f !== "no_order");
    const safe = SAFE_INTENTS.includes(r.intent) || (r.intent === "after_qc" && off?.afterQcAuto && r.v3); // v3 = written with their history
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
  }
  // Then the rest, each only if there's time.
  const step = async (ms, fn) => { if (left() > ms) await fn().catch(() => {}); };
  await step(15000, () => handOff(since));
  await step(15000, () => postNotes());
  await step(15000, () => notifyRefunds(off || {}));
  await step(20000, () => scanQcThreads());
  await step(25000, async () => { const qc = await pollAfterQc(); if (qc.made) await putDoc("svc_meta", "afterqc", { ...qc, at: Date.now() }, true); });
  if (live) await step(25000, async () => {
  // Repair (Oct 27): Sarah's private hand-off notes were mistaken for replies, so some drafts were marked "Sarah answered".
  // Re-check those against the real thread: if the customer is still the last to speak, put them back in line.
  const fix = await db()`select id, data from hub.docs where coll = 'svc_returns' and not deleted and data->>'status' = 'draft' and data->>'sarahAt' is not null
    and data->>'repairedAt' is null and coalesce((data->>'lastAt')::bigint, 0) >= ${since} limit 5`;
  for (const { id, data: r } of fix) {
    const t = r.number ? await loadTicket(r.number) : null, real = (t?.comments || []).filter(c => !isNoise(c)), last = real[real.length - 1];
    await putDoc("svc_returns", id, last && !isOp(last) && String(t?.status).toUpperCase() !== "CLOSED" ? { sarahAt: null, answeredBy: null, repairedAt: Date.now() } : { repairedAt: Date.now() }, true);
  }
  // Redo (Oct 27 rules): replies held since go-live for "needs a person" / "sold out" get one fresh draft under the new
  // never-stall rules (real stock for pre-order items, believe "I received it", order found by email).
  const stuck = await db()`select id, data from hub.docs where coll = 'svc_returns' and not deleted and id like 'n%' and data->>'status' = 'draft'
    and data->>'redraft2At' is null and data->>'sarahAt' is null and (data->'flags' ? 'needs_human' or data->'flags' ? 'out_of_stock')
    and coalesce((data->>'lastAt')::bigint, 0) >= ${since} limit 1`;
  // Drafts that errored (busy API) get retried once.
  const errs = await db()`select id, data from hub.docs where coll = 'svc_returns' and not deleted and id like 'n%' and data->>'status' = 'error'
    and data->>'retryAt' is null and coalesce((data->>'lastAt')::bigint, 0) >= ${since} limit 1`;
  for (const { id, data: r } of errs) {
    await putDoc("svc_returns", id, { retryAt: Date.now() }, true);
    const t = r.number ? await loadTicket(r.number) : null; if (!t) continue;
    const comments = (t.comments || []).filter(c => !isNoise(c)), cust = comments.filter(c => !isOp(c)).pop();
    await draftFor(id, { who: r.customer, mail: r.email, subject: r.subject, message: String(cust?.plain_body || cust?.body || r.message || ""), comments });
  }
  for (const { id, data: r } of stuck) {
    await putDoc("svc_returns", id, { redraft2At: Date.now() }, true);
    const t = r.number ? await loadTicket(r.number) : null; if (!t) continue;
    const comments = (t.comments || []).filter(c => !isNoise(c)), last = comments[comments.length - 1];
    if (!last || isOp(last) || String(t.status).toUpperCase() === "CLOSED") continue; // someone answered meanwhile
    const cust = comments.filter(c => !isOp(c)).pop();
    await draftFor(id, { who: r.customer, mail: r.email, subject: r.subject, message: String(cust?.plain_body || cust?.body || r.message || ""), comments });
    await putDoc("svc_returns", id, { lastAt: Date.now() - 6e5 }, true); // already waited long enough: send on the next pass if clean
  }
  });
  if (new Date().getUTCMinutes() === 7) await step(30000, () => buildLessons()); // checks hourly, rebuilds once a day
  res.json({ ok: true, live, sent, held: held.length });
}
