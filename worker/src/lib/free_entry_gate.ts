// [FREE-ENTRY-GATE-1 2026-09-04] Owns ONE question: may this uid create or
// hold a `free_entry` listing? Nothing else.
//
// WHY THIS EXISTS: `free_entry` is metered against a creator-declared
// attendee cap with NO mid-session cut-off — lib/free_session.ts enforces an
// admission-time headcount ceiling and a settlement-time clamp only. Neither
// check stops a creator from simply declaring a bigger cap; there is no
// server-side circuit breaker that fires mid-stream once tokens/spend cross
// a limit. That gap is exactly why creation itself is restricted, rather
// than left open to every creator the way most listing fields are: the
// allowlist is the actual safety mechanism, not a formality on top of one.
//
// Default posture is fail-closed (`freeEntryAllowlistOnly` defaults `true`
// in routes/config.ts DEFAULTS) because `freeSessionsEnabled` is already
// `true` in production today — this gate is what keeps the free lane from
// being general-availability for every creator right now.
//
// Callers (listings.ts / admin_listings.ts) call `freeEntryAllowed` at the
// point a `free_entry` listing would be created or edited on; this file does
// not read D1, does not touch listings, and does not own the EDITABLE field
// list — that stays with whoever owns listings.ts.

import type { Env } from "../types";
import type { PlatformConfig } from "../routes/config";

// Same shape as the parseUidList helper duplicated across routes/campaigns.ts,
// routes/campaign_voices.ts, routes/campaign_kb.ts, routes/campaign_analytics.ts,
// routes/campaign_contacts_route.ts and routes/campaign_dids_route.ts (none of
// them export it, so — per existing convention in this codebase — each gate
// keeps its own copy rather than reaching across an owner boundary to import
// one). Comma/whitespace-split, trimmed, empties dropped, case-sensitive.
function parseUidList(raw: string | undefined): string[] {
  return (raw ?? "").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}

/** True when this uid may create or hold a free_entry listing. */
export function freeEntryAllowed(env: Env, cfg: PlatformConfig, uid: string): boolean {
  if (cfg.freeEntryAllowlistOnly !== true) return true; // escape hatch — open to everyone
  const admins = parseUidList(env.ADMIN_UIDS);
  if (admins.includes(uid)) return true;
  const testers = parseUidList(env.FREE_ENTRY_ALLOWLIST);
  return testers.includes(uid);
}
