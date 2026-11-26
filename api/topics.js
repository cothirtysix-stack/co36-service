// Inbox by reason (David, Nov 19), its own minute job so it never slows Ella's returns.
// 1) Loads the last 30 days of conversations once, newest first, walking down from the newest number we've seen
//    (only numbers that exist: no probing ahead, Nov 4). 2) Drafts Ella's training answer for cards still waiting.
// Nothing here sends anything to a customer.
import { db, init, getDoc, putDoc } from "../lib/server.js";
import { recordTicket, draftTopic } from "../lib/topics.js";
import { findTrends } from "../lib/trends.js";
import { verifySaves, resetSaves1123 } from "../lib/saves.js";

async function ticket(n) {
  const r = await fetch(`https://api.richpanel.com/v1/tickets/number/${n}`, { headers: { "x-richpanel-key": process.env.RICHPANEL_API_KEY || "" }, signal: AbortSignal.timeout(12000) });
  if (r.status === 404 || r.status === 400) return { gone: true }; // Nov 20: one number answered 400 and stopped the load for hours
  if (!r.ok) return { stop: r.status };
  return { t: (await r.json()).ticket };
}

export default async function handler(req, res) {
  if (process.env.TOPICS_OFF === "1") return res.json({ ok: true, paused: true });
  const t0 = Date.now(), left = () => 50000 - (Date.now() - t0), out = { loaded: 0, drafted: 0 };
  await init();
  // Even minutes write drafts (one round, up to ~45s), odd minutes load conversations: each run stays well under Vercel's 60s.
  const draftMinute = new Date().getUTCMinutes() % 2 === 0 || req.query?.do === "drafts";
  // Save-offer test round 2 (David, Nov 23: "a/b test the way you ask them ... 1 way will be the winner"): A and C off (0 saves),
  // B and D stay, three new ones without the "sending it back is fine too" exit line.
  if (!(await getDoc("svc_meta", "offerRound2"))) {
    await putDoc("svc_experiments", "seed11190", { on: false, offAt: Date.now(), offWhy: "round 2: 0 saves" }, true);
    await putDoc("svc_experiments", "seed11192", { on: false, offAt: Date.now(), offWhy: "round 2: 0 saves" }, true);
    const V = [["E · Set aside (no exit)", "I've set aside the XL in Black, Gray and White for you. Reply yes and your prepaid label is on its way, and the new ones ship the day yours are scanned."],
      ["F · Faster + other color (no exit)", "A swap is quicker than a refund. Want the XL instead, or a different color? Moss and Navy are in stock in your size. Reply yes and your label goes out today."],
      ["G · Faster than a refund (no exit)", "Want to try the M instead? A swap is quicker than a refund: reply yes and the new one ships the day yours is scanned."]];
    for (const [i, [name, text]] of V.entries()) await putDoc("svc_experiments", `r2-${i}`, { name, text, on: true, noExit: true, context: "save", createdAt: Date.now() + i, by: "Ella (round 2)", sent: 0, exchanges: 0, credits: 0 });
    await putDoc("svc_meta", "offerRound2", { at: Date.now() });
  }
  // Catch-up after the Nov 26 AI-limit outage: emails whose read failed get sent through the webhook again (10 per run).
  if (!draftMinute && !(await getDoc("svc_meta", "outage1126done"))) {
    const rows = await db()`select id from hub.docs where coll = 'svc_seen' and not deleted and data->>'read' = 'failed' and coalesce((data->>'at')::bigint,0) > ${Date.now() - 4 * 864e5} and data->>'rerunAt' is null order by id desc limit 10`;
    if (!rows.length) await putDoc("svc_meta", "outage1126done", { at: Date.now() });
    // 5 at a time in parallel (one by one took ~25s each).
    for (let i = 0; i < rows.length && left() > 30000; i += 5) await Promise.all(rows.slice(i, i + 5).map(async ({ id }) => {
      const number = id.replace(/^n/, ""); if (!/^\d+$/.test(number)) { await putDoc("svc_seen", id, { rerunAt: Date.now() }, true); return; }
      await putDoc("svc_seen", id, { last: null, rerunAt: Date.now() }, true);
      const r = await fetch(`https://${req.headers.host}/api/inbound`, { method: "POST", headers: { "content-type": "application/json", "x-co36-key": process.env.SERVICE_INBOUND_KEY || "" },
        body: JSON.stringify({ ticketConversationNumber: number }), signal: AbortSignal.timeout(25000) }).catch(() => null);
      out.rerun = (out.rerun || 0) + 1; if (r && !r.ok) out.rerunErr = r.status;
    }));
  }
  // Saves: only real exchanges count (Nov 23). One-time reset of the old word-based saves, then a check every loading minute.
  if (!(await getDoc("svc_meta", "resetSaves1123b"))) { await resetSaves1123(); await putDoc("svc_meta", "resetSaves1123b", { at: Date.now() }); }
  if (!draftMinute) out.saves = await verifySaves(10).catch(e => String(e.message || e).slice(0, 100));
  // 1) Backfill, 4 at a time.
  let m = await getDoc("svc_meta", "topicsBackfill");
  // ver 2 (Nov 20): "Other" split into more reasons, so the 30 days are read again from the newest.
  if (!m || m.ver !== 2) { const nw = await getDoc("svc_meta", "newest"); m = { ver: 2, next: Number(nw?.number) || 0, done: !nw?.number, startedAt: Date.now(), n: 0, old: 0 }; }
  while (!draftMinute && !m.done && m.next > 0 && left() > 36000) {
    const nums = [0, 1, 2, 3, 4, 5, 6, 7].map(i => m.next - i).filter(n => n > 0);
    const got = await Promise.all(nums.map(n => ticket(n).catch(e => ({ stop: String(e.message || e).slice(0, 60) }))));
    const stop = got.find(g => g.stop); if (stop) { m.lastStop = { at: Date.now(), why: String(stop.stop) }; break; }
    const res2 = await Promise.all(got.map((g, i) => g.t ? recordTicket(nums[i], g.t).catch(e => "error " + String(e.message || e).slice(0, 60)) : "gone"));
    m.n += nums.length; out.loaded += nums.length;
    m.old = res2.every(r => r === "old") ? (m.old || 0) + 1 : 0;
    if (m.old >= 2) m.done = true; // 16 in a row older than 31 days
    m.next -= nums.length; m.at = Date.now();
    await putDoc("svc_meta", "topicsBackfill", m); // save every round so a timeout loses nothing
  }
  await putDoc("svc_meta", "topicsBackfill", m);
  // 2) Drafts: newest waiting first, 3 at a time. A draft stuck "drafting" for 5+ min goes back in line; errors retry up to 3 times.
  // Common problems: every ~30 minutes this takes the drafting slot.
  const tr = draftMinute ? await getDoc("svc_meta", "trends") : null;
  if (draftMinute && !(tr?.at > Date.now() - 3 * 3600e3)) { const tr2 = await findTrends(t0 + 50000).catch(e => ({ error: String(e.message || e).slice(0, 160) })); out.trends = tr2.issues ? tr2.issues.length : tr2.error;
    if (tr2.error) await putDoc("svc_meta", "trendsError", { at: Date.now(), error: tr2.error }); }
  else if (draftMinute && new Date().getUTCMinutes() % 10 === 0 && process.env.TOPICS_DRAFTS !== "off") {
    const rows = await db()`select id from hub.docs where coll = 'svc_topics' and not deleted and data->>'lane' = 'topics' and coalesce((data->>'tries')::int, 0) < 3 and coalesce((data->>'lastAt')::bigint, 0) > ${Date.now() - 864e5}
      and (data->>'status' = 'queued' or data->>'status' = 'error' or (data->>'status' = 'drafting' and coalesce((data->>'draftStartedAt')::bigint, 0) < ${Date.now() - 5 * 60e3}))
      order by coalesce((data->>'lastAt')::bigint, 0) desc limit 1`;
    const end = t0 + 50000; await Promise.all(rows.map(r => draftTopic(r.id, "", end).catch(() => {})));
    out.drafted += rows.length;
  }
  res.json({ ok: true, ...out, backfill: { next: m.next, done: m.done, n: m.n } });
}
