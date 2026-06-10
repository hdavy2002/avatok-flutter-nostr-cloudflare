// Phase 5 — the conflict engine. ONE availability surface for the whole
// platform: every scheduling write path (slot create, booking, AvaLive event
// publish, gcal import, manual block) goes through claimBlock(); every picker
// reads freeSlots() which returns occupied slots FLAGGED, never omitted.
//
// All times are ms epoch UTC. Timezone math (availability_rules.tz) is done
// with Intl zone rules — DST-safe, never a fixed offset.
import type { Env } from "../types";
import { metaDb } from "../db/shard";

export interface Conflict { source_app: string; title: string | null; starts_at: number; ends_at: number; }
export interface Policy { buffer_min: number; min_notice_min: number; max_per_day: number; vacation_until: number | null; }
export const DEFAULT_POLICY: Policy = { buffer_min: 10, min_notice_min: 120, max_per_day: 8, vacation_until: null };

// ---------------------------------------------------------------------------
// Overlap primitives
// ---------------------------------------------------------------------------
export async function checkAvailability(env: Env, userId: string, start: number, end: number, opts?: { bufferMin?: number; excludeRef?: string }): Promise<Conflict | null> {
  const buf = (opts?.bufferMin ?? 0) * 60_000;
  const row = await metaDb(env).prepare(
    `SELECT source_app, title, starts_at, ends_at FROM calendar_blocks
      WHERE user_id=?1 AND status='busy' AND starts_at < ?3 AND ends_at > ?2
        AND (?4 IS NULL OR source_ref != ?4)
      ORDER BY starts_at LIMIT 1`,
  ).bind(userId, start - buf, end + buf, opts?.excludeRef ?? null).first<Conflict>();
  return row ?? null;
}

export interface ClaimArgs {
  userId: string; sourceApp: string; sourceRef: string | null;
  start: number; end: number; title?: string;
  bufferMin?: number;            // policy buffer applied around EXISTING blocks
  status?: "busy" | "tentative";
}

/** Atomic check+insert. A single INSERT…SELECT…WHERE NOT EXISTS statement is
 *  atomic in SQLite/D1 ⇒ of two parallel claims on the same window exactly one
 *  wins; the loser gets the conflicting block back for the 409 payload. */
export async function claimBlock(env: Env, a: ClaimArgs): Promise<{ ok: true; id: string } | { ok: false; conflict: Conflict }> {
  const id = crypto.randomUUID();
  const buf = (a.bufferMin ?? 0) * 60_000;
  const r = await metaDb(env).prepare(
    `INSERT INTO calendar_blocks (id, user_id, source_app, source_ref, starts_at, ends_at, title, status, created_at)
     SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9
      WHERE NOT EXISTS (
        SELECT 1 FROM calendar_blocks
         WHERE user_id=?2 AND status='busy' AND starts_at < ?10 AND ends_at > ?11)`,
  ).bind(id, a.userId, a.sourceApp, a.sourceRef, a.start, a.end, a.title ?? null, a.status ?? "busy", Date.now(), a.end + buf, a.start - buf).run();
  if ((r.meta?.changes ?? 0) > 0) return { ok: true, id };
  const conflict = await checkAvailability(env, a.userId, a.start, a.end, { bufferMin: a.bufferMin });
  return { ok: false, conflict: conflict ?? { source_app: "unknown", title: null, starts_at: a.start, ends_at: a.end } };
}

export async function releaseBlocks(env: Env, sourceApp: string, sourceRef: string): Promise<void> {
  await metaDb(env).prepare(
    "UPDATE calendar_blocks SET status='cancelled' WHERE source_app=?1 AND source_ref=?2 AND status!='cancelled'",
  ).bind(sourceApp, sourceRef).run();
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------
export async function loadPolicy(env: Env, userId: string): Promise<Policy> {
  const row = await metaDb(env).prepare(
    "SELECT buffer_min, min_notice_min, max_per_day, vacation_until FROM booking_policies WHERE user_id=?1",
  ).bind(userId).first<Policy>();
  return row ?? DEFAULT_POLICY;
}

/** Server-side re-validation used by every claim path (A3: UI greying is not
 *  enforcement). Returns a machine reason or null when the claim is allowed. */
export async function policyViolation(env: Env, creatorId: string, start: number, end: number, p?: Policy): Promise<string | null> {
  const pol = p ?? await loadPolicy(env, creatorId);
  const now = Date.now();
  if (pol.vacation_until && start < pol.vacation_until) return "vacation";
  if (start - now < pol.min_notice_min * 60_000) return "min_notice";
  // max_per_day counts confirmed bookings on the creator's UTC day of `start`.
  const dayStart = Math.floor(start / 86_400_000) * 86_400_000;
  const n = await metaDb(env).prepare(
    "SELECT COUNT(*) AS n FROM bookings WHERE creator_id=?1 AND status='confirmed' AND starts_at>=?2 AND starts_at<?3",
  ).bind(creatorId, dayStart, dayStart + 86_400_000).first<{ n: number }>();
  if ((n?.n ?? 0) >= pol.max_per_day) return "max_per_day";
  return null; // buffer is enforced inside claimBlock's overlap window
}

// ---------------------------------------------------------------------------
// Timezone helpers (A2) — IANA zone rules via Intl; DST-safe by construction.
// ---------------------------------------------------------------------------
function zoneOffsetMs(tz: string, utcMs: number): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(utcMs))) p[part.type] = part.value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +(p.hour === "24" ? "0" : p.hour), +p.minute, +p.second);
  return asUtc - utcMs;
}

/** "minutes past local midnight of YYYY-MM-DD in tz" → ms epoch UTC.
 *  Two-pass conversion converges across DST transitions. */
export function zonedEpoch(date: string, minutes: number, tz: string): number {
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error("bad date");
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], 0, minutes);
  let utc = wall - zoneOffsetMs(tz, wall);
  utc = wall - zoneOffsetMs(tz, utc);
  return utc;
}

/** Weekday (0=Sun…6=Sat) of a calendar date — date strings are calendar dates,
 *  identical in every zone, so plain UTC weekday is correct. */
export function weekdayOf(date: string): number {
  return new Date(date + "T00:00:00Z").getUTCDay();
}

// ---------------------------------------------------------------------------
// Free-slot computation: availability_rules minus calendar_blocks, with policy
// flags. Occupied/blocked slots are RETURNED flagged, not omitted (spec).
// ---------------------------------------------------------------------------
export interface SlotOut {
  start: number; end: number; available: boolean;
  reason?: string;               // occupied|buffer|min_notice|max_per_day|vacation
  occupied_by?: { source_app: string; title: string | null };
}

export async function freeSlots(env: Env, creatorId: string, date: string, durMin: number): Promise<SlotOut[]> {
  const wd = weekdayOf(date);
  const rules = (await metaDb(env).prepare(
    "SELECT start_min, end_min, tz, slot_min FROM availability_rules WHERE user_id=?1 AND weekday=?2",
  ).bind(creatorId, wd).all()).results as { start_min: number; end_min: number; tz: string; slot_min: number }[] ?? [];
  if (!rules.length) return [];

  const pol = await loadPolicy(env, creatorId);
  const now = Date.now();
  const out: SlotOut[] = [];

  // Day window across all rules (for one blocks query).
  const lo = Math.min(...rules.map((r) => zonedEpoch(date, r.start_min, r.tz)));
  const hi = Math.max(...rules.map((r) => zonedEpoch(date, r.end_min, r.tz)));
  const blocks = ((await metaDb(env).prepare(
    "SELECT source_app, title, starts_at, ends_at FROM calendar_blocks WHERE user_id=?1 AND status='busy' AND starts_at < ?3 AND ends_at > ?2",
  ).bind(creatorId, lo - 86_400_000, hi + 86_400_000).all()).results ?? []) as unknown as Conflict[];

  const dayStart = Math.floor(lo / 86_400_000) * 86_400_000;
  const booked = await metaDb(env).prepare(
    "SELECT COUNT(*) AS n FROM bookings WHERE creator_id=?1 AND status='confirmed' AND starts_at>=?2 AND starts_at<?3",
  ).bind(creatorId, dayStart, dayStart + 86_400_000).first<{ n: number }>();
  const dayFull = (booked?.n ?? 0) >= pol.max_per_day;

  for (const r of rules) {
    const step = Math.max(5, durMin || r.slot_min);
    for (let m = r.start_min; m + step <= r.end_min; m += step) {
      const start = zonedEpoch(date, m, r.tz);
      const end = start + step * 60_000;
      const slot: SlotOut = { start, end, available: true };
      const buf = pol.buffer_min * 60_000;
      const hit = blocks.find((b) => b.starts_at < end && b.ends_at > start);
      const bufHit = !hit && blocks.find((b) => b.starts_at < end + buf && b.ends_at > start - buf);
      if (pol.vacation_until && start < pol.vacation_until) { slot.available = false; slot.reason = "vacation"; }
      else if (hit) { slot.available = false; slot.reason = "occupied"; slot.occupied_by = { source_app: hit.source_app, title: hit.title }; }
      else if (bufHit) { slot.available = false; slot.reason = "buffer"; }
      else if (start - now < pol.min_notice_min * 60_000) { slot.available = false; slot.reason = "min_notice"; }
      else if (dayFull) { slot.available = false; slot.reason = "max_per_day"; }
      out.push(slot);
    }
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}
