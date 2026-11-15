// The product page's "Find my size" (theme assets/co36.js letterSize + WAIST), so Ella recommends exactly what the site does (David, Nov 15).
const LETTERS = ["XS", "S", "M", "L", "XL", "XXL"];
const WAIST = { XS: 28, S: 30, M: 32, L: 34, XL: 36, XXL: 38 };
export function letterSize(h, w) {
  if (!h || !w) return "";
  if (h <= 66) { if (w <= 130) return "XS"; if (w <= 145) return "S"; if (w <= 189) return "M"; if (w <= 215) return "L"; if (w <= 240) return "XL"; return "XXL"; }
  if (h <= 69) { if (w <= 165) return "S"; if (w <= 190) return "M"; if (w <= 215) return "L"; if (w <= 250) return "XL"; return "XXL"; }
  if (h <= 73) { if (w <= 175) return "M"; if (w <= 220) return "L"; if (w <= 250) return "XL"; return "XXL"; }
  if (h <= 76) { if (w <= 200) return "L"; if (w <= 240) return "XL"; return "XXL"; }
  if (w <= 235) return "XL"; return "XXL";
}
// Height and weight from a message: 6'0", 5'10, 5 ft 10, 6 foot 1, 70 inches; 210 lbs, 210lb, 210 pounds.
export function heightWeight(text) {
  const t = String(text || "");
  const f = t.match(/\b([4-7])\s*(?:'|’|ft|feet|foot)\s*(\d{1,2})?\s*(?:"|”|''|in|inches)?/i), i = t.match(/\b(5\d|6\d|7\d|80)\s*(?:in|inches)\b/i);
  const h = f ? +f[1] * 12 + (+f[2] || 0) : i ? +i[1] : 0;
  const m = t.match(/\b(\d{2,3})\s*(?:lbs?|pounds?)\b/i), w = m ? +m[1] : 0;
  return { h: h >= 56 && h <= 84 ? h : 0, w: w >= 90 && w <= 400 ? w : 0 };
}
export function sizeFacts(text) {
  const { h, w } = heightWeight(text);
  if (!h || !w) return h || w ? `Size finder: they gave only ${h ? "height" : "weight"}. Ask for the other to give an exact size.` : "";
  const L = letterSize(h, w), up = LETTERS[LETTERS.indexOf(L) + 1], waist = Math.min(40, WAIST[L] + 2), tall = h >= 72;
  return `Size finder (same as the "Find my size" on our product pages) for ${Math.floor(h / 12)}'${h % 12}" and ${w} lbs: shirts/tops ${L} (fitted through the chest and arms, easy over the stomach${up ? `; prefer it looser, go up to ${up}` : ""}). Pants/chinos: ${waist} ${tall ? "Tall" : "Regular"} (sized up one from usual for an easy waist${waist === 40 ? "; 40 is our largest waist" : ""}).`;
}
