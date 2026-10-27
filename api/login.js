// The Service Hub's own sign-in, separate from HQ: David signs in with SERVICE_PASSWORD; teammates with their own password (Team page).
import { makeToken, passwordOk, getDoc, checkPw } from "../lib/server.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!process.env.SERVICE_PASSWORD) return res.status(500).json({ error: "SERVICE_PASSWORD is not set in Vercel" });
  const { email, password } = req.body || {};
  const who = String(email || "").trim().toLowerCase();
  const bad = async () => { await new Promise(r => setTimeout(r, 700)); res.status(401).json({ error: "Wrong email or password." }); };
  if (!who || !password) return bad();
  const u = await getDoc("svc_users", who);
  if (u && !u.disabled && checkPw(password, u.hash)) return res.json({ token: makeToken(who, "member", u.pages), email: who, role: "member", pages: u.pages, name: u.name || "" });
  if (passwordOk(password)) return res.json({ token: makeToken(who), email: who, role: "owner" });
  return bad();
}
