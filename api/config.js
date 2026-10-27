import { SB_URL, SB_ANON } from "../lib/server.js";
export default function handler(req, res) {
  res.setHeader("cache-control", "no-store");
  res.json({ supabaseUrl: SB_URL(), supabaseKey: SB_ANON(), passwordLogin: !!process.env.SERVICE_PASSWORD, devNoAuth: process.env.DEV_NO_AUTH === "1" && !process.env.VERCEL });
}
