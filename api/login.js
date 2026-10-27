// The Service Hub's own sign-in: one password set in Vercel (SERVICE_PASSWORD). No Supabase accounts, separate from HQ.
import { makeToken, passwordOk } from "../lib/server.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!process.env.SERVICE_PASSWORD) return res.status(500).json({ error: "SERVICE_PASSWORD is not set in Vercel" });
  const { email, password } = req.body || {};
  const who = String(email || "").trim().toLowerCase();
  if (!who || !passwordOk(password)) { await new Promise(r => setTimeout(r, 700)); return res.status(401).json({ error: "Wrong email or password." }); }
  res.json({ token: makeToken(who), email: who });
}
