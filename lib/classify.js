// One question, asked reliably: "is this customer asking to return or exchange something?"
// Fast model first, the main model if that fails, and a broad word check only if both are down — so an email is never
// dropped just because one step failed (Oct 29: emails were missed when the reader failed and the word list didn't match).
import { plainText } from "./ella.js";

const BROAD = /\b(return|returning|exchange|refund|label|fit|fits|fitting|too (big|small|tight|loose|long|short)|size|sizes)\b/i;

async function ask(model, subject, message) {
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY || "", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 5, messages: [{ role: "user", content:
      `A customer emailed CO36, a men's clothing brand. Are they asking to return, exchange, or send back something they received (any reason, including fit, size, didn't like it, wrong item, or how to get a return label)? Reply with only YES or NO.\n\nSubject: ${String(subject || "").slice(0, 200)}\nMessage: ${plainText(message).slice(0, 3000)}` }] }) });
  if (!r.ok) throw new Error(`Claude ${r.status}`);
  const t = ((await r.json()).content || []).map(b => b.text || "").join("").trim().toUpperCase();
  if (!/^(YES|NO)/.test(t)) throw new Error("unclear");
  return t.startsWith("YES");
}

export async function isReturnAsk(subject, message) {
  for (const model of [process.env.ANTHROPIC_FAST_MODEL || "claude-haiku-5-5", process.env.ANTHROPIC_MODEL || "claude-opus-5-5"])
    for (let i = 0; i < 2; i++) { try { return { yes: await ask(model, subject, message), by: model }; } catch { await new Promise(r => setTimeout(r, 600)); } }
  return { yes: BROAD.test(plainText(`${subject || ""} ${message}`)), by: "words" };
}
