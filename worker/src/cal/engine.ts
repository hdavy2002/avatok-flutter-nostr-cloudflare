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
  let row: Conflict | null = null;
  try {
    row = await metaDb(env).prepare(
      `SELECT b.source_app, b.title, b.starts_at, b.ends_at FROM calendar_blocks b
        WHERE b.user_id=?1 AND b.status='busy' AND b.starts_at < ?3 AND b.ends_at > ?2
          AND (?4 IS NULL OR b.source_ref != ?4)
          AND NOT EXISTS (SELECT 1 FROM availability_reservations ar WHERE b.source_app='availability' AND ar.id=b.source_ref AND (ar.status IN ('cancelled','expired') OR (ar.status='held' AND ar.hold_expires_at IS NOT NULL AND ar.hold_expires_at<=?5)))
        ORDER BY b.starts_at LIMIT 1`,
    ).bind(userId, start - buf, end + buf, opts?.excludeRef ?? null, Date.now()).first<Conflict>();
  } catch {
    row = await metaDb(env).prepare(
      `SELECT source_app, title, starts_at, ends_at FROM calendar_blocks
        WHERE user_id=?1 AND status='busy' AND starts_at < ?3 AND ends_at > ?2
          AND (?4 IS NULL OR source_ref != ?4)
        ORDER BY starts_at LIMIT 1`,
    ).bind(userId, start - buf, end + buf, opts?.excludeRef ?? null).first<Conflict>();
  }
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
  let r: D1Result;
  try {
    r = await metaDb(env).prepare(
      `INSERT INTO calendar_blocks (id, user_id, source_app, source_ref, starts_at, ends_at, title, status, created_at)
       SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9
        WHERE NOT EXISTS (
          SELECT 1 FROM calendar_blocks b
           WHERE b.user_id=?2 AND b.status='busy' AND b.starts_at < ?10 AND b.ends_at > ?11
             AND NOT EXISTS (SELECT 1 FROM availability_reservations ar WHERE b.source_app='availability' AND ar.id=b.source_ref AND (ar.status IN ('cancelled','expired') OR (ar.status='held' AND ar.hold_expires_at IS NOT NULL AND ar.hold_expires_at<=?9))))`,
    ).bind(id, a.userId, a.sourceApp, a.sourceRef, a.start, a.end, a.title ?? null, a.status ?? "busy", Date.now(), a.end + buf, a.start - buf).run();
  } catch {
    r = await metaDb(env).prepare(
      `INSERT INTO calendar_blocks (id, user_id, source_app, source_ref, starts_at, ends_at, title, status, created_at)
       SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9
        WHERE NOT EXISTS (
          SELECT 1 FROM calendar_blocks
           WHERE user_id=?2 AND status='busy' AND starts_at < ?10 AND ends_at > ?11)`,
    ).bind(id, a.userId, a.sourceApp, a.sourceRef, a.start, a.end, a.title ?? null, a.status ?? "busy", Date.now(), a.end + buf, a.start - buf).run();
  }
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
  let blockRows: any[];
  try {
    blockRows = ((await metaDb(env).prepare(
      "SELECT b.source_app,b.title,b.starts_at,b.ends_at FROM calendar_blocks b WHERE b.user_id=?1 AND b.status='busy' AND b.starts_at < ?3 AND b.ends_at > ?2 AND NOT EXISTS (SELECT 1 FROM availability_reservations ar WHERE b.source_app='availability' AND ar.id=b.source_ref AND (ar.status IN ('cancelled','expired') OR (ar.status='held' AND ar.hold_expires_at IS NOT NULL AND ar.hold_expires_at<=?4)))",
    ).bind(creatorId, lo - 86_400_000, hi + 86_400_000, Date.now()).all()).results ?? []) as any[];
  } catch {
    blockRows = ((await metaDb(env).prepare(
      "SELECT source_app, title, starts_at, ends_at FROM calendar_blocks WHERE user_id=?1 AND status='busy' AND starts_at < ?3 AND ends_at > ?2",
    ).bind(creatorId, lo - 86_400_000, hi + 86_400_000).all()).results ?? []) as any[];
  }
  const blocks = blockRows as unknown as Conflict[];

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

// ---------------------------------------------------------------------------
// Unified listing-aware authority (2026-09-10). The legacy helpers above remain
// available to old Calendar routes; new checkout/publish routes should use the
// APIs below. All intervals are half-open [startAt, endAt) and epoch ms.
// ---------------------------------------------------------------------------

export type AvailabilityMode = "shared" | "custom" | "exclusive";
export type AvailabilityExceptionStatus = "available" | "unavailable" | "reserved";

export interface UnifiedConflict {
  title: string | null;
  source_app?: string;
  starts_at: number;
  ends_at: number;
  reservation_id?: string;
  listing_id?: string;
}

export interface ListingSlotValidation {
  ok: boolean;
  listingId: string;
  creatorId?: string;
  scheduleVersion?: number;
  reason?: "listing_not_found" | "listing_unpublished" | "bad_interval" | "duration" |
    "min_notice" | "outside_hours" | "exception" | "conflict" | "max_per_day";
  conflict?: UnifiedConflict;
}

export interface ListingClaimArgs {
  creatorId: string;
  listingId: string;
  startAt: number;
  endAt: number;
  kind: "exclusive" | "booking" | "hold" | "block";
  status: "held" | "reserved" | "confirmed";
  title?: string | null;
  sourceRef?: string | null;
  holdExpiresAt?: number | null;
  bufferMin?: number;
  /** A retry key is recorded by callers; reservation identity remains stable
   *  only when the caller supplies and reuses sourceRef/idempotency handling. */
  idempotencyKey?: string | null;
  excludeReservationId?: string | null;
  scheduleVersion?: number;
}

export type ListingClaimResult =
  | { ok: true; reservationId: string; scheduleVersion?: number }
  | { ok: false; reason: string; conflict?: UnifiedConflict; scheduleVersion?: number };

interface UnifiedSchedule {
  id: string | null;
  creator_id: string;
  listing_id: string | null;
  timezone: string;
  mode: AvailabilityMode;
  duration_min: number;
  slot_interval_min: number;
  buffer_min: number;
  min_notice_min: number;
  max_per_day: number;
  horizon_days: number;
  version: number;
  rules: Array<{ weekday: number; start_min: number; end_min: number }>;
  exceptions: Array<{ id: string; date: string; start_min: number; end_min: number; status: AvailabilityExceptionStatus; listing_id?: string | null }>;
}

function validIanaZone(tz: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(); return true; } catch { return false; }
}

function localParts(utcMs: number, tz: string): { date: string; minutes: number } {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(utcMs))) p[x.type] = x.value;
  const hour = p.hour === "24" ? 0 : Number(p.hour);
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: hour * 60 + Number(p.minute) };
}

function mergeWindows(base: Array<{ start_min: number; end_min: number }>, extras: Array<{ start_min: number; end_min: number }>): Array<{ start_min: number; end_min: number }> {
  return [...base, ...extras].filter((x) => x.end_min > x.start_min).sort((a, b) => a.start_min - b.start_min);
}

function intersectWindows(a: Array<{ start_min: number; end_min: number }>, b: Array<{ start_min: number; end_min: number }>): Array<{ start_min: number; end_min: number }> {
  const out: Array<{ start_min: number; end_min: number }> = [];
  for (const x of a) for (const y of b) {
    const start_min = Math.max(x.start_min, y.start_min), end_min = Math.min(x.end_min, y.end_min);
    if (end_min > start_min) out.push({ start_min, end_min });
  }
  return out.sort((x, y) => x.start_min - y.start_min);
}

async function loadUnifiedSchedule(env: Env, creatorId: string, listingId?: string | null): Promise<UnifiedSchedule> {
  const db = metaDb(env);
  let shared: any = null, listing: any = null;
  let unifiedTables = true;
  let legacyTz = "UTC", legacySlotMin = 60;
  const listingMeta = listingId ? await db.prepare('SELECT duration_min FROM listings WHERE id=?1').bind(listingId).first<{duration_min:number}>() : null;
  try {
    shared = await db.prepare("SELECT * FROM availability_schedules WHERE creator_id=?1 AND listing_id IS NULL").bind(creatorId).first<any>();
    if (listingId) listing = await db.prepare("SELECT * FROM availability_schedules WHERE creator_id=?1 AND listing_id=?2").bind(creatorId, listingId).first<any>();
  } catch { unifiedTables = false; }

  let rules: Array<{ weekday: number; start_min: number; end_min: number }> = [];
  const schedule = listing ?? shared;
  if (unifiedTables && schedule) {
    rules = ((await db.prepare("SELECT weekday,start_min,end_min FROM availability_schedule_rules WHERE schedule_id=?1 ORDER BY weekday,start_min").bind(schedule.id).all()).results ?? []) as any;
  } else if (!unifiedTables || !schedule) {
    const legacy = await db.prepare("SELECT weekday,start_min,end_min,tz,slot_min FROM availability_rules WHERE user_id=?1 ORDER BY weekday,start_min").bind(creatorId).all();
    rules = ((legacy.results ?? []) as any).map((r) => ({ weekday: Number(r.weekday), start_min: Number(r.start_min), end_min: Number(r.end_min) }));
    const first = (legacy.results ?? [])[0] as any;
    if (first?.tz) legacyTz = String(first.tz);
    if (first?.slot_min) legacySlotMin = Math.max(1, Number(first.slot_min));

  }
  let legacyPolicy: any = null;
  if (!unifiedTables || !schedule) {
    try { legacyPolicy = await db.prepare("SELECT buffer_min,min_notice_min,max_per_day FROM booking_policies WHERE user_id=?1").bind(creatorId).first<any>(); } catch { legacyPolicy = null; }
  }
  const tz = String(schedule?.timezone || legacyTz || "UTC");
  let exceptions: UnifiedSchedule["exceptions"] = [];
  if (unifiedTables) {
    const q = listingId
      ? "SELECT id,date,start_min,end_min,status,listing_id FROM availability_exceptions WHERE creator_id=?1 AND (schedule_id IN (SELECT id FROM availability_schedules WHERE creator_id=?1 AND listing_id IS NULL) OR listing_id=?2)"
      : "SELECT id,date,start_min,end_min,status,listing_id FROM availability_exceptions WHERE creator_id=?1 AND listing_id IS NULL";
    const rs = listingId ? await db.prepare(q).bind(creatorId, listingId).all() : await db.prepare(q).bind(creatorId).all();
    exceptions = (rs.results ?? []) as any;
  }
  return {
    id: schedule?.id ?? null, creator_id: creatorId, listing_id: listingId ?? null, timezone: validIanaZone(tz) ? tz : "UTC",
    mode: (schedule?.mode === "custom" || schedule?.mode === "exclusive" ? schedule.mode : "shared"),
    duration_min: Math.max(1, Number(listing?.duration_min ?? listingMeta?.duration_min ?? schedule?.duration_min ?? legacySlotMin)),
    slot_interval_min: Math.max(1, Number(schedule?.slot_interval_min ?? legacySlotMin)),
    buffer_min: Math.max(0, Number(schedule?.buffer_min ?? legacyPolicy?.buffer_min ?? 10)), min_notice_min: Math.max(0, Number(schedule?.min_notice_min ?? legacyPolicy?.min_notice_min ?? 120)),
    max_per_day: Math.max(1, Number(schedule?.max_per_day ?? legacyPolicy?.max_per_day ?? 8)), horizon_days: Math.min(366, Math.max(1, Number(schedule?.horizon_days ?? 60))), version: Number(schedule?.version ?? 0), rules, exceptions,
  };
}

function windowsForDate(schedule: UnifiedSchedule, date: string, listingSchedule?: UnifiedSchedule): Array<{ start_min: number; end_min: number }> {
  const wd = weekdayOf(date), listingId = listingSchedule?.listing_id;
  const globalEx = schedule.exceptions.filter(x=>x.date===date);
  const listingEx = (listingSchedule?.exceptions??[]).filter(x=>x.date===date && x.listing_id===listingId);
  let creator = mergeWindows(schedule.rules.filter(r=>r.weekday===wd),globalEx.filter(x=>x.status==='available'));
  const ownReserved = listingEx.filter(x=>x.status==='reserved' && x.listing_id===listingId);
  const custom = listingSchedule && listingSchedule.id!==schedule.id && listingSchedule.mode!=='shared';
  let base = custom
    ? intersectWindows(creator, mergeWindows(listingSchedule.rules.filter(r=>r.weekday===wd),listingEx.filter(x=>x.status==='available')))
    : mergeWindows(creator,listingEx.filter(x=>x.status==='available'));
  // A concrete reservation explicitly offers its window even outside normal hours.
  // Hard closures still win, and its canonical block hides it from other listings.
  base=mergeWindows(base,ownReserved);
  const hard=[...globalEx,...listingEx].filter(x=>x.status==='unavailable' || (x.status==='reserved' && x.listing_id!==listingId));
  for(const x of hard) base=base.flatMap(w=>{
    if(x.end_min<=w.start_min || x.start_min>=w.end_min) return [w];
    const out=[];
    if(w.start_min<x.start_min) out.push({start_min:w.start_min,end_min:x.start_min});
    if(w.end_min>x.end_min) out.push({start_min:x.end_min,end_min:w.end_min});
    return out;
  });
  return base;
}

async function listingOwner(env: Env, listingId: string): Promise<{ creator_id: string; status: string } | null> {
  return await metaDb(env).prepare("SELECT creator_id,status FROM listings WHERE id=?1").bind(listingId).first<{ creator_id: string; status: string }>();
}

async function unifiedConflicts(env: Env, creatorId: string, listingId: string, startAt: number, endAt: number, bufferMin: number, excludeReservationId?: string | null): Promise<UnifiedConflict[]> {
  const db = metaDb(env), lo = startAt - Math.max(0, bufferMin) * 60_000, hi = endAt + Math.max(0, bufferMin) * 60_000, now = Date.now();
  const out: UnifiedConflict[] = [];
  try {
    const rs = await db.prepare("SELECT id,listing_id,kind,title,starts_at,ends_at FROM availability_reservations WHERE creator_id=?1 AND status IN ('held','reserved','confirmed') AND (status!='held' OR hold_expires_at IS NULL OR hold_expires_at>?4) AND starts_at < ?3 AND ends_at > ?2 AND (?5 IS NULL OR id!=?5)").bind(creatorId, lo, hi, now, excludeReservationId ?? null).all();
    for (const r of (rs.results ?? []) as any[]) {
      // An exclusive reservation is only consumable by its own listing. Other
      // reservations are creator-wide commitments, including shared listings.
      if (r.kind === "exclusive" && r.listing_id === listingId) continue;
      out.push({ title: r.title ?? null, starts_at: Number(r.starts_at), ends_at: Number(r.ends_at), reservation_id: r.id, listing_id: r.listing_id });
    }
  } catch (error) { throw error; }
  try {
    const rs = await db.prepare("SELECT b.source_app,b.title,b.starts_at,b.ends_at FROM calendar_blocks b WHERE b.user_id=?1 AND b.status='busy' AND b.starts_at < ?3 AND b.ends_at > ?2 AND NOT EXISTS (SELECT 1 FROM availability_reservations ar WHERE b.source_app='availability' AND ar.id=b.source_ref AND ((ar.status IN ('cancelled','expired') OR (ar.status='held' AND ar.hold_expires_at IS NOT NULL AND ar.hold_expires_at<=?4)) OR (ar.kind='exclusive' AND ar.listing_id=?5) OR ar.id=?6))").bind(creatorId, lo, hi, now, listingId, excludeReservationId ?? null).all();
    for (const r of (rs.results ?? []) as any[]) out.push({ title: r.title ?? null, source_app: r.source_app, starts_at: Number(r.starts_at), ends_at: Number(r.ends_at) });
  } catch (error) { throw error; }
  try {
    const rs = await db.prepare("SELECT b.starts_at,b.ends_at,l.title FROM bookings b LEFT JOIN listings l ON l.id=b.listing_id WHERE b.creator_id=?1 AND b.status IN ('confirmed','scheduled','pending') AND b.starts_at < ?3 AND b.ends_at > ?2").bind(creatorId, lo, hi).all();
    for (const r of (rs.results ?? []) as any[]) out.push({ title: r.title ?? null, source_app: "booking", starts_at: Number(r.starts_at), ends_at: Number(r.ends_at) });
  } catch (error) { throw error; }
  return out.sort((a, b) => a.starts_at - b.starts_at);
}

/** Expire checkout holds and let the migration trigger cancel their block mirror. */
export async function expireAvailabilityReservations(env: Env, now = Date.now()): Promise<number> {
  const r = await metaDb(env).prepare("UPDATE availability_reservations SET status='expired',updated_at=?1 WHERE status='held' AND hold_expires_at IS NOT NULL AND hold_expires_at<=?1").bind(now).run();
  return Number(r.meta?.changes ?? 0);
}

async function capReached(env: Env, creatorId: string, schedule: UnifiedSchedule, startAt: number, excludeReservationId?: string): Promise<boolean> {
  const local = localParts(startAt, schedule.timezone), dayStart = zonedEpoch(local.date, 0, schedule.timezone), dayEnd = zonedEpoch(local.date, 1440, schedule.timezone), now = Date.now();
  const rows = await metaDb(env).prepare("SELECT starts_at,ends_at FROM availability_reservations WHERE creator_id=?1 AND kind IN ('booking','hold') AND status IN ('held','reserved','confirmed') AND (status!='held' OR hold_expires_at IS NULL OR hold_expires_at>?4) AND starts_at>=?2 AND starts_at<?3 AND (?5 IS NULL OR id!=?5) UNION SELECT starts_at,ends_at FROM bookings WHERE creator_id=?1 AND status IN ('confirmed','scheduled','pending') AND starts_at>=?2 AND starts_at<?3").bind(creatorId, dayStart, dayEnd, now, excludeReservationId ?? null).all();
  const seen = new Set<string>();
  for (const x of (rows.results ?? []) as any[]) seen.add(`${x.starts_at}:${x.ends_at}`);
  return seen.size >= schedule.max_per_day;
}

/** Validate listing membership, duration, local schedule, notice, cap and
 * current creator occupancy. Checkout must call this immediately before claim. */
export async function validateListingSlot(env: Env, listingId: string, startAt: number, endAt: number, opts: { durationMin?: number; now?: number; excludeReservationId?: string } = {}): Promise<ListingSlotValidation> {
  const listing = await listingOwner(env, listingId);
  if (!listing) return { ok: false, listingId, reason: "listing_not_found" };
  if (!["published", "live"].includes(listing.status)) return { ok: false, listingId, creatorId: listing.creator_id, reason: "listing_unpublished" };
  if (!(Number.isSafeInteger(startAt) && Number.isSafeInteger(endAt) && startAt > 0 && startAt % 60_000 === 0 && endAt > startAt)) return { ok: false, listingId, creatorId: listing.creator_id, reason: "bad_interval" };
  const schedule = await loadUnifiedSchedule(env, listing.creator_id, listingId);
  const shared = schedule.listing_id ? await loadUnifiedSchedule(env, listing.creator_id, null) : schedule;
  const expectedDuration = Math.max(1, Number(opts.durationMin ?? schedule.duration_min));
  if (endAt - startAt !== expectedDuration * 60_000) return { ok: false, listingId, creatorId: listing.creator_id, scheduleVersion: schedule.version, reason: "duration" };
  const now = opts.now ?? Date.now();
  if (startAt - now < schedule.min_notice_min * 60_000) return { ok: false, listingId, creatorId: listing.creator_id, scheduleVersion: schedule.version, reason: "min_notice" };
  const lp = localParts(startAt, schedule.timezone), endLp = localParts(endAt - 1, schedule.timezone);
  if (lp.date !== endLp.date) return { ok: false, listingId, creatorId: listing.creator_id, scheduleVersion: schedule.version, reason: "outside_hours" };
  const today = localParts(now, schedule.timezone).date;
  const horizonEnd = new Date(`${today}T00:00:00Z`);
  horizonEnd.setUTCDate(horizonEnd.getUTCDate() + schedule.horizon_days);
  if (lp.date < today || lp.date > horizonEnd.toISOString().slice(0, 10)) return { ok: false, listingId, creatorId: listing.creator_id, scheduleVersion: schedule.version, reason: "outside_hours" };
  const windows = windowsForDate(shared, lp.date, schedule.listing_id ? schedule : undefined);
  const requiredEndMin = lp.minutes + Math.ceil((endAt - startAt) / 60_000);
  const insideWindow = windows.find((w) => lp.minutes >= w.start_min && requiredEndMin <= w.end_min);
  const aligned = !!insideWindow && ((lp.minutes - insideWindow.start_min) % Math.max(1, schedule.slot_interval_min) === 0);
  const inside = !!insideWindow && aligned;
  if (!inside) return { ok: false, listingId, creatorId: listing.creator_id, scheduleVersion: schedule.version, reason: windows.length ? "outside_hours" : "outside_hours" };
  if (await capReached(env, listing.creator_id, schedule, startAt, opts.excludeReservationId)) return { ok: false, listingId, creatorId: listing.creator_id, scheduleVersion: schedule.version, reason: "max_per_day" };
  const conflicts = await unifiedConflicts(env, listing.creator_id, listingId, startAt, endAt, schedule.buffer_min, opts.excludeReservationId);
  if (conflicts.length) return { ok: false, listingId, creatorId: listing.creator_id, scheduleVersion: schedule.version, reason: "conflict", conflict: conflicts[0] };
  return { ok: true, listingId, creatorId: listing.creator_id, scheduleVersion: schedule.version };
}

/** Atomically admit a reservation after validation. The overlap predicate,
 * creator-local daily cap and hard calendar block are rechecked in the INSERT
 * itself, so concurrent claims cannot both win. */
export async function claimListingSlot(env: Env, a: ListingClaimArgs): Promise<ListingClaimResult> {
  // Stable source refs make retries idempotent and prevent a caller from
  // reusing an id for a different interval after cancellation.
  if (a.sourceRef) {
    const existing = await metaDb(env).prepare("SELECT id,listing_id,kind,status,hold_expires_at,starts_at,ends_at FROM availability_reservations WHERE creator_id=?1 AND source_ref=?2").bind(a.creatorId, a.sourceRef).first<any>();
    if (existing) {
      if (existing.listing_id === a.listingId && Number(existing.starts_at) === a.startAt && Number(existing.ends_at) === a.endAt && ["held", "reserved", "confirmed"].includes(String(existing.status)) && (existing.status !== "held" || Number(existing.hold_expires_at) > Date.now())) return { ok: true, reservationId: String(existing.id) };
      return { ok: false, reason: "source_ref_reused" };
    }
  }
  const sharedSnapshot = await loadUnifiedSchedule(env,a.creatorId,null);
  const valid = await validateListingSlot(env, a.listingId, a.startAt, a.endAt, { excludeReservationId: a.excludeReservationId ?? undefined });
  if (!valid.ok) return { ok: false, reason: valid.reason ?? "unavailable", conflict: valid.conflict, scheduleVersion: valid.scheduleVersion };
  if (valid.creatorId !== a.creatorId) return { ok: false, reason: "listing_membership", scheduleVersion: valid.scheduleVersion };
  const id = crypto.randomUUID(), now = Date.now(), schedule = await loadUnifiedSchedule(env, a.creatorId, a.listingId);
  if (schedule.version !== valid.scheduleVersion) return {ok:false,reason:'schedule_changed',scheduleVersion:schedule.version};
  if (a.scheduleVersion !== undefined && Number(a.scheduleVersion) !== schedule.version) return { ok: false, reason: "schedule_changed", scheduleVersion: schedule.version };
  const buf = Math.max(0, Number(a.bufferMin ?? schedule.buffer_min)) * 60_000;
  const local = localParts(a.startAt, schedule.timezone), dayStart = zonedEpoch(local.date, 0, schedule.timezone), dayEnd = zonedEpoch(local.date, 1440, schedule.timezone);
  try {
    // The INSERT is the single admission statement. The migration trigger
    // mirrors a successful reservation into calendar_blocks before the write
    // commits, so legacy claimBlock callers and this path share one authority.
    const r = await metaDb(env).prepare(`INSERT INTO availability_reservations (id,creator_id,listing_id,kind,status,starts_at,ends_at,title,source_ref,hold_expires_at,created_at,updated_at)
      SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?11
      WHERE NOT EXISTS (
        SELECT 1 FROM calendar_blocks b
        WHERE b.user_id=?2 AND b.status='busy' AND b.starts_at < ?7 + ?12 AND b.ends_at > ?6 - ?12
          AND NOT EXISTS (SELECT 1 FROM availability_reservations ex WHERE b.source_app='availability' AND ex.id=b.source_ref AND ex.kind='exclusive' AND ex.listing_id=?3)
          AND NOT EXISTS (SELECT 1 FROM availability_reservations own WHERE b.source_app='availability' AND own.id=b.source_ref AND own.id=?13)
          AND NOT EXISTS (SELECT 1 FROM availability_reservations dead WHERE b.source_app='availability' AND dead.id=b.source_ref AND (dead.status IN ('cancelled','expired') OR (dead.status='held' AND dead.hold_expires_at IS NOT NULL AND dead.hold_expires_at<=?11)))
      )
      AND NOT EXISTS (
        SELECT 1 FROM availability_reservations x
        WHERE x.creator_id=?2 AND x.status IN ('held','reserved','confirmed')
          AND (x.status!='held' OR x.hold_expires_at IS NULL OR x.hold_expires_at>?11)
          AND x.starts_at < ?7 + ?12 AND x.ends_at > ?6 - ?12
          AND (?13 IS NULL OR x.id!=?13)
          AND NOT (x.kind='exclusive' AND x.listing_id=?3)
      )
      AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.creator_id=?2 AND b.status IN ('confirmed','scheduled','pending') AND b.starts_at<?7+?12 AND b.ends_at>?6-?12)
      AND (SELECT COUNT(*) FROM (
        SELECT starts_at,ends_at FROM availability_reservations
          WHERE creator_id=?2 AND kind IN ('booking','hold') AND status IN ('held','reserved','confirmed')
            AND (status!='held' OR hold_expires_at IS NULL OR hold_expires_at>?11) AND starts_at>=?14 AND starts_at<?15 AND (?13 IS NULL OR id!=?13)
        UNION SELECT starts_at,ends_at FROM bookings
          WHERE creator_id=?2 AND status IN ('confirmed','scheduled','pending') AND starts_at>=?14 AND starts_at<?15
      )) < ?16
      AND COALESCE((SELECT version FROM availability_schedules WHERE creator_id=?2 AND listing_id=?3),(SELECT version FROM availability_schedules WHERE creator_id=?2 AND listing_id IS NULL),0)=?17 AND COALESCE((SELECT version FROM availability_schedules WHERE creator_id=?2 AND listing_id IS NULL),0)=?18`).bind(id, a.creatorId, a.listingId, a.kind, a.status, a.startAt, a.endAt, a.title ?? null, a.sourceRef ?? null, a.holdExpiresAt ?? null, now, buf, a.excludeReservationId ?? null, dayStart, dayEnd, schedule.max_per_day, schedule.version, sharedSnapshot.version).run();
    if (Number(r.meta?.changes ?? 0) > 0) return { ok: true, reservationId: id, scheduleVersion: valid.scheduleVersion };
  } catch (e) {
    // A deployment without the additive migration should fail closed for the
    // new claim path; legacy routes continue using claimBlock().
    return { ok: false, reason: "availability_unavailable" };
  }
  const conflict = (await unifiedConflicts(env, a.creatorId, a.listingId, a.startAt, a.endAt, buf / 60_000, a.excludeReservationId))[0];
  return { ok: false, reason: conflict ? "conflict" : "max_per_day", conflict, scheduleVersion: valid.scheduleVersion };
}

export interface ExclusiveReservationArgs {
  creatorId: string;
  listingId: string;
  startAt: number;
  endAt: number;
  title?: string | null;
  sourceRef?: string | null;
  bufferMin?: number;
}

/** Reserve a fixed/exclusive listing window during publication, including for
 * a draft listing. It intentionally skips weekly-hour validation: the creator
 * is explicitly allocating this concrete window, while hard creator blocks and
 * all competing reservations still reject it atomically. */
export async function claimExclusiveReservation(env: Env, a: ExclusiveReservationArgs): Promise<ListingClaimResult> {
  const owner = await listingOwner(env, a.listingId);
  if (!owner || owner.creator_id !== a.creatorId) return { ok: false, reason: "listing_membership" };
  if (!(Number.isFinite(a.startAt) && Number.isFinite(a.endAt) && a.endAt > a.startAt)) return { ok: false, reason: "bad_interval" };
  if (a.sourceRef) {
    const existing = await metaDb(env).prepare("SELECT id,listing_id,kind,status,hold_expires_at,starts_at,ends_at FROM availability_reservations WHERE creator_id=?1 AND source_ref=?2").bind(a.creatorId, a.sourceRef).first<any>();
    if (existing) {
      if (existing.listing_id === a.listingId && Number(existing.starts_at) === a.startAt && Number(existing.ends_at) === a.endAt && ["held", "reserved", "confirmed"].includes(String(existing.status)) && (existing.status !== "held" || Number(existing.hold_expires_at) > Date.now())) return { ok: true, reservationId: String(existing.id) };
      return { ok: false, reason: "source_ref_reused" };
    }
  }
  const id = crypto.randomUUID(), now = Date.now(), buf = Math.max(0, Number(a.bufferMin ?? (await loadUnifiedSchedule(env, a.creatorId, null)).buffer_min)) * 60_000;
  try {
    const r = await metaDb(env).prepare(`INSERT INTO availability_reservations (id,creator_id,listing_id,kind,status,starts_at,ends_at,title,source_ref,created_at,updated_at)
      SELECT ?1,?2,?3,'exclusive','reserved',?4,?5,?6,?7,?8,?8
      WHERE NOT EXISTS (SELECT 1 FROM calendar_blocks b WHERE b.user_id=?2 AND b.status='busy' AND b.starts_at < ?5 + ?9 AND b.ends_at > ?4 - ?9 AND NOT EXISTS (SELECT 1 FROM availability_reservations dead WHERE b.source_app='availability' AND dead.id=b.source_ref AND (dead.status IN ('cancelled','expired') OR (dead.status='held' AND dead.hold_expires_at IS NOT NULL AND dead.hold_expires_at<=?8))))
        AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.creator_id=?2 AND b.status IN ('confirmed','scheduled','pending') AND b.starts_at<?5+?9 AND b.ends_at>?4-?9)
        AND NOT EXISTS (SELECT 1 FROM availability_reservations x WHERE x.creator_id=?2 AND x.status IN ('held','reserved','confirmed') AND (x.status!='held' OR x.hold_expires_at IS NULL OR x.hold_expires_at>?8) AND x.starts_at < ?5 + ?9 AND x.ends_at > ?4 - ?9)`).bind(id, a.creatorId, a.listingId, a.startAt, a.endAt, a.title ?? null, a.sourceRef ?? null, now, buf).run();
    if (Number(r.meta?.changes ?? 0) > 0) return { ok: true, reservationId: id };
    const conflict = (await unifiedConflicts(env, a.creatorId, a.listingId, a.startAt, a.endAt, buf / 60_000))[0];
    return { ok: false, reason: "conflict", conflict };
  } catch { return { ok: false, reason: "availability_unavailable" }; }
}

/** Idempotent lifecycle release; the migration trigger cancels its canonical
 * calendar_blocks mirror in the same D1 write. */
export async function releaseListingReservation(env: Env, creatorId: string, reservationId: string, status: "cancelled" | "expired" = "cancelled"): Promise<boolean> {
  const r = await metaDb(env).prepare("UPDATE availability_reservations SET status=?1,updated_at=?2 WHERE id=?3 AND creator_id=?4 AND status IN ('held','reserved','confirmed')").bind(status, Date.now(), reservationId, creatorId).run();
  return Number(r.meta?.changes ?? 0) > 0;
}

/** Public-safe conflict lookup used by the creator preview route. */
export async function previewListingConflicts(env: Env, creatorId: string, listingId: string | null, startAt: number, endAt: number): Promise<UnifiedConflict[]> {
  const schedule = await loadUnifiedSchedule(env, creatorId, listingId);
  return unifiedConflicts(env, creatorId, listingId ?? "", startAt, endAt, schedule.buffer_min);
}

export { loadUnifiedSchedule, windowsForDate, localParts };
