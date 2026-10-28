// Ella's autopilot for return and exchange replies. On only inside this window; the Returns board has an off switch too.
// Never refunds. Only sends drafts with no flags (no VIPs, nothing missing/damaged/sold out/past window, nobody asking for a human).
export const AUTOPILOT = {
  on: true,                        // 24-hour test, Sarah is off for returns/exchanges
  since: "2026-10-27T19:45:00Z",   // only emails that come in after go-live (older drafts stay drafts)
  until: "2099-01-01T00:00:00Z",   // stays on until David says stop (24h review reminder set)
  afterQcSend: false,               // Oct 28: after-return follow-ups are drafts only until David approves the process
  minDelayMin: 8, maxDelayMin: 12 // wait after the customer's email before sending
};
