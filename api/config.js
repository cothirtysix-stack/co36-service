import { SB_URL, SB_ANON } from "../lib/server.js";
import { AUTOPILOT } from "../lib/autopilot.js";
export default function handler(req, res) {
  res.setHeader("cache-control", "no-store");
  res.json({ supabaseUrl: SB_URL(), supabaseKey: SB_ANON(), autopilot: AUTOPILOT.on && Date.now() < Date.parse(AUTOPILOT.until), passwordLogin: !!process.env.SERVICE_PASSWORD, devNoAuth: process.env.DEV_NO_AUTH === "1" && !process.env.VERCEL });
}
