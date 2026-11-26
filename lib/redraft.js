// Re-write drafts that errored (outage, requeues). Shared by the minute job and the Inbox job (Nov 26: the minute job ran out of
// its 60s on the sender and only rewrote ~1 a minute, so requeued customers waited). Claims each row first, stops before the deadline.
import { db, init, getDoc, putDoc } from "./server.js";
import { loadTicket, isNoise, isOp, draftFor } from "./ella.js";

export async function redraftErrors({ limit = 4, deadline = Date.now() + 40000, since = 0 } = {}) {
  await init();
  const rows = await db()`select id, data from hub.docs where coll = 'svc_returns' and not deleted and id like 'n%' and data->>'status' = 'error'
    and data->>'retry2At' is null and coalesce((data->>'retryNotBefore')::bigint, 0) < ${Date.now()}
    and coalesce((data->>'lastAt')::bigint, (data->>'receivedAt')::bigint, 0) >= ${Math.max(since, Date.now() - 15 * 864e5)}
    order by coalesce((data->>'lastAt')::bigint, 0) desc limit ${limit}`;
  let done = 0;
  await Promise.all(rows.map(async ({ id, data: r }) => {
    if (Date.now() > deadline - 30000) return;
    await putDoc("svc_returns", id, { retryAt: Date.now(), retry2At: Date.now() }, true); // claim
    const t = r.number ? await loadTicket(r.number).catch(() => null) : null;
    if (!t) { const f = (+r.loadFails || 0) + 1; if (r.number && f <= 3) await putDoc("svc_returns", id, { retry2At: null, loadFails: f, retryNotBefore: Date.now() + 20 * 60e3 }, true); return; }
    const comments = (t.comments || []).filter(c => !isNoise(c)), cust = comments.filter(c => !isOp(c)).pop();
    await draftFor(id, { who: r.customer, mail: r.email, subject: r.subject, message: String(cust?.plain_body || cust?.body || r.message || ""), comments }).catch(() => {});
    const now = await getDoc("svc_returns", id);
    if (now?.status === "error" && /usage limit|credit balance/i.test(String(now.error || ""))) await putDoc("svc_returns", id, { retry2At: null }, true);
    done++;
  }));
  return { picked: rows.length, done };
}
