// Color requests (David, Nov 26: "is there a color you'd want us to drop?" — count the answers): once a day, every customer email from
// the last 30 days that asks for a color we don't have (new, or bring back) is tallied by color. Read-only; shown on the Shopping page.
import { db, init, putDoc } from "./server.js";

export async function colorVotes() {
  await init();
  const since = Date.now() - 30 * 864e5;
  const q = await db()`select left(regexp_replace(data->>'message', '\\s+', ' ', 'g'), 300) m from hub.docs where coll = 'svc_questions' and not deleted and coalesce((data->>'lastAt')::bigint,0) > ${since} order by seq desc limit 300`;
  const t = await db()`select left(regexp_replace(data->>'message', '\\s+', ' ', 'g'), 300) m from hub.docs where coll = 'svc_topics' and not deleted and data->>'topic' in ('suggestion','product','stock','feedback','praise')
    and coalesce((data->>'lastAt')::bigint,0) > ${since} order by seq desc limit 300`;
  const list = [...q, ...t].map((r, i) => `${i + 1}. ${r.m}`).join("\n");
  const r = await fetch("https://api.anthropic.com/v1/messages", { signal: AbortSignal.timeout(45000), method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY || "", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || "claude-opus-5-5", max_tokens: 6000, messages: [{ role: "user", content:
`Customer emails to CO36 (men's clothing) from the last 30 days, one per line. Find every time a customer asks us to MAKE a color, ADD a color, or BRING BACK a color (not just asking if one is in stock). Count requests per color (one per customer line; merge obvious names like grey/gray, navy blue/navy). Also say which product if clear.
Answer one line per color, most requested first, exactly: COUNT | COLOR | PRODUCTS (or "any") | NEW or BRING BACK
If none, answer NONE.

${list}` }] }) });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error?.message || `Claude ${r.status}`);
  const text = (j.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  const votes = text.split("\n").map(l => l.replace(/^\s*\|?\s*/, "").replace(/\*\*/g, "")).filter(l => /^\d+\s*\|/.test(l)).map(l => { const p = l.split("|").map(x => x.trim()); return { n: +p[0], color: p[1], products: p[2] || "", kind: p[3] || "" }; }).filter(v => v.n > 0 && v.color).slice(0, 12);
  await putDoc("svc_meta", "colorVotes", { at: Date.now(), votes, scanned: list.split("\n").length });
  return votes;
}
