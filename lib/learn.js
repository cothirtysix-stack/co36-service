// Learning loop (David, Oct 27: "learn from each answer, what gets customers happy vs upset").
// Every customer reply is scored against the message we sent right before it (Ella, Sarah or a teammate), and once a day
// Claude turns the latest ~200 of those into a few plain lessons that Ella reads before every draft.
// Lessons never override David's rules (refunds need his OK, never mention AI, etc.).
import crypto from "node:crypto";
import { db, init, getDoc, putDoc } from "./server.js";

const SARAH_ID = "7ba38484-f064-43d8-83f6-f9e6060b1fd0";
const text = c => String(c?.plain_body || c?.body || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

export async function recordReply({ id, comments, lastCust, mood, isOp, isNoise }) {
  if (!lastCust || !mood) return;
  const i = comments.indexOf(lastCust);
  const prev = comments.slice(0, i < 0 ? comments.length : i).filter(c => isOp(c) && !isNoise(c) && c.is_private !== true && c.isPrivate !== true).pop();
  if (!prev) return; // first message in the thread: nothing of ours to judge yet
  const who = prev.author_id === SARAH_ID ? "sarah" : prev.author_id && prev.author_id === process.env.RICHPANEL_AUTHOR_ID ? "ella" : "team";
  const key = id + "-" + crypto.createHash("sha1").update(String(lastCust.id || text(lastCust))).digest("hex").slice(0, 10);
  await putDoc("svc_learn", key, { at: Date.now(), conv: id, who, ours: text(prev).slice(0, 900), customer: text(lastCust).slice(0, 900),
    mood: mood.mood, intent: mood.intent, type: mood.type, summary: mood.summary || "" });
}

export async function buildLessons(force = false) {
  const cur = await getDoc("svc_meta", "lessons");
  if (!force && cur?.at && Date.now() - cur.at < 24 * 3600e3) return null;
  await init();
  const rows = (await db()`select data from hub.docs where coll = 'svc_learn' and not deleted order by seq desc limit 200`).map(r => r.data);
  if (rows.length < 10) return null;
  const score = w => { const r = rows.filter(x => x.who === w); return { n: r.length, happy: r.filter(x => x.mood === "happy").length, upset: r.filter(x => x.mood === "upset").length }; };
  const sample = rows.slice(0, 120).map(x => `[${x.who} → ${x.mood}] WE SAID: ${x.ours.slice(0, 350)}\nTHEY REPLIED: ${x.customer.slice(0, 300)}`).join("\n\n");
  const prompt = `You're coaching Ella, CO36's customer service writer (men's clothing). Below are real pairs: what we wrote (Ella, Sarah = the old bot, or a teammate) and how the customer replied, with their mood.
Find what makes customers happy vs upset. Answer JSON only:
{"happy":["what we do that customers love, max 5, each under 18 words"],"upset":["what we do that upsets them, max 5, each under 18 words"],"tips":["concrete rules for Ella's next emails, max 6, each under 20 words"]}
Only lessons the examples actually show. Never suggest refunds without approval, mentioning AI, or long apologies.

${sample}`;
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY || "", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || "claude-opus-5-5", max_tokens: 1200, messages: [{ role: "user", content: prompt }] }) });
  const j = await r.json().catch(() => ({})); const t = (j.content || []).map(b => b.text || "").join("");
  let o; try { o = JSON.parse(t.match(/\{[\s\S]*\}/)?.[0] || ""); } catch { return null; }
  const out = { at: Date.now(), from: rows.length, scores: { ella: score("ella"), sarah: score("sarah"), team: score("team") },
    happy: (o.happy || []).slice(0, 5), upset: (o.upset || []).slice(0, 5), tips: (o.tips || []).slice(0, 6) };
  await putDoc("svc_meta", "lessons", out);
  return out;
}

let cache = null;
export async function lessonsForPrompt() {
  if (!cache || Date.now() - cache.t > 10 * 60e3) cache = { t: Date.now(), d: await getDoc("svc_meta", "lessons").catch(() => null) };
  const tips = cache.d?.tips || [];
  return tips.length ? `\nLESSONS FROM REAL CUSTOMER REPLIES (follow these unless they conflict with the rules above):\n${tips.map(x => "- " + x).join("\n")}\n` : "";
}
