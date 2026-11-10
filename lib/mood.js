// Reads one customer message: mood, intent, type, summary (used by the webhook and the happy-list re-check).
// Each Claude call here gives up after 15s (Nov 10: slow replies made the webhook time out at 60s).
export let lastWhy = ""; // why the last read failed (for the re-check log)
const TYPES = ["damaged", "wrong", "late", "service", "sarah", "other"];
// The reader sometimes fails (busy API, odd JSON). Try up to 3 times before falling back to keywords.
export async function read(text, subject) {
  for (let i = 0; i < 2; i++) { const o = await readOnce(text, subject).catch(() => null); if (o) return o; await new Promise(r => setTimeout(r, 600)); }
  return null;
}
async function readOnce(text, subject) {
  const key = process.env.ANTHROPIC_API_KEY; if (!key) return null;
  const prompt = `A customer emailed CO36, a men's clothing brand. Read their message and answer with JSON only:
{"mood":"upset"|"happy"|"neutral","intent":"return"|"exchange"|"none","type":"damaged"|"wrong"|"late"|"service"|"sarah"|"other","summary":"what happened, under 12 words","quote":"their most telling sentence, under 140 characters","order":"order number like #12345 or null"}
intent: return = wants to send something back, asks for a return label or a refund for an item they received; exchange = wants a different size, color or style; none = anything else (where is my order, cancel before shipping, questions).
upset = angry, frustrated, repeating themselves, threatening a dispute or bad review, let down, or wanting to cancel because of a problem.
happy = ONLY real praise for CO36: they love the product, the fit, the quality or our service, and there is nothing they still need from us. A good candidate to ask for a review.
NOT happy (use neutral or upset): any request, question or problem, even said politely ("please remove…", "can you…", "where is…", "let me know when it's back in stock", "if you didn't send it, cancel"); a plain "thanks"/"sounds good"/"of course" that just closes a conversation; compliments about something that isn't ours. When in doubt, neutral.
type: damaged item; wrong (wrong or missing item, wrong size sent); late (not shipped, delayed, lost, delivered but not received); service (no reply, slow, rude, refund not processed); sarah (complains about an automated or AI reply); other.
Subject: ${String(subject || "").slice(0, 200)}
Message: ${String(text || "").slice(0, 4000)}`;
  const r = await fetch("https://api.anthropic.com/v1/messages", { signal: AbortSignal.timeout(15000), method: "POST", headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: process.env.ANTHROPIC_FAST_MODEL || "claude-haiku-5-5", max_tokens: 600, messages: [{ role: "user", content: prompt }] }) });
  const j = await r.json().catch(() => ({})); const t = (j.content || []).map(b => b.text || "").join("");
  if (!r.ok) { lastWhy = `Claude ${r.status}: ${String(j.error?.message || "").slice(0, 120)}`; return null; }
  try { const o = JSON.parse(t.match(/\{[\s\S]*\}/)?.[0] || ""); return { ...o, type: TYPES.includes(o.type) ? o.type : "other" }; }
  catch { lastWhy = `unreadable answer (${j.stop_reason || "?"}): ${t.slice(0, 120)}`; return null; }
}

