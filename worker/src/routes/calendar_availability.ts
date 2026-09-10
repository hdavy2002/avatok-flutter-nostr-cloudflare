// [AVAILABILITY-1] Unified creator schedules and listing-aware availability.
// Route wiring intentionally lives in index.ts so legacy calendar routes remain
// independently deployable while clients migrate to this contract.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { metaDb } from "../db/shard";
import { track } from "../hooks";
import { zonedEpoch, validateListingSlot, previewListingConflicts, loadUnifiedSchedule, windowsForDate, localParts, loadFixedLiveCommitments } from "../cal/engine";

const APP = "avacalendar";
const MAX_RANGE_DAYS = 62;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type Rule = { weekday: number; start_min: number; end_min: number };
type Exception = { id?: string; date: string; start_min: number; end_min: number; status: "available" | "unavailable" | "reserved"; listing_id?: string };

function isZone(tz: string): boolean { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(); return true; } catch { return false; } }
function validDate(d: string): boolean { return DATE_RE.test(d) && Number.isFinite(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d; }
function dateRange(from: string, to: string): string[] {
  const out: string[] = [], d = new Date(`${from}T00:00:00Z`), end = new Date(`${to}T00:00:00Z`);
  while (d <= end && out.length <= MAX_RANGE_DAYS) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}
function intervalValid(start: number, end: number): boolean { return Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end <= 1440 && end > start; }
function scheduleShape(s: any, creatorId: string, listingId: string | null, rules: Rule[], exceptions: Exception[]): any {
  return {
    listing_id: listingId,
    timezone: s?.timezone ?? "UTC", mode: s?.mode === "custom" || s?.mode === "exclusive" ? s.mode : "shared",
    duration_min: Math.max(1, Number(s?.duration_min ?? 60)), slot_interval_min: Math.max(1, Number(s?.slot_interval_min ?? 60)),
    buffer_min: Math.max(0, Number(s?.buffer_min ?? 10)), min_notice_min: Math.max(0, Number(s?.min_notice_min ?? 120)),
    max_per_day: Math.max(1, Number(s?.max_per_day ?? 8)), horizon_days: Math.min(366, Math.max(1, Number(s?.horizon_days ?? 60))),
    version: Number(s?.version ?? 0), rules: rules.map((r) => ({ weekday: r.weekday, start_min: r.start_min, end_min: r.end_min })),
    exceptions: exceptions.map((x) => ({ id: x.id, date: x.date, start_min: x.start_min, end_min: x.end_min, status: x.status, ...(x.listing_id ? { listing_id: x.listing_id } : {}) })),
  };
}

async function ownerForSchedule(env: Env, uid: string, listingId: string | null): Promise<{ creatorId: string; listingStatus?: string } | { error: string; status: number }> {
  if (!listingId) return { creatorId: uid };
  const row = await metaDb(env).prepare("SELECT creator_id,status FROM listings WHERE id=?1").bind(listingId).first<{ creator_id: string; status: string }>();
  if (!row) return { error: "listing not found", status: 404 };
  if (row.creator_id !== uid) return { error: "listing ownership required", status: 403 };
  return { creatorId: uid, listingStatus: row.status };
}

async function readSchedule(env: Env, creatorId: string, listingId: string | null): Promise<any> {
  const s = await loadUnifiedSchedule(env, creatorId, listingId);
  // loadUnifiedSchedule supplies legacy weekly rules when the additive schedule
  // row is absent. Its exception list is already creator/listing scoped.
  const own = await metaDb(env).prepare("SELECT id,version FROM availability_schedules WHERE creator_id=?1 AND listing_id IS ?2").bind(creatorId, listingId).first<{id:string;version:number}>();
  const exceptions = own ? ((await metaDb(env).prepare("SELECT id,date,start_min,end_min,status,listing_id FROM availability_exceptions WHERE schedule_id=?1").bind(own.id).all()).results ?? []) as Exception[] : [];
  return scheduleShape({...s, version: own?.version ?? 0}, creatorId, listingId, s.rules, exceptions);
}

/** GET/PUT /api/calendar/schedule?listing_id=... */
export async function getSchedule(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env); if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const listingId = new URL(req.url).searchParams.get("listing_id");
  const own = await ownerForSchedule(env, ctx.uid, listingId); if ("error" in own) return json({ error: own.error }, own.status);
  try { return json({ schedule: await readSchedule(env, own.creatorId, listingId) }); }
  catch { return json({ error: "schedule unavailable" }, 503); }
}

export async function putSchedule(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env); if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const url = new URL(req.url), queryListing = url.searchParams.get("listing_id");
  const body = await req.json().catch(() => ({})) as any, input = body?.schedule;
  if (!input || typeof input !== "object") return json({ error: "schedule required" }, 400);
  if (queryListing !== null && input.listing_id !== undefined && input.listing_id !== queryListing) return json({ error: "listing_id mismatch" }, 400);
  const listingId = input.listing_id ?? queryListing ?? null;
  if (listingId !== null && typeof listingId !== "string") return json({ error: "listing_id invalid" }, 400);
  const own = await ownerForSchedule(env, ctx.uid, listingId); if ("error" in own) return json({ error: own.error }, own.status);
  const timezone = String(input.timezone ?? "");
  const version = Number(input.version);
  if (!isZone(timezone) || !Number.isInteger(version) || version < 0) return json({ error: "timezone and non-negative version required" }, 400);
  const modes = new Set(["shared", "custom", "exclusive"]); if (!modes.has(input.mode)) return json({ error: "invalid mode" }, 400);
  const rules = Array.isArray(input.rules) ? input.rules : null, exceptions = Array.isArray(input.exceptions) ? input.exceptions : null;
  if (!rules || !exceptions || rules.length > 50 || exceptions.length > 100) return json({ error: "rules/exceptions invalid or too large" }, 400);
  const parsedRules: Rule[] = [];
  for (const r of rules) {
    const x = { weekday: Number(r.weekday), start_min: Number(r.start_min), end_min: Number(r.end_min) };
    if (!Number.isInteger(x.weekday) || x.weekday < 0 || x.weekday > 6 || !intervalValid(x.start_min, x.end_min)) return json({ error: "invalid rule" }, 400);
    parsedRules.push(x);
  }
  const parsedExceptions: Exception[] = [];
  for (const x of exceptions) {
    const e = { id: typeof x.id === "string" ? x.id : undefined, date: String(x.date), start_min: Number(x.start_min), end_min: Number(x.end_min), status: x.status, listing_id: x.listing_id } as Exception;
    if (!validDate(e.date) || !intervalValid(e.start_min, e.end_min) || !["available", "unavailable", "reserved"].includes(e.status)) return json({ error: "invalid exception" }, 400);
    if (e.status === 'reserved' && !e.listing_id && !listingId) return json({error:'Choose a listing for reserved time'},400);
    if (listingId && e.listing_id && e.listing_id !== listingId) return json({ error: "exception listing mismatch" }, 400);
    if (e.listing_id && e.listing_id !== listingId) {
      const owned = await ownerForSchedule(env, ctx.uid, e.listing_id);
      if ('error' in owned) return json({error:'exception listing ownership required'},403);
    }
    parsedExceptions.push(e);
  }
  const numeric = (key: string, fallback: number, min: number, max: number): number | null => {
    const n = input[key] === undefined ? fallback : Number(input[key]);
    return Number.isInteger(n) && n >= min && n <= max ? n : null;
  };
  const duration = numeric('duration_min',60,5,480), interval = numeric('slot_interval_min',60,5,240),
    buffer = numeric('buffer_min',10,0,240), notice = numeric('min_notice_min',120,0,43200),
    cap = numeric('max_per_day',8,1,100), horizon = numeric('horizon_days',60,1,62);
  if ([duration,interval,buffer,notice,cap,horizon].includes(null)) return json({error:'Invalid duration, interval, buffer, notice, daily limit or horizon'},400);
  const db = metaDb(env), now = Date.now(), nextVersion = version + 1, token = crypto.randomUUID();
  const existing = await db.prepare("SELECT id,version FROM availability_schedules WHERE creator_id=?1 AND listing_id IS ?2").bind(own.creatorId, listingId).first<{ id: string; version: number }>();
  if ((existing?.version ?? 0) !== version) return json({error:'schedule version conflict',schedule:await readSchedule(env,own.creatorId,listingId)},409);
  const otherZones = await db.prepare("SELECT timezone FROM availability_schedules WHERE creator_id=?1 AND id!=?2 LIMIT 101").bind(own.creatorId,existing?.id??'').all<{timezone:string}>();
  if ((otherZones.results??[]).some(s=>s.timezone!==timezone)) return json({error:'All listing schedules use the creator calendar timezone. Keep the existing timezone while other schedules exist.'},400);
  const id = existing?.id ?? crypto.randomUUID();
  // Reuse only IDs read from this schedule. Unchanged reserved windows remain
  // intact when their appointments are already booked and other rules change.
  const previous = existing ? ((await db.prepare("SELECT e.*,r.status AS reservation_status,r.starts_at,r.ends_at FROM availability_exceptions e LEFT JOIN availability_reservations r ON r.id=e.reservation_id WHERE e.schedule_id=?1").bind(id).all()).results??[]) as any[] : [];
  const keys=new Set<string>();
  for(const e of parsedExceptions){const key=`${e.date}:${e.start_min}:${e.end_min}`;if(keys.has(key))return json({error:'Duplicate date interval'},400);keys.add(key);}
  const normalized = parsedExceptions.map(e => {
    const prior=previous.find(p=>p.date===e.date && p.start_min===e.start_min && p.end_min===e.end_min && p.status===e.status && (p.listing_id??null)===(e.listing_id??listingId));
    return {...e,id:prior?.id??crypto.randomUUID(),prior};
  });
  const reservations = normalized.filter(e => e.status === 'reserved' || (e.status === 'unavailable' && listingId === null)).map(e => ({
    exception:e, id:crypto.randomUUID(), retained:false, start:zonedEpoch(e.date,e.start_min,timezone), end:zonedEpoch(e.date,e.end_min,timezone),
    listing:e.listing_id ?? listingId ?? '', kind:e.status === 'reserved' ? 'exclusive' : 'block',
  }));
  for (let i=0;i<reservations.length;i++) {
    const a=reservations[i];
    const wall=localParts(a.start,timezone);
    if (wall.date!==a.exception.date || wall.minutes!==a.exception.start_min) return json({error:'This local time does not exist because of a daylight-saving clock change'},400);
    if (!(a.end>a.start)) return json({error:'Invalid date interval'},400);
    if (reservations.slice(i+1).some(b=>a.start<b.end && b.start<a.end)) return json({error:'Date reservations overlap each other'},409);
  }
  for(const r of reservations){const p=r.exception.prior;if(p?.reservation_id && ['reserved','confirmed'].includes(p.reservation_status) && p.starts_at===r.start && p.ends_at===r.end){r.id=p.reservation_id;r.retained=true;}}
  const intervals = JSON.stringify(reservations.filter(r=>!r.retained).map(r=>({start:r.start,end:r.end})));
  const retainedIds=JSON.stringify(reservations.filter(r=>r.retained).map(r=>r.id));
  // The admission and every child mutation use one unguessable write token.
  // A competing save that loses the version comparison changes no child rows.
  const noConflict = `NOT EXISTS (
    SELECT 1 FROM json_each(?15) n JOIN calendar_blocks b ON b.user_id=?2 AND b.status='busy'
    WHERE b.starts_at < json_extract(n.value,'$.end') + ?8*60000 AND b.ends_at > json_extract(n.value,'$.start') - ?8*60000
      AND NOT EXISTS (SELECT 1 FROM availability_reservations r WHERE b.source_app='availability' AND r.id=b.source_ref AND
        (r.source_ref LIKE ?16 OR r.status IN ('cancelled','expired') OR (r.status='held' AND r.hold_expires_at<=?13)))
  ) AND NOT EXISTS (
    SELECT 1 FROM json_each(?15) n JOIN bookings b ON b.creator_id=?2 AND b.status IN ('confirmed','scheduled','pending')
    WHERE b.starts_at < json_extract(n.value,'$.end') + ?8*60000 AND b.ends_at > json_extract(n.value,'$.start') - ?8*60000
  ) AND NOT EXISTS(
    SELECT 1 FROM json_each(?15) n JOIN listings l ON l.creator_id=?2 AND l.kind='live_event' AND l.status IN ('published','live')
    LEFT JOIN listing_slots s ON s.listing_id=l.id AND s.status IN ('open','full')
    WHERE COALESCE(s.starts_at,l.starts_at)<json_extract(n.value,'$.end')+?8*60000 AND COALESCE(s.ends_at,l.starts_at+COALESCE(l.duration_min,60)*60000)>json_extract(n.value,'$.start')-?8*60000
  )`;
  const values = [id,own.creatorId,listingId,timezone,input.mode,duration,interval,buffer,notice,cap,horizon,nextVersion,now,token,intervals,`schedule:${id}:%`,version];
  const upsert = existing
    ? db.prepare(`UPDATE availability_schedules SET timezone=?4,mode=?5,duration_min=?6,slot_interval_min=?7,buffer_min=?8,min_notice_min=?9,max_per_day=?10,horizon_days=?11,version=?12,updated_at=?13,write_token=?14 WHERE id=?1 AND creator_id=?2 AND listing_id IS ?3 AND version=?17 AND ${noConflict}`).bind(...values)
    : db.prepare(`INSERT INTO availability_schedules(id,creator_id,listing_id,timezone,mode,duration_min,slot_interval_min,buffer_min,min_notice_min,max_per_day,horizon_days,version,updated_at,write_token)
      SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14 WHERE ?17=0 AND NOT EXISTS(SELECT 1 FROM availability_schedules WHERE creator_id=?2 AND listing_id IS ?3) AND ${noConflict}`).bind(...values);
  const stmts: D1PreparedStatement[] = [upsert,
    db.prepare("UPDATE availability_reservations SET status='cancelled',updated_at=?3 WHERE creator_id=?4 AND source_ref LIKE ?5 AND kind IN ('exclusive','block') AND id NOT IN (SELECT value FROM json_each(?6)) AND EXISTS(SELECT 1 FROM availability_schedules WHERE id=?1 AND write_token=?2)").bind(id,token,now,own.creatorId,`schedule:${id}:%`,retainedIds),
    db.prepare("DELETE FROM availability_schedule_rules WHERE schedule_id=?1 AND EXISTS(SELECT 1 FROM availability_schedules WHERE id=?1 AND write_token=?2)").bind(id,token),
    db.prepare("DELETE FROM availability_exceptions WHERE schedule_id=?1 AND EXISTS(SELECT 1 FROM availability_schedules WHERE id=?1 AND write_token=?2)").bind(id,token),
  ];
  for (const r of parsedRules) stmts.push(db.prepare("INSERT INTO availability_schedule_rules(id,schedule_id,weekday,start_min,end_min) SELECT ?1,?2,?3,?4,?5 WHERE EXISTS(SELECT 1 FROM availability_schedules WHERE id=?2 AND write_token=?6)").bind(crypto.randomUUID(),id,r.weekday,r.start_min,r.end_min,token));
  for (const e of normalized) {
    const r=reservations.find(r=>r.exception.id===e.id);
    stmts.push(db.prepare("INSERT INTO availability_exceptions(id,creator_id,schedule_id,listing_id,date,start_min,end_min,status,reservation_id,created_at) SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10 WHERE EXISTS(SELECT 1 FROM availability_schedules WHERE id=?3 AND write_token=?11)").bind(e.id,own.creatorId,id,e.listing_id??listingId,e.date,e.start_min,e.end_min,e.status,r?.id??null,now,token));
    if (r && !r.retained) stmts.push(db.prepare("INSERT INTO availability_reservations(id,creator_id,listing_id,kind,status,starts_at,ends_at,title,source_ref,created_at,updated_at) SELECT ?1,?2,?3,?4,'reserved',?5,?6,?7,?8,?9,?9 WHERE EXISTS(SELECT 1 FROM availability_schedules WHERE id=?10 AND write_token=?11)").bind(r.id,own.creatorId,r.listing,r.kind,r.start,r.end,r.kind==='block'?'Unavailable':'Reserved for listing',`schedule:${id}:${e.id}`,now,id,token));
  }
  try {
    const results = await db.batch(stmts);
    if (Number(results[0]?.meta?.changes ?? 0) !== 1) return json({error:'schedule conflict',message:'The schedule changed or these times overlap an existing commitment. Refresh and choose another time.'},409);
    await track(env,ctx.uid,'availability_schedule_saved',APP,{outcome:'saved',listing_id:listingId,schedule_version:nextVersion});
    return json({schedule:await readSchedule(env,own.creatorId,listingId)});
  } catch { return json({error:'schedule save unavailable'},503); }
}

function dateDiff(from: string, to: string): number { return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000); }

/** GET /api/listings/:id/availability?from=&to=&timezone= */
export async function listingAvailability(req: Request, env: Env, listingId: string): Promise<Response> {
  const listing = await metaDb(env).prepare("SELECT id,creator_id,status,kind FROM listings WHERE id=?1").bind(listingId).first<{ id: string; creator_id: string; status: string; kind: string }>();
  if (!listing || !["published", "live"].includes(listing.status)) return json({ error: "listing not found" }, 404);
  if (listing.kind && !["consult", "consultation"].includes(listing.kind)) return json({ error: "availability not offered" }, 404);
  const u = new URL(req.url), from = u.searchParams.get("from") ?? "", to = u.searchParams.get("to") ?? "", timezone = u.searchParams.get("timezone") || "UTC";
  if (!validDate(from) || !validDate(to) || dateDiff(from, to) < 0 || dateDiff(from, to) >= MAX_RANGE_DAYS || !isZone(timezone)) return json({ error: "from/to/timezone invalid" }, 400);
  const viewerDates = dateRange(from, to), schedule = await loadUnifiedSchedule(env, listing.creator_id, listingId), shared = await loadUnifiedSchedule(env, listing.creator_id, null), now = Date.now();
  const viewerLo = zonedEpoch(from, 0, timezone), viewerHi = zonedEpoch(to, 1440, timezone);
  const rangeLo = viewerLo - 86_400_000, rangeHi = viewerHi + 86_400_000;
  const dates = dateRange(localParts(viewerLo, schedule.timezone).date, localParts(viewerHi - 1, schedule.timezone).date);
  const liveBlocks = await loadFixedLiveCommitments(env,listing.creator_id,rangeLo,rangeHi,listingId);
  const blocks = ((await metaDb(env).prepare("SELECT source_app,source_ref,starts_at,ends_at FROM calendar_blocks WHERE user_id=?1 AND status='busy' AND starts_at<?3 AND ends_at>?2").bind(listing.creator_id, rangeLo, rangeHi).all()).results ?? []) as any[];
  const reservations = ((await metaDb(env).prepare("SELECT id,listing_id,kind,status,starts_at,ends_at,hold_expires_at FROM availability_reservations WHERE creator_id=?1 AND starts_at<?3 AND ends_at>?2 AND status IN ('held','reserved','confirmed')").bind(listing.creator_id, rangeLo, rangeHi).all()).results ?? []) as any[];
  const bookings = ((await metaDb(env).prepare("SELECT id,starts_at,ends_at,status FROM bookings WHERE creator_id=?1 AND starts_at<?3 AND ends_at>?2 AND status IN ('confirmed','scheduled','pending')").bind(listing.creator_id, rangeLo, rangeHi).all()).results ?? []) as any[];
  const activeReservationIds = new Set(reservations.filter((x) => !(x.status === "held" && x.hold_expires_at && Number(x.hold_expires_at) <= now)).map((x) => String(x.id)));
  const ownExclusiveIds = new Set(reservations.filter((x) => x.kind === "exclusive" && x.listing_id === listingId).map((x) => String(x.id)));
  const effectiveBlocks = blocks.filter((x) => (x.source_app !== "availability" || activeReservationIds.has(String(x.source_ref))) && !(x.source_app === "availability" && ownExclusiveIds.has(String(x.source_ref))));
  const conflictingReservations = reservations.filter((x) => !(x.status === "held" && x.hold_expires_at && Number(x.hold_expires_at) <= now));
  const slots: any[] = [], emitted = new Set<string>();
  for (const date of dates) {
    const ws = windowsForDate(shared, date, schedule.listing_id ? schedule : undefined), daySlots: any[] = [];
    const dayStart = zonedEpoch(date, 0, schedule.timezone), dayEnd = zonedEpoch(date, 1440, schedule.timezone);
    const dayCommitments = new Set<string>();
    for (const x of conflictingReservations) if (Number(x.starts_at) >= dayStart && Number(x.starts_at) < dayEnd && x.kind !== "exclusive") dayCommitments.add(`${x.starts_at}:${x.ends_at}`);
    for (const x of bookings) if (Number(x.starts_at) >= dayStart && Number(x.starts_at) < dayEnd) dayCommitments.add(`${x.starts_at}:${x.ends_at}`);
    const dayFull = dayCommitments.size >= schedule.max_per_day;
    for (const w of ws) for (let m = w.start_min; m + schedule.duration_min <= w.end_min; m += schedule.slot_interval_min) {
      const startAt = zonedEpoch(date, m, schedule.timezone), endAt = startAt + schedule.duration_min * 60_000;
      if (startAt < viewerLo || startAt >= viewerHi || startAt < now + schedule.min_notice_min * 60_000) continue;
      // DST gaps are never silently shifted into another wall-clock slot.
      const actual = localParts(startAt, schedule.timezone);
      if (actual.date !== date || actual.minutes !== m) continue;
      const today = localParts(now, schedule.timezone).date;
      if (date < today || dateDiff(today, date) > schedule.horizon_days || endAt > dayEnd) continue;
      const id = `availability:${listingId}:${startAt}:${endAt}`; if (emitted.has(id)) continue; emitted.add(id);
      const hit = dayFull || [...liveBlocks, ...effectiveBlocks, ...conflictingReservations, ...bookings].find((x) => Number(x.starts_at) < endAt + schedule.buffer_min * 60_000 && Number(x.ends_at) > startAt - schedule.buffer_min * 60_000 && !(x.kind === "exclusive" && x.listing_id === listingId));
      const item = { id, start_at: startAt, end_at: endAt, available: !hit, ...(hit ? { reason: dayFull ? "max_per_day" : "unavailable" } : {}) };
      daySlots.push(item); slots.push(item);
    }

  }
  slots.sort((a,b)=>a.start_at-b.start_at);
  const days = viewerDates.map(date=>({date,available_count:slots.filter(s=>s.available && localParts(s.start_at,timezone).date===date).length}));
  return json({ timezone, version: schedule.version, generated_at: Date.now(), days, slots });
}

/** POST /api/calendar/conflicts/preview — authenticated creator preview. */
export async function previewConflicts(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env); if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = await req.json().catch(() => ({})) as any, listingId = b.listing_id ? String(b.listing_id) : null, startAt = Number(b.start_at), endAt = Number(b.end_at);
  if (!Number.isSafeInteger(startAt) || !Number.isSafeInteger(endAt) || startAt <= 0 || endAt <= startAt || endAt - startAt > 7 * 86_400_000) return json({ error: "start_at/end_at invalid" }, 400);
  if (listingId) { const own = await ownerForSchedule(env, ctx.uid, listingId); if ("error" in own) return json({ error: own.error }, own.status); }
  const conflicts = await previewListingConflicts(env, ctx.uid, listingId, startAt, endAt), alternatives: any[] = [];
  if (conflicts.length) {
    const schedule = await loadUnifiedSchedule(env, ctx.uid, listingId), step = schedule.slot_interval_min * 60_000;
    for (let i = 1; i <= 12 && alternatives.length < 3; i++) {
      const s = endAt + i * step, e = s + (endAt - startAt), check = listingId ? await validateListingSlot(env, listingId, s, e) : null;
      if (check?.ok) alternatives.push({ start_at: s, end_at: e });
    }
  }
  for (const c of conflicts) await track(env, ctx.uid, "availability_conflict_prevented", APP, { outcome: "refused", reason: "conflict", listing_id: listingId });
  return json({ ok: conflicts.length === 0, conflicts: conflicts.map((x) => ({ title: x.title, start_at: x.starts_at, end_at: x.ends_at })), alternatives });
}

// Stable names for index.ts and external route tests.
export const getAvailabilitySchedule = getSchedule;
export const putAvailabilitySchedule = putSchedule;
export const getListingAvailability = listingAvailability;
export const previewAvailabilityConflicts = previewConflicts;
