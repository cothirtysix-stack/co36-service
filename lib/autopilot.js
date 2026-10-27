// Ella's autopilot for return and exchange replies. On only inside this window; the Returns board has an off switch too.
// Never refunds. Only sends drafts with no flags (no VIPs, nothing missing/damaged/sold out/past window, nobody asking for a human).
export const AUTOPILOT = {
  on: true,                        // 24-hour test, Sarah is off for returns/exchanges
  since: "2026-10-27T19:45:00Z",   // only emails that come in after go-live (older drafts stay drafts)
  until: "2026-10-28T19:45:00Z",   // stops by itself after this
  minDelayMin: 10, maxDelayMin: 20 // wait after the customer's email before sending
};
