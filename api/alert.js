// The hub's red pop-up: what the watchdog (lib/watchdog.js) currently sees wrong with Ella. Signed-in users only.
import { wrap, getDoc } from "../lib/server.js";
export default wrap(async (req, res) => {
  const w = (await getDoc("svc_meta", "watchdog")) || {};
  // Common problems from the Inbox (Nov 20): 4+ customers with the same issue in 3 days.
  const t = (await getDoc("svc_meta", "trends")) || {};
  const common = (t.issues || []).map(i => `Common problem: ${i.title} (${i.count} customers in 3 days). See the Inbox page.`);
  res.json({ at: w.at || null, problems: [...(w.problems || []).map(p => p.text), ...common] });
});
