// Who's signed in and which pages they may open right now (read from the team list, so changes in Settings apply without signing in again).
import { wrap } from "../lib/server.js";
export default wrap(async (req, res, who) => res.json({ role: who.role || "owner", pages: who.role === "member" ? who.pages || [] : null }));
