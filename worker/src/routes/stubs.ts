// Creator-marketplace Phase 1 — URL-space reservation. Each marketplace domain
// gets its namespace locked NOW; the owning phase replaces the 501 with real
// handlers. Mounted in index.ts AFTER all real routes, so already-shipped
// endpoints (e.g. /api/wallet/balance) keep working and only unclaimed paths
// in these namespaces answer 501.
import { json } from "../util";

const DOMAINS: Record<string, string> = {
  wallet: "Phase 2 — AvaWallet",
  payout: "Phase 3 — AvaPayout",
  identity: "Phase 3 — AvaIdentity",
  storage: "Phase 4 — AvaStorage",
  calendar: "Phase 5 — AvaCalendar",
  booking: "Phase 5 — AvaBooking",
  listings: "Phase 6 — AvaExplore listings",
  inbox: "Phase 8 — AvaInbox",
  avabrain: "Phase 9 — AvaChat/AvaBrain",
};

export function marketplaceStub(pathname: string): Response | null {
  const m = pathname.match(/^\/api\/([a-z]+)(?:\/|$)/);
  if (!m || !(m[1] in DOMAINS)) return null;
  return json(
    { error: "not_implemented", domain: m[1], ships_in: DOMAINS[m[1]] },
    501,
  );
}
