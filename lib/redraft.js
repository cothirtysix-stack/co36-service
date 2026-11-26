// Re-write drafts that errored (outage, requeues). Shared by the minute job and the Inbox job (Nov 26: the minute job ran out of
// its 60s on the sender and only rewrote ~1 a minute, so requeued customers waited). Claims each row first, stops before the deadline.
import { db, init, getDoc, putDoc } from "./server.js";
import { loadTicket, isNoise, isOp, draftFor } from "./ella.js";

export async function redraftErrors({ limit = 2, deadline = Date.now() + 40000, since = 0 } = {}) {
  await init();
  // A rewrite cut off by the 60s limit leaves the ticket marked "tried": give it back after 5 minutes, at most 3 times.
  // SKIP LOCKED (Nov 26): a request frozen mid-save by a cut-off job keeps its row locked; never wait on it.
  await db()`update hub.docs set data = data || jsonb_build_object('retry2At', null, 'claimTries', coalesce((data->>'claimTries')::int, 0) + 1), seq = nextval('hub.docs_seq')
    where coll = 'svc_returns' and id in (select id from hub.docs where coll = 'svc_returns' and not deleted and id like 'n%' and data->>'status' = 'error' and data->>'error' like 'requeued%'
    and data->>'retry2At' is not null and (data->>'retry2At')::bigint < ${Date.now() - 5 * 60e3} and coalesce((data->>'claimTries')::int, 0) < 3 for update skip locked)`;
  const rows = await db()`select id, data from hub.docs where coll = 'svc_returns' and not deleted and id like 'n%' and data->>'status' = 'error'
    and data->>'retry2At' is null and coalesce((data->>'retryNotBefore')::bigint, 0) < ${Date.now()}
    and coalesce((data->>'lastAt')::bigint, (data->>'receivedAt')::bigint, 0) >= ${Math.max(since, Date.now() - 15 * 864e5)}
    order by coalesce((data->>'lastAt')::bigint, 0) desc limit ${limit} for update skip locked`;
  let done = 0; const t0 = Date.now();
  const stage = id => s => putDoc("svc_meta", "redraftStage", { id, stage: s, sec: Math.round((Date.now() - t0) / 1000), at: Date.now() }).catch(() => {});
  await Promise.all(rows.map(async ({ id, data: r }) => {
    if (Date.now() > deadline - 38000) return;
    await putDoc("svc_returns", id, { retryAt: Date.now(), retry2At: Date.now() }, true); // claim
    await stage(id)("loadTicket");
    const t = r.number ? await loadTicket(r.number).catch(() => null) : null;
    if (!t) { const f = (+r.loadFails || 0) + 1; if (r.number && f <= 3) await putDoc("svc_returns", id, { retry2At: null, loadFails: f, retryNotBefore: Date.now() + 20 * 60e3 }, true); return; }
    const comments = (t.comments || []).filter(c => !isNoise(c)), cust = comments.filter(c => !isOp(c)).pop();
    await draftFor(id, { who: r.customer, mail: r.email, subject: r.subject, message: String(cust?.plain_body || cust?.body || r.message || ""), comments, tries: 1, stage: stage(id) }).catch(() => {});
    await stage(id)("done");
    const now = await getDoc("svc_returns", id);
    if (now?.status === "error" && /usage limit|credit balance/i.test(String(now.error || ""))) await putDoc("svc_returns", id, { retry2At: null }, true);
    done++;
  }));
  return { picked: rows.length, done };
}
