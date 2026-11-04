// The hub's red pop-up: what the watchdog (lib/watchdog.js) currently sees wrong with Ella. Signed-in users only.
import { wrap, getDoc } from "../lib/server.js";
export default wrap(async (req, res) => {
  const w = (await getDoc("svc_meta", "watchdog")) || {};
  res.json({ at: w.at || null, problems: (w.problems || []).map(p => p.text) });
});
