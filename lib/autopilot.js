// Ella's autopilot for return and exchange replies. On only inside this window; the Returns board has an off switch too.
// Never refunds. Only sends drafts with no flags (no VIPs, nothing missing/damaged/sold out/past window, nobody asking for a human).
export const AUTOPILOT = {
  on: false,                       // flip to true for the 1-day test
  until: "2026-10-28T02:00:00Z",   // stops by itself after this
  minDelayMin: 10, maxDelayMin: 20 // wait after the customer's email before sending
};
