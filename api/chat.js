import { wrap } from "../lib/server.js";
export default wrap(async (req, res) => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: "ANTHROPIC_API_KEY is not set in Vercel" });
  const { messages, tools } = req.body || {};
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || "claude-opus-5-5", max_tokens: 16000, messages, tools: tools?.length ? tools : undefined }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return res.status(r.status === 429 ? 429 : 502).json({ error: j.error?.message || "Claude API error", code: r.status === 429 ? "rate_limited" : "tool_error" });
  res.json({ content: j.content, stop_reason: j.stop_reason });
});
