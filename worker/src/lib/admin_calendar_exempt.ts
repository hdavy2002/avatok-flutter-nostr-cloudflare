// [ADMIN2-EVENTS 2026-09-26] Owner decision: Saa Thum's own events skip the creator
// Google Calendar gates.
//
// Saa Thum is a direct service. The admin (env.ADMIN_UIDS) creates every puja/havan
// under their own account, and those events are run by Saa Thum's priests, not by the
// admin's personal diary. Requiring that account to keep a Google Calendar connected
// and synced within 30 minutes, and refusing two pujas at the same time because they
// "clash" on one person's calendar, blocks the business for no protection.
//
// Behind `adminListingsSkipCalendar` (routes/config.ts, default true), a listing whose
// creator_id is an admin skips exactly:
//   * calendar_not_ready  (Google Calendar connected / selected / fresh) — lib/listing_blockers.ts
//   * calendar_conflict   (clash with the creator's calendar)            — lib/listing_blockers.ts
//   * the exclusive calendar hold publish makes (publishFixedListing)    — routes/listings.ts
// Nothing else changes: identity/KYC, price floor, moderation, content policy,
// performer disclosure, category, poster approval, review binding and every money
// rule still run. Non-admin creators are untouched.
import type { Env } from "../types";
import { readConfig } from "../routes/config";

/** Is `uid` one of the platform admins (env.ADMIN_UIDS, comma-separated)? */
export function isAdminUid(env: Pick<Env, "ADMIN_UIDS">, uid: string | null | undefined): boolean {
  if (!uid) return false;
  return (env.ADMIN_UIDS ?? "").split(",").map((s) => s.trim()).filter(Boolean).includes(String(uid));
}

/** Pure decision, for tests: the flag is on (absent ⇒ default true) and the creator is an admin. */
export function calendarExemptFor(
  cfg: { adminListingsSkipCalendar?: boolean } | null,
  env: Pick<Env, "ADMIN_UIDS">,
  creatorUid: string | null | undefined,
): boolean {
  if (!cfg || cfg.adminListingsSkipCalendar === false) return false;
  return isAdminUid(env, creatorUid);
}

/**
 * Does this creator's listing skip the calendar gates? Fails CLOSED: an unreadable
 * config keeps every calendar check in place.
 */
export async function adminCalendarExempt(env: Env, creatorUid: string | null | undefined): Promise<boolean> {
  if (!isAdminUid(env, creatorUid)) return false;
  try {
    return calendarExemptFor(await readConfig(env), env, creatorUid);
  } catch {
    return false;
  }
}
