import type { Env } from "../types";
import { metaDb } from "../db/shard";

/**
 * Returns whether selected Google busy sources are recent enough to protect a
 * new booking. A disconnected account or deliberate empty selection is ready;
 * a connected source that has never synced, failed, or gone stale is not.
 */
export async function gcalAvailabilityReady(
  env: Env,
  uid: string,
  maxAgeMs = 30 * 60_000,
): Promise<{ ready: boolean; reason?: "disconnected" | "no_selected_calendars" | "pending" | "stale" | "error"; age_ms?: number }> {
  let account: { user_id: string } | null;
  try { account = await metaDb(env).prepare("SELECT user_id FROM gcal_accounts WHERE user_id=?1").bind(uid).first<{ user_id: string }>(); } catch { return { ready: false, reason: "error" }; }
  if (!account) return { ready: true, reason: "disconnected" };
  let rows: { results?: Array<{ selected: number; last_success_at: number | null; last_error: string | null }> };
  try { rows = await metaDb(env).prepare("SELECT selected,last_success_at,last_error FROM gcal_calendars WHERE user_id=?1").bind(uid).all<{ selected: number; last_success_at: number | null; last_error: string | null }>(); } catch { return { ready: false, reason: "error" }; }
  const calendars = rows.results ?? [];
  if (!calendars.length) return { ready: false, reason: "pending" };
  const selected = calendars.filter((row) => row.selected === 1);
  if (!selected.length) return { ready: true, reason: "no_selected_calendars" };
  if (selected.some((row) => row.last_error)) return { ready: false, reason: "error" };
  if (selected.some((row) => !row.last_success_at)) return { ready: false, reason: "pending" };
  const age = Math.max(...selected.map((row) => Date.now() - (row.last_success_at ?? 0)));
  return age <= maxAgeMs ? { ready: true, age_ms: age } : { ready: false, reason: "stale", age_ms: age };
}
