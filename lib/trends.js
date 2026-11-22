// Common problems (David, Nov 20): when 4+ customers write about the SAME specific issue in the last 3 days, flag it
// on top of the Inbox and in the hub pop-up. Ella groups the emails every ~30 minutes. Read-only: nothing is sent.
import { db, init, getDoc, putDoc } from "./server.js";

export async function findTrends(deadline = Date.now() + 45000) {
  await init();
  const rows = await db()`select id, data->>'topic' t, data->>'summary' s, left(data->>'message', 220) m from hub.docs where coll = 'svc_topics' and not deleted
    and coalesce(data->>'topic', '') not in ('spam', 'praise') and coalesce((data->>'lastAt')::bigint, 0) > ${Date.now() - 3 * 864e5}
    order by coalesce((data->>'lastAt')::bigint, 0) desc limit 400`;
  if (rows.length < 4) return { issues: [] };
  const list = rows.map(r => `${r.id} | ${r.t || "other"} | ${String(r.s || "").replace(/\s+/g, " ")} | ${String(r.m || "").replace(/\s+/g, " ")}`).join("\n");
  const r = await fetch("https://api.anthropic.com/v1/messages", { signal: AbortSignal.timeout(Math.max(5000, deadline - Date.now() - 3000)), method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY || "", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || "claude-opus-5-5", max_tokens: 8000, messages: [{ role: "user", content:
`These are customer emails to CO36 (men's clothing) from the last 3 days, one per line: id | reason | summary | start of message.
Find SPECIFIC problems that several different customers share, the kind a manager should fix at the source. Examples: "charged twice at checkout", "BF code not applying", "orders from Nov 10 not shipped yet", "Moss Mock Neck shrinks after washing", "wrong size sent in the 3-pack".
Rules: only groups with 4 or more DIFFERENT customers; be specific (not "shipping questions" or "returns"); a plain return or exchange because of fit is NOT a common problem unless something specific repeats (same product, same defect). Skip thank-yous.
At most 8 issues, at most 40 ids each. Answer with one line per issue and nothing else, in exactly this form:
ISSUE | short title, under 8 words | one sentence: what's happening and what to check | the reason most of them have | n123, n456, ...
If there are none, answer: NONE

${list}` }] }) });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error?.message || `Claude ${r.status}`);
  // Nov 22: JSON answers broke on quote marks inside titles ("free pants"), so the answer is plain lines now.
  const text = (j.content || []).map(b => b.text || "").join("");
  const o = { issues: text.split("\n").filter(l => /^\s*ISSUE\s*\|/i.test(l)).map(l => { const p = l.split("|").map(x => x.trim());
    return { title: p[1], detail: p[2], topic: p[3], ids: String(p[4] || "").split(/[,\s]+/).map(x => x.trim()).filter(x => /^n\d+$/.test(x)) }; }) };
  if (!o.issues.length && !/\bNONE\b/.test(text)) throw new Error(`unreadable answer (${j.stop_reason || "?"}): ${text.slice(0, 120)}`);
  const valid = new Set(rows.map(x => x.id)), prev = (await getDoc("svc_meta", "trends"))?.issues || [];
  const issues = (Array.isArray(o.issues) ? o.issues : []).map(x => ({ title: String(x.title || "").slice(0, 80), detail: String(x.detail || "").slice(0, 300), topic: x.topic || "other",
    ids: [...new Set((x.ids || []).filter(i => valid.has(i)))] })).filter(x => x.title && x.ids.length >= 4)
    .map(x => { const old = prev.find(p => p.title.toLowerCase() === x.title.toLowerCase() || p.ids.filter(i => x.ids.includes(i)).length >= 3);
      return { ...x, count: x.ids.length, firstAt: old?.firstAt || Date.now() }; })
    .sort((a, b) => b.count - a.count).slice(0, 8);
  await putDoc("svc_meta", "trends", { at: Date.now(), issues });
  return { issues };
}
