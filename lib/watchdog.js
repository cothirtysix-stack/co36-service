// Watchdog (David, Nov 4: "if there is an issue, reach out to us"): every 10 minutes, check that Ella is healthy.
// When something breaks, email Michelle and David in plain words (via Resend, RESEND_API_KEY) so she can pick up tickets by hand.
// The same issue is emailed at most once every 6 hours; a "back to normal" email follows when it clears.
import { db, init, getDoc, putDoc } from "./server.js";

const RP_KEY = () => process.env.RICHPANEL_API_KEY || "";

async function recipients() {
  const env = String(process.env.ALERT_EMAILS || "").split(/[,\s]+/).filter(s => s.includes("@"));
  if (env.length) return env;
  const rows = await db()`select id from hub.docs where coll = 'svc_users' and not deleted and (data->>'name' ilike '%michelle%' or id ilike '%michelle%')`;
  return [...new Set([...rows.map(r => r.id).filter(s => s.includes("@")), "david@cothirtysix.com"])]; // David, Nov 4: "email both of us"
}

async function problems() {
  const out = [], now = Date.now();
  // 1. Richpanel accepts Ella's key (Nov 3: key cancelled → nothing read or sent for 13 hours).
  const r = await fetch("https://api.richpanel.com/v1/teams", { headers: { "x-richpanel-key": RP_KEY() } }).catch(() => null);
  if (!r || !r.ok) {
    const said = r ? (await r.text().catch(() => "")).slice(0, 200) : "no answer";
    out.push({ key: "richpanel", text: `Richpanel is not letting Ella in (${r ? r.status : "down"}: ${said}). She can't read or answer any emails. Please answer return/exchange emails by hand until this is fixed.` });
  }
  // 2. Drafts failing to be written (Nov 4: ~80 came back empty).
  const [e] = await db()`select count(*)::int as n from hub.docs where coll = 'svc_returns' and not deleted and id like 'n%' and data->>'status' = 'error'
    and coalesce((data->>'lastAt')::bigint, (data->>'receivedAt')::bigint, 0) > ${now - 2 * 3600e3}`;
  if (e.n >= 5) out.push({ key: "errors", text: `${e.n} of Ella's replies failed to write in the last 2 hours. Those customers haven't been answered yet.` });
  // 3. Clean replies that should have gone out but didn't (ready, nothing blocking, over 45 minutes old).
  const [s] = await db()`select count(*)::int as n from hub.docs where coll = 'svc_returns' and not deleted and id like 'n%' and data->>'status' = 'draft'
    and data->>'handedAt' is null and data->>'sarahAt' is null and jsonb_array_length(coalesce(data->'flags', '[]'::jsonb)) = 0
    and data->>'intent' in ('return', 'exchange') and data->>'redo5' is null and data->>'releasedAt' is null
    and coalesce((data->>'lastAt')::bigint, (data->>'receivedAt')::bigint, 0) between ${now - 24 * 3600e3} and ${now - 45 * 60e3}`;
  if (s.n >= 3) out.push({ key: "stuck", text: `${s.n} return/exchange replies are ready but haven't gone out (over 45 minutes old).` });
  // 4. Nothing sent for 4 hours during the day (9am–9pm New York) while return emails are coming in.
  const hour = +new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false });
  if (hour >= 9 && hour < 21) {
    const [x] = await db()`select max((data->>'sentAt')::bigint) as last, count(*) filter (where (data->>'receivedAt')::bigint > ${now - 4 * 3600e3})::int as asks
      from hub.docs where coll = 'svc_returns' and not deleted and id like 'n%'`;
    if (x.asks >= 5 && (Number(x.last) || 0) < now - 4 * 3600e3) out.push({ key: "silent", text: `Ella hasn't sent a single reply in 4 hours, even though ${x.asks} return/exchange emails came in.` });
  }
  // 5. The safety net that catches missed emails has fallen behind.
  const [scan, newest] = await Promise.all([getDoc("svc_meta", "qcscan"), getDoc("svc_meta", "newest")]);
  if (Number(newest?.number) - Number(scan?.last) > 150) out.push({ key: "scan", text: `The backup check for missed emails is ${Number(newest.number) - Number(scan.last)} tickets behind.` });
  // 6. The every-minute job stopped running.
  const beat = await getDoc("svc_meta", "cronbeat");
  if (beat?.at && beat.at < now - 20 * 60e3) out.push({ key: "cron", text: `Ella's every-minute job hasn't run for ${Math.round((now - beat.at) / 60e3)} minutes.` });
  return out;
}

async function email(to, subject, text) {
  if (!process.env.RESEND_API_KEY || !to.length) return { ok: false, why: !to.length ? "no recipients" : "RESEND_API_KEY missing" };
  const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${process.env.RESEND_API_KEY}` },
    body: JSON.stringify({ from: process.env.ALERT_FROM || "CO36 Service Hub <alerts@cothirtysix.com>", to, subject, text }) });
  return { ok: r.ok, why: r.ok ? null : (await r.text().catch(() => "")).slice(0, 200) };
}

export async function watchdog() {
  await init();
  const meta = (await getDoc("svc_meta", "watchdog")) || {}, now = Date.now();
  if (meta.at && now - meta.at < 10 * 60e3) return; // every 10 minutes
  const found = await problems().catch(err => [{ key: "watchdog", text: `The health check itself failed: ${String(err.message || err).slice(0, 150)}` }]);
  const sentAt = { ...(meta.sentAt || {}) }, fresh = found.filter(p => !sentAt[p.key] || now - sentAt[p.key] > 6 * 3600e3);
  const cleared = Object.keys(sentAt).filter(k => !found.some(p => p.key === k));
  let result = null;
  if (fresh.length || cleared.length) {
    const to = await recipients();
    const body = fresh.length
      ? `Hi Michelle and David,\n\nSomething is wrong with Ella:\n\n${found.map(p => `• ${p.text}`).join("\n")}\n\nUntil it's fixed, please check Richpanel and answer return/exchange emails by hand. Claude is looking into it.\n\nService Hub: https://co36-service.vercel.app/home.html`
      : `Hi Michelle and David,\n\nElla is back to normal. Nothing needs to be done by hand anymore.\n\nService Hub: https://co36-service.vercel.app/home.html`;
    result = await email(to, fresh.length ? `Ella needs attention: ${fresh[0].text.split(".")[0]}` : "Ella is back to normal", body);
    if (result.ok) { fresh.forEach(p => { sentAt[p.key] = now; }); cleared.forEach(k => delete sentAt[k]); }
  }
  await putDoc("svc_meta", "watchdog", { at: now, problems: found, sentAt, lastEmail: result ? { at: now, ...result } : meta.lastEmail || null });
}
