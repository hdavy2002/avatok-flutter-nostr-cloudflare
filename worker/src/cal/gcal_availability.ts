import type { Env } from "../types";
import { metaDb } from "../db/shard";

/**
 * Google readiness is ONE predicate shared by the status endpoint, the listing
 * availability preview and the booking/claim authority (validateListingSlot,
 * claimListingSlot, claimExclusiveReservation). If those disagree, a customer
 * can be shown a slot that checkout later refuses, so they must never be
 * re-derived independently.
 */

/** Age after which a selected calendar's busy data is no longer trustworthy. */
export const GCAL_READY_MAX_AGE_MS = 30 * 60_000;

export type GcalReadinessReason =
  | "disconnected"
  | "no_selected_calendars"
  | "pending"
  | "stale"
  | "error";

export interface GcalReadiness {
  /** True only when every selected source is fresh enough to protect a booking. */
  ready: boolean;
  /** null exactly when ready; otherwise why the sources are not trustworthy yet. */
  reason: GcalReadinessReason | null;
  /** True when a disconnected/no-selection account was deliberately tolerated. */
  tolerated: boolean;
  /** Age of the OLDEST selected successful sync, or null when it is unknown. */
  age_ms: number | null;
  /** Oldest selected `last_success_at`; null when any selected source never synced. */
  oldest_selected_success_at: number | null;
  /** Newest selected `last_success_at`; null when any selected source never synced. */
  newest_selected_success_at: number | null;
  selected_count: number;
  stale_count: number;
  failed_count: number;
  never_synced_count: number;
  calendar_count: number;
  max_age_ms: number;
}

type ReadinessSeed = {
  ready: boolean;
  reason: GcalReadinessReason | null;
  max_age_ms: number;
};

function readiness(seed: ReadinessSeed & Partial<GcalReadiness>): GcalReadiness {
  return {
    tolerated: false,
    age_ms: null,
    oldest_selected_success_at: null,
    newest_selected_success_at: null,
    selected_count: 0,
    stale_count: 0,
    failed_count: 0,
    never_synced_count: 0,
    calendar_count: 0,
    ...seed,
  };
}

/**
 * Full readiness snapshot. `requireConnected` mirrors the booking authority: a
 * disconnected account (or a deliberate empty selection) is tolerated by the
 * legacy/cosmetic callers but is NOT ready when a booking must be protected.
 */
export async function gcalReadiness(
  env: Env,
  uid: string,
  opts: { maxAgeMs?: number; requireConnected?: boolean; now?: number } = {},
): Promise<GcalReadiness> {
  const maxAgeMs = opts.maxAgeMs ?? GCAL_READY_MAX_AGE_MS;
  const requireConnected = opts.requireConnected ?? false;
  const now = opts.now ?? Date.now();
  const fail = (reason: GcalReadinessReason): GcalReadiness =>
    readiness({ ready: false, reason, max_age_ms: maxAgeMs });
  let account: { user_id: string } | null;
  try {
    account = await metaDb(env).prepare("SELECT user_id FROM gcal_accounts WHERE user_id=?1").bind(uid).first<{ user_id: string }>();
  } catch { return fail("error"); }
  if (!account) {
    return readiness({
      ready: !requireConnected,
      reason: "disconnected",
      tolerated: !requireConnected,
      max_age_ms: maxAgeMs,
    });
  }
  let rows: { results?: Array<{ selected: number; last_success_at: number | null; last_error: string | null }> };
  try {
    rows = await metaDb(env).prepare("SELECT selected,last_success_at,last_error FROM gcal_calendars WHERE user_id=?1").bind(uid).all<{ selected: number; last_success_at: number | null; last_error: string | null }>();
  } catch { return fail("error"); }
  const calendars = rows.results ?? [];
  const selected = calendars.filter((row) => row.selected === 1);
  // A selection that never synced, errored, or went stale is not evidence of
  // health. Each counter is reported so the client can name the failing source.
  const failed = selected.filter((row) => !!row.last_error).length;
  // A NULL column means "never synced", and Number(null) is 0 — a *valid* epoch
  // that would read as a 1970 success. Only an explicit, finite, POSITIVE
  // timestamp counts as a sync: null, "", NaN and 0 are all "still pending", so
  // a never-synced source can never make readiness true or fill the headline.
  const successAt = (row: { last_success_at: number | null }): number | null => {
    if (row.last_success_at === null || row.last_success_at === undefined) return null;
    const value = Number(row.last_success_at);
    return Number.isFinite(value) && value > 0 ? value : null;
  };
  const neverSynced = selected.filter((row) => !row.last_error && successAt(row) === null).length;
  const successAts = selected.map(successAt);
  const synced = successAts.filter((value): value is number => value !== null);
  const ages = synced.map((value) => now - value);
  // never_synced_count remains only selected sources with no error and no
  // positive success. stale_count mirrors each selected calendar row's stale
  // predicate exactly: error OR missing positive success OR too old, counted once.
  const stale = selected.filter((row) => {
    const lastSuccess = successAt(row);
    return !!row.last_error || lastSuccess === null || now - lastSuccess > maxAgeMs;
  }).length;
  const allSynced = selected.length > 0 && successAts.every((value) => value !== null);
  const base: Partial<GcalReadiness> = {
    max_age_ms: maxAgeMs,
    calendar_count: calendars.length,
    selected_count: selected.length,
    failed_count: failed,
    stale_count: stale,
    never_synced_count: neverSynced,
    oldest_selected_success_at: allSynced ? Math.min(...synced) : null,
    newest_selected_success_at: allSynced ? Math.max(...synced) : null,
  };
  if (!calendars.length) return readiness({ ...base, ready: false, reason: "pending", max_age_ms: maxAgeMs });
  if (!selected.length) {
    return readiness({
      ...base,
      ready: !requireConnected,
      reason: "no_selected_calendars",
      tolerated: !requireConnected,
      max_age_ms: maxAgeMs,
    });
  }
  if (failed) return readiness({ ...base, ready: false, reason: "error", max_age_ms: maxAgeMs, age_ms: ages.length ? Math.max(...ages) : null });
  if (neverSynced) return readiness({ ...base, ready: false, reason: "pending", max_age_ms: maxAgeMs });
  const age = Math.max(...ages);
  if (age > maxAgeMs) return readiness({ ...base, ready: false, reason: "stale", max_age_ms: maxAgeMs, age_ms: age });
  return readiness({ ...base, ready: true, reason: null, max_age_ms: maxAgeMs, age_ms: age });
}

/**
 * Backwards-compatible wrapper. Keeps the original return shape so existing
 * callers keep working while sharing the one predicate above.
 */
export async function gcalAvailabilityReady(
  env: Env,
  uid: string,
  maxAgeMs = GCAL_READY_MAX_AGE_MS,
  requireConnected = false,
): Promise<{ ready: boolean; reason: GcalReadinessReason | null; age_ms?: number }> {
  const snapshot = await gcalReadiness(env, uid, { maxAgeMs, requireConnected });
  return {
    ready: snapshot.ready,
    reason: snapshot.reason,
    ...(snapshot.age_ms === null ? {} : { age_ms: snapshot.age_ms }),
  };
}
