// Richpanel HTTP Target → Service Hub. Richpanel posts each new customer message here (Settings → Integrations → HTTP Target,
// plus an automation rule "New message received → Notify HTTP Targets"). Claude reads the mood; upset and happy customers are kept.
import crypto from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { putDoc, getDoc } from "../lib/server.js";
import { draftFor, isNoise, RETURN_WORDS, RETURNS_TEMPLATE } from "../lib/ella.js";
import { recordReply } from "../lib/learn.js";

const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const pick = (b, ...k) => { for (const x of k) if (b[x] != null && b[x] !== "") return b[x]; return null; };
const TYPES = ["damaged", "wrong", "late", "service", "sarah", "other"];

// The reader sometimes fails (busy API, odd JSON). Try up to 3 times before falling back to keywords.
async function read(text, subject) {
  for (let i = 0; i < 3; i++) { const o = await readOnce(text, subject).catch(() => null); if (o) return o; await new Promise(r => setTimeout(r, 800 * (i + 1))); }
  return null;
}
async function readOnce(text, subject) {
  const key = process.env.ANTHROPIC_API_KEY; if (!key) return null;
  const prompt = `A customer emailed CO36, a men's clothing brand. Read their message and answer with JSON only:
{"mood":"upset"|"happy"|"neutral","intent":"return"|"exchange"|"none","type":"damaged"|"wrong"|"late"|"service"|"sarah"|"other","summary":"what happened, under 12 words","quote":"their most telling sentence, under 140 characters","order":"order number like #12345 or null"}
intent: return = wants to send something back, asks for a return label or a refund for an item they received; exchange = wants a different size, color or style; none = anything else (where is my order, cancel before shipping, questions).
upset = angry, frustrated, repeating themselves, threatening a dispute or bad review, or let down. happy = praise or thanks. Questions without emotion are neutral.
type: damaged item; wrong (wrong or missing item, wrong size sent); late (not shipped, delayed, lost, delivered but not received); service (no reply, slow, rude, refund not processed); sarah (complains about an automated or AI reply); other.
Subject: ${String(subject || "").slice(0, 200)}
Message: ${String(text || "").slice(0, 4000)}`;
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: process.env.ANTHROPIC_FAST_MODEL || "claude-haiku-5-5", max_tokens: 300, messages: [{ role: "user", content: prompt }] }) });
  const j = await r.json().catch(() => ({})); const t = (j.content || []).map(b => b.text || "").join("");
  try { const o = JSON.parse(t.match(/\{[\s\S]*\}/)?.[0] || ""); return { ...o, type: TYPES.includes(o.type) ? o.type : "other" }; } catch { return null; }
}

// Sarah or an agent answered in Richpanel.
// Someone replied in Richpanel. Work out who: Ella (her draft was sent from anywhere), Sarah (Richpanel's AI account), or a teammate.
const SARAH_ID = "7ba38484-f064-43d8-83f6-f9e6060b1fd0";
const words = t => String(t || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
async function ourReply(id, cur, last) {
  if (cur) await putDoc("svc_inbox", id, { repliedAt: Date.now() }, true);
  const ret = await getDoc("svc_returns", id);
  if (!ret || ret.status === "sent" || (ret.sentAt && Date.now() - ret.sentAt < 120e3)) return;
  const body = words(last?.plain_body || last?.body), draft = words(ret.draft);
  if (draft && body && (body === draft || body.startsWith(draft.slice(0, 120)))) {
    await putDoc("svc_returns", id, { status: "sent", sentAt: Date.now(), sentBy: "Ella (sent in Richpanel)", sentText: last.plain_body || last.body, edited: false }, true); return;
  }
  const who = last?.author_id === SARAH_ID ? "sarah" : "team";
  await putDoc("svc_returns", id, { sarahAt: Date.now(), answeredBy: who }, true);
}

async function note(outcome, extra) { // running tally of what Richpanel sent, for the status page
  try { const cur = (await getDoc("svc_meta", "inbound")) || {}; const counts = { ...(cur.counts || {}) }; counts[outcome] = (counts[outcome] || 0) + 1;
    await putDoc("svc_meta", "inbound", { counts, lastAt: Date.now(), lastOutcome: outcome, ...(extra ? { lastNote: String(extra).slice(0, 200) } : {}) }); } catch (_) {}
}

// Vercel freezes the function once the reply is sent, so anything saved after that can leave the database connection stuck.
// Collect the reply, save the tally, then send.
export default async function handler(req, res) {
  let out = null, code = 200;
  const fake = { status(c) { code = c; return fake; }, json(o) { out = o; return fake; } };
  await inner(req, fake);
  await note(code >= 400 ? `error ${code}` : out?.kept ? "kept" : out?.kept === false ? "skipped" : "ok", out?.error);
  res.status(code).json(out ?? {});
}

async function inner(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const want = process.env.SERVICE_INBOUND_KEY; if (!want) return res.status(500).json({ error: "SERVICE_INBOUND_KEY is not set in Vercel" });
  const got = req.headers["x-co36-key"] || String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!got || !same(got, want)) return res.status(401).json({ error: "bad key" });
  try {
    const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const number = String(pick(b, "ticketConversationNumber", "conversation_no", "conversation_number", "ticket_number") || "").replace(/\D/g, "");
    let ticketId = pick(b, "ticket_id", "conversation_id", "ticketId");
    // Richpanel's template has the conversation number but no ticket id, so look the conversation up by number.
    const looked = !ticketId && number && process.env.RICHPANEL_API_KEY
      ? await fetch(`https://api.richpanel.com/v1/tickets/number/${number}`, { headers: { "x-richpanel-key": process.env.RICHPANEL_API_KEY } }).then(r => r.ok ? r.json() : null).catch(() => null) : null;
    ticketId ||= looked?.ticket?.id;
    const id = number ? "n" + number : String(ticketId || "").replace(/[^A-Za-z0-9_\-]/g, "").slice(0, 120);
    if (!id || !ticketId) return res.status(400).json({ error: "no conversation number or ticket id" });
    const cur = await getDoc("svc_inbox", id);
    const status = String(pick(b, "ticketConversationStatus", "status") || looked?.ticket?.status || "").toUpperCase();
    if (status === "CLOSED" && cur) { await putDoc("svc_inbox", id, { closedAt: Date.now() }, true); return res.json({ ok: true }); }
    // Richpanel Returns' "Quality Check Completed for your return - Order #123" email: remember its thread for Ella's follow-up.
    const qcm = String(pick(b, "ticketSubject", "subject") || looked?.ticket?.subject || "").match(/quality check completed.*?#\s*(\d+)/i);
    if (qcm) { await putDoc("svc_qcthread", qcm[1], { ticketId, number, at: Date.now() }); return res.json({ ok: true, kept: false, qc: true }); }
    // Our own replies (Sarah or an agent) restart nothing; they count as answering.
    if (/^(agent|operator|bot|ai)$/i.test(String(pick(b, "ticketMessageFrom", "message_from") || ""))) {
      const real = (looked?.ticket?.comments || []).filter(c => !isNoise(c)), lastReal = real[real.length - 1];
      if (lastReal && (lastReal.is_operator ?? lastReal.isOperator)) await ourReply(id, cur, lastReal); // a private note or auto-reply isn't an answer
      return res.json({ ok: true, kept: false });
    }
    const comments = (looked?.ticket?.comments || []).filter(c => !isNoise(c)), isOp = c => !!(c.is_operator ?? c.isOperator);
    // Richpanel's "Things are busy" auto-reply lands seconds after every customer email, so "last message is ours" is not enough.
    // Work from the newest customer message and only handle each one once.
    const lastCust = comments.filter(c => !isOp(c)).pop();
    const seen = await getDoc("svc_seen", id);
    if (!pick(b, "ticketMessage", "message")) {
      if (!lastCust || seen?.last === lastCust.id) {
        if (comments.length && isOp(comments[comments.length - 1])) await ourReply(id, cur, comments[comments.length - 1]);
        return res.json({ ok: true, kept: false });
      }
      await putDoc("svc_seen", id, { last: lastCust.id, at: Date.now() });
    }
    const lastCustomer = lastCust;
    const cp = looked?.ticket?.customer_profile || {};
    const rpName = cp.name || [cp.firstName || cp.first_name, cp.lastName || cp.last_name].filter(Boolean).join(" ") || null;
    const rpEmail = cp.email || looked?.ticket?.via?.source?.from?.address || null;
    const message = String(pick(b, "ticketMessage", "message", "last_message", "message_body", "body") || lastCustomer?.plain_body || lastCustomer?.body || "")
      .replace(/<a\b[^>]*>(.*?)<\/a>/gi, "$1").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/[ \t]+/g, " ").trim();
    const subject = pick(b, "ticketSubject", "subject") || looked?.ticket?.subject;
    let mood = await read(message, subject).catch(() => null);
    // Safety net: if the reader failed or missed an obvious return/exchange ("too big for a medium, may I exchange for a small?"), use the words.
    if (!RETURNS_TEMPLATE.test(String(subject || "")) && RETURN_WORDS.test(`${subject || ""} ${message}`) && (!mood || mood.intent === "none")) mood = { ...(mood || { mood: "neutral", type: "other" }), intent: /exchange|swap|another size|size (up|down)/i.test(message) ? "exchange" : "return" };
    await putDoc("svc_seen", id, { read: mood ? `${mood.intent}/${mood.mood}` : "failed", msgLen: message.length }, true).catch(() => {});
    // Learning: how did they react to what we (Ella, Sarah or the team) said last?
    await recordReply({ id, comments, lastCust, mood, isOp, isNoise }).catch(() => {});
    // Returns and exchanges: Ella starts drafting right away (after we answer Richpanel), so a reply is ready before Sarah's.
    const ret = await getDoc("svc_returns", id);
    if ((mood && ["return", "exchange"].includes(mood.intent)) || ret) {
      const who = pick(b, "ticketCustomerName", "customer_name", "name") || rpName, mail = pick(b, "ticketCustomerEmail", "customer_email", "email") || rpEmail;
      await putDoc("svc_returns", id, { ticketId, number, customer: who, email: mail, subject, message: message.slice(0, 2000), intent: mood?.intent || ret?.intent || "return",
        status: "drafting", receivedAt: ret?.status === "sent" ? Date.now() : ret?.receivedAt || Date.now(), lastAt: Date.now(), sarahAt: null }, true);
      waitUntil(draftFor(id, { who, mail, subject, message, comments }));
    }
    if (!cur && (!mood || mood.mood === "neutral")) return res.json({ ok: true, kept: false, lane: ret || mood?.intent !== "none" ? "returns" : undefined });
    const now = Date.now();
    await putDoc("svc_inbox", id, {
      ticketId, number: number || cur?.number || null,
      customer: pick(b, "ticketCustomerName", "customer_name", "name") || rpName || cur?.customer || null, email: pick(b, "ticketCustomerEmail", "customer_email", "email") || rpEmail || cur?.email || null,
      subject: subject || cur?.subject || null, tags: Array.isArray(b.tags) ? b.tags : Array.isArray(b.ticketConversationTags) ? b.ticketConversationTags : cur?.tags || [],
      mood: mood?.mood && mood.mood !== "neutral" ? mood.mood : cur?.mood || "upset", type: mood?.type || cur?.type || "other",
      summary: mood?.summary || cur?.summary || null, quote: mood?.quote || message.slice(0, 140), order: mood?.order || cur?.order || null,
      firstAt: cur?.firstAt || Date.parse(pick(b, "created_at") || "") || now, lastAt: now,
      // The 1-hour clock restarts when they write again after we answered.
      waitingSince: cur?.waitingSince && !(cur.repliedAt > cur.waitingSince) && !cur.closedAt ? cur.waitingSince : now, messages: (cur?.messages || 0) + 1, closedAt: null
    }, true);
    res.json({ ok: true, kept: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "inbound failed" }); }
}
