// Ella's rewrite queue, on its own minute job (Nov 26): requeued/errored return drafts are rewritten here, 2 at a time,
// so nothing else in a job can push them past Vercel's 60s limit.
import { redraftErrors } from "../lib/redraft.js";
import { putDoc } from "../lib/server.js";
export default async function handler(req, res) {
  const t0 = Date.now();
  const r = await redraftErrors({ limit: 2, deadline: t0 + 52000 }).catch(e => ({ error: String(e.message || e).slice(0, 160) }));
  await putDoc("svc_meta", "redraftLast", { at: Date.now(), ms: Date.now() - t0, ...r }).catch(() => {});
  res.json({ ok: true, ms: Date.now() - t0, ...r });
}
