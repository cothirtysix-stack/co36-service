// Richpanel HTTP Target → Service Hub. Richpanel posts each new customer message here (Settings → Integrations → HTTP Target,
// plus an automation rule "New message received → Notify HTTP Targets"). Claude reads the mood; upset and happy customers are kept.
import crypto from "node:crypto";
import { putDoc, getDoc } from "../lib/server.js";

const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const pick = (b, ...k) => { for (const x of k) if (b[x] != null && b[x] !== "") return b[x]; return null; };
const TYPES = ["damaged", "wrong", "late", "service", "sarah", "other"];

async function read(text, subject) {
  const key = process.env.ANTHROPIC_API_KEY; if (!key) return null;
  const prompt = `A customer emailed CO36, a men's clothing brand. Read their message and answer with JSON only:
{"mood":"upset"|"happy"|"neutral","type":"damaged"|"wrong"|"late"|"service"|"sarah"|"other","summary":"what happened, under 12 words","quote":"their most telling sentence, under 140 characters","order":"order number like #12345 or null"}
upset = angry, frustrated, repeating themselves, threatening a dispute or bad review, or let down. happy = praise or thanks. Questions without emotion are neutral.
type: damaged item; wrong (wrong or missing item, wrong size sent); late (not shipped, delayed, lost, delivered but not received); service (no reply, slow, rude, refund not processed); sarah (complains about an automated or AI reply); other.
Subject: ${String(subject || "").slice(0, 200)}
Message: ${String(text || "").slice(0, 4000)}`;
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: process.env.ANTHROPIC_FAST_MODEL || "claude-haiku-5-5", max_tokens: 300, messages: [{ role: "user", content: prompt }] }) });
  const j = await r.json().catch(() => ({})); const t = (j.content || []).map(b => b.text || "").join("");
  try { const o = JSON.parse(t.match(/\{[\s\S]*\}/)?.[0] || ""); return { ...o, type: TYPES.includes(o.type) ? o.type : "other" }; } catch { return null; }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const want = process.env.SERVICE_INBOUND_KEY; if (!want) return res.status(500).json({ error: "SERVICE_INBOUND_KEY is not set in Vercel" });
  const got = req.headers["x-co36-key"] || String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!got || !same(got, want)) return res.status(401).json({ error: "bad key" });
  try {
    const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const id = String(pick(b, "ticket_id", "conversation_id", "ticketId", "id") || "").replace(/[^A-Za-z0-9_\-]/g, "").slice(0, 120);
    if (!id) return res.status(400).json({ error: "no ticket_id" });
    const cur = await getDoc("svc_inbox", id);
    const status = String(pick(b, "status") || "").toUpperCase();
    if (status === "CLOSED" && cur) { await putDoc("svc_inbox", id, { closedAt: Date.now() }, true); return res.json({ ok: true }); }
    const message = String(pick(b, "message", "last_message", "message_body", "body") || "").trim();
    const subject = pick(b, "subject");
    const mood = await read(message, subject);
    if (!cur && (!mood || mood.mood === "neutral")) return res.json({ ok: true, kept: false });
    const now = Date.now();
    await putDoc("svc_inbox", id, {
      ticketId: id, number: pick(b, "conversation_no", "ticket_number", "conversation_number"),
      customer: pick(b, "customer_name", "name") || cur?.customer || null, email: pick(b, "customer_email", "email") || cur?.email || null,
      subject: subject || cur?.subject || null, tags: Array.isArray(b.tags) ? b.tags : cur?.tags || [],
      mood: mood?.mood && mood.mood !== "neutral" ? mood.mood : cur?.mood || "upset", type: mood?.type || cur?.type || "other",
      summary: mood?.summary || cur?.summary || null, quote: mood?.quote || message.slice(0, 140), order: mood?.order || cur?.order || null,
      firstAt: cur?.firstAt || Date.parse(pick(b, "created_at") || "") || now, lastAt: now,
      // The 1-hour clock restarts when they write again after we answered.
      waitingSince: cur?.waitingSince && !(cur.repliedAt > cur.waitingSince) && !cur.closedAt ? cur.waitingSince : now, messages: (cur?.messages || 0) + 1, closedAt: null
    }, true);
    res.json({ ok: true, kept: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "inbound failed" }); }
}
