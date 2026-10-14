import type { Env } from "../types";
import { isFail, requireUser } from "../authz";
import { json } from "../util";
import { track } from "../hooks";
import { readConfig } from "./config";
import { rateLimit } from "../money";
import { isClosing } from "../lib/hf_exit";
import { verifiedWhatsAppNumber } from "../lib/whatsapp_notify";
import { hasLaneAccess, isBlockedEitherWay, claimHost, releaseHost, callsConfigured } from "../lib/hf_calls_store";
import { readHfTokenConfig, readHfStdPlan } from "../lib/hf_token_config";
import { creatorCallSplit, creatorSnapshotFor, isCreatorCategory, validCreatorRate } from "../lib/hf_creator_pricing";
import { priceOf, snapshotFor, stdSnapshotFor, splitHostByKind } from "../lib/hf_token_calls";
import { callSplit, chargePaise, stdSplit, formatRupees, planSpend, type Price } from "../lib/hf_token_math";
import { availableLots, getLots, getReservation, hasOpenDebt, buildReservationStatements, buildReleaseStatements, resOpId, relOpId } from "../lib/hf_token_ledger";
import { conflictsWithBusy } from "../lib/hf_booking_availability";
import {
  isBookingDateRangeWithinHorizon,
  isCalendarDate,
  localDateAndMinute,
  offsetLabel,
  slotsForDate,
  slotsForRange,
  validateHfBookingSchedule,
  type HfBookingSchedule,
} from "../lib/hf_booking_availability";
import {
  acquireHfScheduleWriteLock,
  getHfBookingSchedule,
  listHfBusyIntervals,
  releaseHfScheduleWriteLock,
  saveHfBookingSchedule,
} from "../lib/hf_booking_store";

const err = (status: number, error: string, extra: Record<string, unknown> = {}) =>
  json({ error, ...extra }, status);

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  const text = await req.text().catch(() => "");
  if (!text || text.length > 20_000) return null;
  try {
    const body: unknown = JSON.parse(text);
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function localLabel(utcMs: number, timezone: string): string {
  return new Intl.DateTimeFormat("en", {
    timeZone: timezone, weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  }).format(new Date(utcMs));
}

function utcRangeForDates(from: string, to: string): { from: number; to: number } {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  return {
    from: Date.UTC(fy, fm - 1, fd) - 2 * 86_400_000,
    to: Date.UTC(ty, tm - 1, td + 1) + 2 * 86_400_000,
  };
}

async function scheduleRoute(req: Request, env: Env): Promise<Response> {
  const auth = await requireUser(req, env);
  if (isFail(auth)) return err(auth.status, auth.error);
  const host = await env.DB_META.prepare("SELECT uid,hours_json FROM hf_hosts WHERE uid=?1")
    .bind(auth.uid).first<{ uid: string; hours_json: string | null }>();
  if (!host) return err(404, "host_not_found");
  if (req.method === "GET") {
    const schedule = await getHfBookingSchedule(env, auth.uid);
    let legacyHours: unknown = null;
    try { legacyHours = host.hours_json ? JSON.parse(host.hours_json) : null; } catch { legacyHours = null; }
    const legacyPreview = schedule.version === 0 && legacyHours && typeof legacyHours === "object"
      ? { requiresHostTimezoneConfirmation: true, hours: legacyHours }
      : null;
    return json({ schedule, legacyPreview }, 200, { "cache-control": "private, no-store" });
  }

  const body = await readJson(req);
  if (!body || !Number.isInteger(body.expectedVersion) || !body.schedule ||
      typeof body.schedule !== "object" || Array.isArray(body.schedule)) {
    return err(400, "invalid_schedule", { fields: ["expectedVersion", "schedule"] });
  }
  const expectedVersion = Number(body.expectedVersion);
  const submitted = body.schedule as HfBookingSchedule;
  let legacyHasHours = false;
  if (expectedVersion === 0) {
    try {
      const legacy = host.hours_json ? JSON.parse(host.hours_json) as { days?: unknown; from?: unknown; to?: unknown } : null;
      legacyHasHours = !!legacy && Array.isArray(legacy.days) && legacy.days.length > 0 && typeof legacy.from === "string" && typeof legacy.to === "string";
    } catch { legacyHasHours = false; }
    if (legacyHasHours && body.confirmLegacyPreview !== true) return err(409, "legacy_preview_confirmation_required");
  }
  const errors = validateHfBookingSchedule({ ...submitted, version: expectedVersion });
  if (errors.length) return err(400, "invalid_schedule", { errors });

  const now = Date.now();
  const lockToken = await acquireHfScheduleWriteLock(env, auth.uid, expectedVersion, now);
  if (!lockToken) return err(409, "schedule_changed", { message: "Reload availability and apply your changes again." });
  try {
    const affected: string[] = [];
    let cursorStart = Number.MIN_SAFE_INTEGER;
    let cursorId = "";
    for (;;) {
      const page = await env.DB_META.prepare(`
        SELECT id,starts_at,ends_at,duration_min FROM hf_bookings
        WHERE host_uid=?1 AND status IN ('confirming','confirmed','starting','active','settling')
          AND ends_at>?2 AND (starts_at>?3 OR (starts_at=?3 AND id>?4))
        ORDER BY starts_at,id LIMIT 200
      `).bind(auth.uid, now, cursorStart, cursorId)
        .all<{ id: string; starts_at: number; ends_at: number; duration_min: number }>();
      const rows = page.results ?? [];
      for (const booking of rows) {
        const startAt = Number(booking.starts_at);
        const date = localDateAndMinute(startAt, submitted.timezone).date;
        const duration = Number(booking.duration_min);
        const safeSchedule = {
          ...submitted,
          version: expectedVersion,
          minNoticeMinutes: 0,
        };
        const slots = slotsForDate(safeSchedule, date, duration, [], now);
        if (!slots.some((slot) => slot.startAt === startAt && slot.endAt === Number(booking.ends_at))) {
          affected.push(booking.id);
        }
      }
      if (rows.length < 200) break;
      const last = rows[rows.length - 1];
      cursorStart = Number(last.starts_at);
      cursorId = last.id;
    }
    if (affected.length) {
      return err(409, "schedule_conflicts_with_bookings", { affectedBookingIds: affected });
    }

    const version = await saveHfBookingSchedule(env, auth.uid, expectedVersion, lockToken, submitted);
    if (version === null) return err(409, "schedule_changed", { message: "Reload availability and apply your changes again." });
    return json({ schedule: { ...submitted, version } }, 200, { "cache-control": "private, no-store" });
  } finally {
    await releaseHfScheduleWriteLock(env, auth.uid, lockToken).catch(() => undefined);
  }
}

async function publicAvailability(req: Request, env: Env, slug: string): Promise<Response> {
  const url = new URL(req.url);
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? from;
  const durationMinutes = Number(url.searchParams.get("durationMinutes"));
  const host = await env.DB_META.prepare(
    "SELECT uid,status FROM hf_hosts WHERE slug=?1",
  ).bind(slug).first<{ uid: string; status: string }>();
  if (!host || host.status !== "live") return err(404, "host_not_found");

  const schedule = await getHfBookingSchedule(env, host.uid);
  const errors = validateHfBookingSchedule(schedule);
  if (errors.length) return err(503, "availability_unavailable");
  if (!isCalendarDate(from) || !isCalendarDate(to) || to < from) return err(400, "invalid_date_range");
  if (!Number.isInteger(durationMinutes) || !schedule.durationsMinutes.includes(durationMinutes)) return err(400, "invalid_duration");
  if (!isBookingDateRangeWithinHorizon(schedule, from, to)) return err(400, "date_range_out_of_bounds");
  // An unconfigured schedule has no public slots; legacy hours_json is not a
  // public booking preview and requires a separate owner-confirmed import.
  if (schedule.version === 0) return json({ slots: [] }, 200, { "cache-control": "public, max-age=30" });
  const range = utcRangeForDates(from, to);
  const busy = await listHfBusyIntervals(env, host.uid, range.from, range.to);
  const slots = slotsForRange(schedule, from, to, durationMinutes, busy).map((slot) => ({
    startUtc: new Date(slot.startAt).toISOString(),
    endUtc: new Date(slot.endAt).toISOString(),
    hostLocalLabel: localLabel(slot.startAt, schedule.timezone),
    offsetLabel: offsetLabel(slot.offsetMinutes),
  }));
  return json({ slots }, 200, { "cache-control": "public, max-age=30" });
}

type BookingStatus = "confirming" | "confirmed" | "starting" | "active" | "settling" | "completed" | "cancelled" | "failed";
type BookingRow = {
  id: string; host_uid: string; customer_uid: string; starts_at: number; ends_at: number; host_timezone: string;
  schedule_version: number; quote_id: string; idempotency_key: string; status: BookingStatus; duration_min: number;
  reserved_paise: number; expected_host_net_paise: number; expected_host_paid_net_paise: number; expected_host_test_net_paise: number;
  price_snapshot_json: string; policy_snapshot_json: string; reservation_snapshot_json: string; call_id: string | null;
};
type BookingQuoteRow = {
  id: string; customer_uid: string; host_uid: string; starts_at: number; ends_at: number; duration_min: number;
  schedule_version: number; expires_at: number; status: string; reserved_paise: number;
  price_snapshot_json: string; policy_snapshot_json: string;
};
type HfHostPricingRow = {
  uid: string; slug: string; status: string; price_per_min: number; category: string;
  women_lane: number; lgbtq_lane: number;
};
const BOOKING_ACTIVE = "('confirming','confirmed','starting','active','settling')";
const BOOKING_APP = "hf_booking";
const QUOTE_TTL_MS = 5 * 60_000;

function bookingPublic(row: BookingRow, role: "host" | "customer") {
  const common = {
    id: row.id, status: row.status, hostUid: row.host_uid, customerUid: row.customer_uid,
    startUtc: new Date(Number(row.starts_at)).toISOString(), endUtc: new Date(Number(row.ends_at)).toISOString(),
    hostTimezone: row.host_timezone, reservedPaise: Number(row.reserved_paise),
    canStart: role === "customer" && row.status === "confirmed" && row.settlement_status === "held" &&
      Date.now() >= Number(row.starts_at) - 5 * 60_000 && Date.now() < Number(row.ends_at),
    canCancel: row.status === "confirmed" && row.settlement_status === "held",
    ...(row.call_id ? { callId: row.call_id } : {}),
  };
  return role === "host" ? { ...common, expectedHostNetPaise: Number(row.expected_host_net_paise) } : common;
}

function eventTrack(env: Env, uid: string, event: string, props: Record<string, unknown>): void {
  void track(env, uid, event, BOOKING_APP, {
    ...props,
    correlation_id: String(props.booking_id ?? props.quote_id ?? crypto.randomUUID()),
    booking_snapshot_version: 1,
  }).catch(() => undefined);
}

function parseUtcIso(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === new Date(value).toISOString() ? ms : null;
}

function laneGuardSql(customerParam: number, hostParam: number, lane: string | null): string {
  const gates = [
    `(NOT EXISTS (SELECT 1 FROM hf_hosts WHERE uid=?${hostParam} AND women_lane=1) OR EXISTS (` +
      `SELECT 1 FROM hf_lane_access la JOIN hf_kyc k ON k.uid=la.uid AND k.verified_at IS NOT NULL ` +
      `WHERE la.uid=?${customerParam} AND la.lane='women' AND k.gender IN ('F','T')))` ,
  ];
  if (lane === "lgbtq") gates.push(
    `EXISTS (SELECT 1 FROM hf_lane_access WHERE uid=?${customerParam} AND lane='lgbtq' AND declared_at IS NOT NULL)`,
    `(SELECT review_status FROM hf_selfie WHERE uid=?${customerParam} ORDER BY created_at DESC,id DESC LIMIT 1)='approved'`,
  );
  return gates.join(" AND ");
}

function activeConflictSql(a: number, b: number, start: number, end: number, buffer: number): string {
  const parties = "user_id IN (?" + a + ",?" + b + ")";
  const bufferMs = "?" + buffer + "*60000";
  const interval = "starts_at<?" + end + "+" + bufferMs + " AND ends_at>?" + start + "-" + bufferMs;
  return "NOT EXISTS (SELECT 1 FROM hf_booking_occupancy WHERE " + parties + " AND status='busy' AND " + interval + ")" +
    " AND NOT EXISTS (SELECT 1 FROM calendar_blocks WHERE " + parties + " AND status IN ('busy','tentative') AND " + interval + ")" +
    " AND NOT EXISTS (SELECT 1 FROM hf_bookings WHERE status IN " + BOOKING_ACTIVE +
    " AND (host_uid IN (?" + a + ",?" + b + ") OR customer_uid IN (?" + a + ",?" + b + "))" +
    " AND starts_at<?" + end + "+" + bufferMs + " AND ends_at>?" + start + "-" + bufferMs + ")";
}

async function bookingEligibility(env: Env, uid: string, host: HfHostPricingRow, lane: string | null): Promise<Response | null> {
  if (host.status !== "live" || host.uid === uid) return err(409, "host_unavailable");
  if (await isClosing(env, uid) || await isClosing(env, host.uid)) return err(409, "account_closing");
  if (!(await verifiedWhatsAppNumber(env, uid)) || !(await verifiedWhatsAppNumber(env, host.uid))) return err(403, "not_verified");
  if (await isBlockedEitherWay(env, uid, host.uid)) return err(409, "host_unavailable");
  if (host.women_lane === 1 && !(await hasLaneAccess(env, uid, "women"))) return err(403, "lane_required", { lane: "women" });
  if (lane === "lgbtq") {
    if (host.lgbtq_lane !== 1) return err(409, "host_unavailable");
    if (!(await hasLaneAccess(env, uid, "lgbtq"))) return err(403, "lane_required", { lane: "lgbtq" });
  } else if (lane != null && lane !== "women") return err(400, "invalid_lane");
  return null;
}

async function loadHostPricing(env: Env, host: HfHostPricingRow) {
  const cfg = await readConfig(env).catch(() => ({})) as Record<string, unknown>;
  if (cfg.hfCallsEnabled !== true || !callsConfigured(env)) return null;
  const tk = readHfTokenConfig(cfg);
  const std = readHfStdPlan(cfg);
  const rate = Math.trunc(Number(host.price_per_min) * 100);
  if (isCreatorCategory(host.category)) {
    if (!validCreatorRate(Number(host.price_per_min))) return null;
    const creator = creatorSnapshotFor(host.category as "influencer" | "celebrity", Number(host.price_per_min));
    const snapshot = {
      ratePaise: creator.ratePaise, callCostPaisePerMin: creator.callCostPaisePerMin, hostShareBps: creator.hostShareBps,
      taxMode: creator.taxMode, splitRuleVersion: creator.version + "/gross-share-less-cost-v1", creator,
    };
    return { snapshot, price: priceOf(snapshot), hostNet: (seconds: number) => creatorCallSplit(creator, seconds).hostPaise, plan: "creator" };
  }
  if (std.enabled) {
    const snapshot = stdSnapshotFor(std);
    return { snapshot, price: priceOf(snapshot), hostNet: (seconds: number) => stdSplit({
      tariff: std.tariff, billableSeconds: seconds, hostPaisePerMin: std.hostPaisePerMin,
      phoneCostPaisePerMin: std.phoneCostPaisePerMin,
    }).hostPaise, plan: "standard" };
  }
  if (!tk.enabled || rate <= 0 || rate > 100_000 * 100) return null;
  const snapshot = snapshotFor(rate, tk);
  return { snapshot, price: priceOf(snapshot), hostNet: (seconds: number) => callSplit({
    ratePaise: rate, billableSeconds: seconds, callCostPaisePerMin: tk.callCostPaisePerMin, hostShareBps: tk.hostShareBps,
  }).hostPaise, plan: "flat" };
}


async function quoteRoute(req: Request, env: Env): Promise<Response> {
  const auth = await requireUser(req, env);
  if (isFail(auth)) return err(auth.status, auth.error);
  const limited = await rateLimit(env, "hfbookquote:" + auth.uid, 12, 600);
  if (limited) return limited;
  const body = await readJson(req);
  if (!body) return err(400, "invalid_quote_request");
  const slug = typeof body.hostSlug === "string" ? body.hostSlug.trim().toLowerCase() : "";
  const startAt = parseUtcIso(body.startUtc);
  const duration = Number(body.durationMinutes);
  const lane = body.lane == null || body.lane === "" ? null : String(body.lane);
  if (!/^[a-z0-9-]{3,40}$/.test(slug) || startAt == null || !Number.isInteger(duration)) return err(400, "invalid_quote_request");
  const host = await env.DB_META.prepare(
    "SELECT uid,slug,status,price_per_min,category,women_lane,lgbtq_lane FROM hf_hosts WHERE slug=?1",
  ).bind(slug).first<HfHostPricingRow>();
  if (!host) return err(404, "host_not_found");
  const eligibility = await bookingEligibility(env, auth.uid, host, lane);
  if (eligibility) return eligibility;
  const schedule = await getHfBookingSchedule(env, host.uid);
  if (schedule.version < 1 || validateHfBookingSchedule(schedule).length) return err(409, "availability_unavailable");
  if (!schedule.durationsMinutes.includes(duration)) return err(400, "invalid_duration");
  const local = localDateAndMinute(startAt, schedule.timezone);
  if (!isBookingDateRangeWithinHorizon(schedule, local.date, local.date)) return err(400, "slot_out_of_bounds");
  const range = utcRangeForDates(local.date, local.date);
  const hostBusy = await listHfBusyIntervals(env, host.uid, range.from, range.to);
  const customerBusy = await listHfBusyIntervals(env, auth.uid, range.from, range.to);
  const slot = slotsForDate(schedule, local.date, duration, hostBusy).find((item) => item.startAt === startAt);
  if (!slot || conflictsWithBusy(slot.startAt, slot.endAt, customerBusy, schedule.bufferMinutes)) {
    eventTrack(env, auth.uid, "hf_booking_quote_conflict", { host_uid: host.uid, duration_minutes: duration });
    return err(409, "slot_unavailable");
  }
  if (await hasOpenDebt(env, auth.uid)) return err(409, "debt_open");
  const pricing = await loadHostPricing(env, host);
  if (!pricing) return err(409, "booking_payment_unavailable");
  const seconds = duration * 60;
  const reservedPaise = chargePaise(pricing.price, seconds);
  const expectedHostNetPaise = pricing.hostNet(seconds);
  if (!(reservedPaise > 0) || !(expectedHostNetPaise >= 0)) return err(409, "pricing_unavailable");
  const now = Date.now();
  const quoteId = crypto.randomUUID();
  const expiresAt = now + QUOTE_TTL_MS;
  const policySnapshot = {
    version: "cancel-before-connect-r1",
    lane,
    cancellation: "Either participant may cancel before connection; no cancellation fee.",
    noShow: "No-show before a call connects releases the full reservation.",
    reschedule: "Cancel and book again; replacement availability is not guaranteed.",
  };
  const priceSnapshot = {
    ...pricing.snapshot, plan: pricing.plan, price: pricing.price,
    reservedPaise, expectedHostNetPaise, durationMinutes: duration,
  };
  const conflict = activeConflictSql(2, 3, 4, 5, 13);
  const result = await env.DB_META.prepare(
    "INSERT INTO hf_booking_quotes (id,customer_uid,host_uid,starts_at,ends_at,duration_min,schedule_version,expires_at,status,reserved_paise,price_snapshot_json,policy_snapshot_json,created_at) " +
    "SELECT ?1,?2,?3,?4,?5,?6,?7,?8,'open',?9,?10,?11,?12 " +
    "WHERE EXISTS (SELECT 1 FROM hf_availability_schedules WHERE host_uid=?3 AND version=?7) " +
    "AND NOT EXISTS (SELECT 1 FROM hf_booking_schedule_locks WHERE host_uid=?3 AND expires_at>?12) " +
    "AND EXISTS (SELECT 1 FROM hf_hosts WHERE uid=?3 AND status='live') " +
    "AND NOT EXISTS (SELECT 1 FROM hf_blocks WHERE (blocker_uid=?2 AND blocked_uid=?3) OR (blocker_uid=?3 AND blocked_uid=?2)) " +
    "AND NOT EXISTS (SELECT 1 FROM hf_exit_requests WHERE uid IN (?2,?3) AND status IN ('booking_cleanup','waiting_hold','waiting_payouts','ready')) " +
    "AND NOT EXISTS (SELECT 1 FROM hf_calls WHERE (caller_uid IN (?2,?3) OR host_uid IN (?2,?3)) AND status IN ('ringing_host','ringing_caller','connected')) " +
    "AND " + laneGuardSql(2, 3, lane) + " AND " + conflict,
  ).bind(quoteId, auth.uid, host.uid, slot.startAt, slot.endAt, duration, schedule.version, expiresAt,
    reservedPaise, JSON.stringify(priceSnapshot), JSON.stringify(policySnapshot), now, schedule.bufferMinutes).run();
  if (Number(result.meta?.changes ?? 0) !== 1) {
    eventTrack(env, auth.uid, "hf_booking_quote_conflict", { host_uid: host.uid, duration_minutes: duration, schedule_version: schedule.version });
    return err(409, "slot_unavailable");
  }
  const quote = {
    id: quoteId, expiresAt, startUtc: new Date(slot.startAt).toISOString(), endUtc: new Date(slot.endAt).toISOString(),
    durationMinutes: duration, reservedPaise, priceRupees: reservedPaise / 100,
  };
  eventTrack(env, auth.uid, "hf_booking_quote_created", {
    quote_id: quoteId, host_uid: host.uid, duration_minutes: duration,
    reserved_paise: reservedPaise, schedule_version: schedule.version, expires_at: expiresAt,
  });
  return json({ quote }, 201, { "cache-control": "private, no-store" });
}

async function confirmRoute(req: Request, env: Env): Promise<Response> {
  const auth = await requireUser(req, env);
  if (isFail(auth)) return err(auth.status, auth.error);
  const idempotencyKey = req.headers.get("Idempotency-Key")?.trim() ?? "";
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) return err(400, "idempotency_key_required");
  const body = await readJson(req);
  if (!body) return err(400, "invalid_quote");
  if (body.policyAccepted !== true) return err(400, "policy_acceptance_required");
  const quoteId = typeof body.quoteId === "string" ? body.quoteId : "";
  if (!/^[0-9a-f-]{36}$/i.test(quoteId)) return err(400, "invalid_quote");
  const old = await env.DB_META.prepare("SELECT * FROM hf_bookings WHERE customer_uid=?1 AND idempotency_key=?2")
    .bind(auth.uid, idempotencyKey).first<BookingRow>();
  if (old) {
    if (old.quote_id !== quoteId) return err(409, "idempotency_payload_mismatch");
    return json({ booking: bookingPublic(old, "customer") }, 200, { "cache-control": "private, no-store" });
  }
  const quote = await env.DB_META.prepare("SELECT * FROM hf_booking_quotes WHERE id=?1 AND customer_uid=?2")
    .bind(quoteId, auth.uid).first<BookingQuoteRow>();
  if (!quote || quote.status !== "open" || Number(quote.expires_at) <= Date.now()) return err(409, "quote_expired");
  const host = await env.DB_META.prepare("SELECT uid,slug,status,price_per_min,category,women_lane,lgbtq_lane FROM hf_hosts WHERE uid=?1")
    .bind(quote.host_uid).first<HfHostPricingRow>();
  if (!host) return err(409, "host_unavailable");
  const policy = JSON.parse(quote.policy_snapshot_json) as { lane?: string | null };
  const eligibility = await bookingEligibility(env, auth.uid, host, policy.lane ?? null);
  if (eligibility) return eligibility;
  const schedule = await getHfBookingSchedule(env, quote.host_uid);
  if (schedule.version !== Number(quote.schedule_version) || schedule.version < 1) return err(409, "schedule_changed");
  const callConfig = await readConfig(env).catch(() => null);
  if (callConfig?.hfCallsEnabled !== true || !callsConfigured(env)) return err(409, "booking_payment_unavailable");
  if (await hasOpenDebt(env, auth.uid)) return err(409, "debt_open");
  const priceSnapshot = JSON.parse(quote.price_snapshot_json) as {
    price: Price; expectedHostNetPaise: number; ratePaise: number;
    callCostPaisePerMin: number; hostShareBps: number; creator?: unknown; std?: unknown;
  };
  const lots = await availableLots(env, auth.uid);
  const seconds = Number(quote.duration_min) * 60;
  const spend = planSpend(lots, priceSnapshot.price, seconds);
  if (spend.secondsCovered !== seconds || spend.totalValuePaise !== Number(quote.reserved_paise)) {
    eventTrack(env, auth.uid, "hf_booking_confirm_conflict", { quote_id: quote.id, host_uid: host.uid, reason: "insufficient_or_changed_lots" });
    return err(402, "low_balance", { reservedPaise: Number(quote.reserved_paise), shortfallSeconds: Math.max(0, seconds - spend.secondsCovered) });
  }
  const allLots = await getLots(env, auth.uid);
  const kindById = new Map(allLots.map((lot) => [lot.id, lot.kind]));
  const paidValue = spend.uses.reduce((n, use) => n + (kindById.get(use.lotId) === "purchase" ? use.valuePaise : 0), 0);
  const hostSplit = splitHostByKind(Number(priceSnapshot.expectedHostNetPaise), Number(quote.reserved_paise), paidValue);
  const bookingId = crypto.randomUUID();
  const callId = crypto.randomUUID();
  const now = Date.now();
  const nonce = crypto.randomUUID();
  const reserveOp = resOpId(callId);
  const reservationSnapshot = JSON.stringify({
    callId, secondsCovered: spend.secondsCovered, reservedPaise: spend.totalValuePaise,
    lots: spend.uses.map((lot) => ({ lotId: lot.lotId, micro: lot.micro, valuePaise: lot.valuePaise, kind: kindById.get(lot.lotId) ?? "unknown" })),
  });
  const insertParams: unknown[] = [
    bookingId, host.uid, auth.uid, Number(quote.starts_at), Number(quote.ends_at), schedule.timezone,
    schedule.version, quote.id, idempotencyKey, Number(quote.duration_min), Number(quote.reserved_paise),
    Number(priceSnapshot.expectedHostNetPaise), hostSplit.paidPaise, hostSplit.testPaise,
    quote.price_snapshot_json, quote.policy_snapshot_json, reservationSnapshot, callId, now,
  ];
  const lotGuards = spend.uses.map((use) => {
    const i = insertParams.length + 1;
    insertParams.push(use.lotId, use.micro);
    return "EXISTS (SELECT 1 FROM hf_token_lots WHERE id=?" + i + " AND uid=?3 AND status='active' AND tokens_left_micro-tokens_reserved_micro>=?" + (i + 1) + ")";
  });
  const bufferIndex = insertParams.length + 1;
  const conflict = activeConflictSql(2, 3, 4, 5, bufferIndex);
  insertParams.push(schedule.bufferMinutes);
  const reserveOpIndex = insertParams.length + 1;
  insertParams.push(reserveOp);
  const bookingInsert = env.DB_META.prepare(
    "INSERT INTO hf_bookings (id,host_uid,customer_uid,starts_at,ends_at,host_timezone,schedule_version,quote_id,idempotency_key,status,duration_min," +
    "reserved_paise,expected_host_net_paise,expected_host_paid_net_paise,expected_host_test_net_paise,price_snapshot_json,policy_snapshot_json,reservation_snapshot_json,call_id,settlement_status,created_at,updated_at) " +
    "SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,'confirming',?10,?11,?12,?13,?14,?15,?16,?17,?18,'held',?19,?19 " +
    "WHERE EXISTS (SELECT 1 FROM hf_booking_quotes q WHERE q.id=?8 AND q.customer_uid=?3 AND q.host_uid=?2 AND q.status='open' AND q.expires_at>?19) " +
    "AND EXISTS (SELECT 1 FROM hf_availability_schedules s WHERE s.host_uid=?2 AND s.version=?7) " +
    "AND NOT EXISTS (SELECT 1 FROM hf_booking_schedule_locks WHERE host_uid=?2 AND expires_at>?19) " +
    "AND EXISTS (SELECT 1 FROM hf_hosts WHERE uid=?2 AND status='live') " +
    "AND NOT EXISTS (SELECT 1 FROM hf_blocks WHERE (blocker_uid=?3 AND blocked_uid=?2) OR (blocker_uid=?2 AND blocked_uid=?3)) " +
    "AND NOT EXISTS (SELECT 1 FROM hf_exit_requests WHERE uid IN (?2,?3) AND status IN ('booking_cleanup','waiting_hold','waiting_payouts','ready')) " +
    "AND NOT EXISTS (SELECT 1 FROM hf_token_debts WHERE uid=?3 AND status='open') " +
    "AND NOT EXISTS (SELECT 1 FROM hf_calls WHERE (caller_uid IN (?2,?3) OR host_uid IN (?2,?3)) AND status IN ('ringing_host','ringing_caller','connected')) " +
    "AND NOT EXISTS (SELECT 1 FROM hf_token_ledger WHERE op_id=?" + reserveOpIndex + ") " +
    "AND EXISTS (SELECT 1 FROM contact_verification cv JOIN phone_otp p ON p.uid=cv.uid AND p.phone_hash=cv.phone_hash WHERE cv.uid=?3 AND cv.phone_verified=1 AND p.status='verified') " +
    "AND EXISTS (SELECT 1 FROM contact_verification cv JOIN phone_otp p ON p.uid=cv.uid AND p.phone_hash=cv.phone_hash WHERE cv.uid=?2 AND cv.phone_verified=1 AND p.status='verified') " +
    "AND " + laneGuardSql(3, 2, policy.lane ?? null) + " AND (" + lotGuards.join(" AND ") + ") AND " + conflict,
  ).bind(...insertParams);
  const reserveStatements = buildReservationStatements(env, {
    uid: auth.uid, callId, plan: spend, now, nonce,
    gatePredicate: (first) => ({
      sql: "EXISTS (SELECT 1 FROM hf_bookings WHERE id=?" + first + " AND status='confirming' AND customer_uid=?" + (first + 1) + " AND quote_id=?" + (first + 2) + ")",
      values: [bookingId, auth.uid, quote.id],
    }),
  });
  const statements = [
    bookingInsert,
    ...reserveStatements,
    env.DB_META.prepare("UPDATE hf_bookings SET status='confirmed',updated_at=?1 WHERE id=?2 AND status='confirming' AND EXISTS (SELECT 1 FROM hf_token_ledger WHERE op_id=?3 AND note=?4)")
      .bind(now, bookingId, reserveOp, "secs:" + seconds),
    env.DB_META.prepare("UPDATE hf_booking_quotes SET status='consumed',consumed_at=?1 WHERE id=?2 AND status='open' AND EXISTS (SELECT 1 FROM hf_bookings WHERE id=?3 AND status='confirmed')")
      .bind(now, quote.id, bookingId),
    env.DB_META.prepare("INSERT INTO hf_booking_occupancy(booking_id,user_id,starts_at,ends_at,status,created_at,updated_at) SELECT ?1,?2,?3,?4,'busy',?5,?5 WHERE EXISTS (SELECT 1 FROM hf_bookings WHERE id=?1 AND status='confirmed')")
      .bind(bookingId, host.uid, quote.starts_at, quote.ends_at, now),
    env.DB_META.prepare("INSERT INTO hf_booking_occupancy(booking_id,user_id,starts_at,ends_at,status,created_at,updated_at) SELECT ?1,?2,?3,?4,'busy',?5,?5 WHERE EXISTS (SELECT 1 FROM hf_bookings WHERE id=?1 AND status='confirmed')")
      .bind(bookingId, auth.uid, quote.starts_at, quote.ends_at, now),
    env.DB_META.prepare("INSERT INTO calendar_blocks(id,user_id,source_app,source_ref,starts_at,ends_at,title,status,created_at) SELECT ?1,?2,'hf_booking',?3,?4,?5,NULL,'busy',?6 WHERE EXISTS (SELECT 1 FROM hf_bookings WHERE id=?3 AND status='confirmed')")
      .bind("hfb:" + bookingId + ":host", host.uid, bookingId, quote.starts_at, quote.ends_at, now),
    env.DB_META.prepare("INSERT INTO calendar_blocks(id,user_id,source_app,source_ref,starts_at,ends_at,title,status,created_at) SELECT ?1,?2,'hf_booking',?3,?4,?5,NULL,'busy',?6 WHERE EXISTS (SELECT 1 FROM hf_bookings WHERE id=?3 AND status='confirmed')")
      .bind("hfb:" + bookingId + ":customer", auth.uid, bookingId, quote.starts_at, quote.ends_at, now),
    env.DB_META.prepare("INSERT INTO hf_booking_events(id,booking_id,operation_id,actor_uid,from_status,to_status,details_json,created_at) SELECT ?1,?2,?3,?4,'confirming','confirmed',?5,?6 WHERE EXISTS (SELECT 1 FROM hf_bookings WHERE id=?2 AND status='confirmed')")
      .bind(crypto.randomUUID(), bookingId, "confirm:" + idempotencyKey, auth.uid, JSON.stringify({ quoteId: quote.id, reservedPaise: quote.reserved_paise, durationMinutes: quote.duration_min }), now),
  ];
  try {
    await env.DB_META.batch(statements);
  } catch {
    const afterRace = await env.DB_META.prepare("SELECT * FROM hf_bookings WHERE customer_uid=?1 AND idempotency_key=?2")
      .bind(auth.uid, idempotencyKey).first<BookingRow>();
    if (afterRace) {
      if (afterRace.quote_id !== quoteId) return err(409, "idempotency_payload_mismatch");
      return json({ booking: bookingPublic(afterRace, "customer") }, 200, { "cache-control": "private, no-store" });
    }
    eventTrack(env, auth.uid, "hf_booking_confirm_conflict", { quote_id: quoteId, host_uid: host.uid, reason: "guard_or_race" });
    return err(409, "slot_or_wallet_changed");
  }
  const saved = await env.DB_META.prepare("SELECT * FROM hf_bookings WHERE id=?1 AND customer_uid=?2")
    .bind(bookingId, auth.uid).first<BookingRow>();
  if (!saved || saved.status !== "confirmed") return err(409, "slot_or_wallet_changed");
  eventTrack(env, auth.uid, "hf_booking_confirmed", {
    booking_id: bookingId, call_id: callId, host_uid: host.uid, duration_minutes: seconds / 60,
    reserved_paise: Number(quote.reserved_paise), expected_host_net_paise: Number(priceSnapshot.expectedHostNetPaise),
  });
  return json({ booking: bookingPublic(saved, "customer") }, 201, { "cache-control": "private, no-store" });
}

function decodeCursor(value: string | null): { startsAt: number; id: string } | null {
  if (!value) return null;
  const splitAt = value.indexOf(".");
  if (splitAt <= 0) return null;
  const startsAt = Number(value.slice(0, splitAt));
  const id = value.slice(splitAt + 1);
  return Number.isSafeInteger(startsAt) && startsAt >= 0 && /^[0-9a-f-]{36}$/i.test(id) ? { startsAt, id } : null;
}

async function listRoute(req: Request, env: Env): Promise<Response> {
  const auth = await requireUser(req, env);
  if (isFail(auth)) return err(auth.status, auth.error);
  const url = new URL(req.url);
  const role = url.searchParams.get("role");
  if (role !== "host" && role !== "customer") return err(400, "invalid_role");
  const cursor = decodeCursor(url.searchParams.get("cursor"));
  if (url.searchParams.has("cursor") && !cursor) return err(400, "invalid_cursor");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const fromAt = from == null ? null : parseUtcIso(from);
  const toAt = to == null ? null : parseUtcIso(to);
  if ((from != null && fromAt == null) || (to != null && toAt == null) || (fromAt != null && toAt != null && toAt <= fromAt)) return err(400, "invalid_date_range");
  if (role === "host") {
    const host = await env.DB_META.prepare("SELECT 1 AS x FROM hf_hosts WHERE uid=?1").bind(auth.uid).first();
    if (!host) return err(404, "host_not_found");
  }
  const userColumn = role === "host" ? "host_uid" : "customer_uid";
  const values: unknown[] = [auth.uid];
  let index = 2;
  let where = "";
  if (fromAt != null) { where += " AND ends_at>?" + index++; values.push(fromAt); }
  if (toAt != null) { where += " AND starts_at<?" + index++; values.push(toAt); }
  if (cursor) { where += " AND (starts_at>?" + index + " OR (starts_at=?" + index + " AND id>?" + (index + 1) + "))"; values.push(cursor.startsAt, cursor.startsAt, cursor.id); index += 2; }
  values.push(51);
  const rows = (await env.DB_META.prepare("SELECT * FROM hf_bookings WHERE " + userColumn + "=?1" + where + " ORDER BY starts_at,id LIMIT ?" + index)
    .bind(...values).all<BookingRow>()).results ?? [];
  const more = rows.length > 50;
  const page = rows.slice(0, 50);
  const bookings = page.map((row) => bookingPublic(row, role));
  const last = page[page.length - 1];
  const nextCursor = more && last ? String(last.starts_at) + "." + last.id : undefined;
  return json({ bookings, ...(nextCursor ? { nextCursor } : {}) }, 200, { "cache-control": "private, no-store" });
}

async function detailRoute(req: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireUser(req, env);
  if (isFail(auth)) return err(auth.status, auth.error);
  const row = await env.DB_META.prepare("SELECT * FROM hf_bookings WHERE id=?1 AND (host_uid=?2 OR customer_uid=?2)")
    .bind(id, auth.uid).first<BookingRow>();
  if (!row) return err(404, "booking_not_found");
  const role = row.host_uid === auth.uid ? "host" : "customer";
  return json({ booking: bookingPublic(row, role) }, 200, { "cache-control": "private, no-store" });
}

async function cancelRoute(req: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireUser(req, env);
  if (isFail(auth)) return err(auth.status, auth.error);
  const row = await env.DB_META.prepare("SELECT * FROM hf_bookings WHERE id=?1 AND (host_uid=?2 OR customer_uid=?2)")
    .bind(id, auth.uid).first<BookingRow>();
  if (!row) return err(404, "booking_not_found");
  const role = row.host_uid === auth.uid ? "host" : "customer";
  if (row.status === "cancelled") return json({ booking: bookingPublic(row, role) }, 200, { "cache-control": "private, no-store" });
  if (row.status !== "confirmed" || !row.call_id) return err(409, "booking_not_cancellable");
  const reservation = await getReservation(env, row.call_id);
  if (!reservation || reservation.secondsCovered !== Number(row.duration_min) * 60 || !reservation.lots.length) return err(409, "booking_hold_unavailable");
  const now = Date.now();
  const nonce = crypto.randomUUID();
  const releaseStatements = buildReleaseStatements(env, {
    uid: row.customer_uid, callId: row.call_id, lots: reservation.lots, now, nonce,
    gatePredicate: (first) => ({
      sql: "EXISTS (SELECT 1 FROM hf_bookings WHERE id=?" + first + " AND status='confirmed' AND call_id=?" + (first + 1) +
        " AND (host_uid=?" + (first + 2) + " OR customer_uid=?" + (first + 2) + "))",
      values: [row.id, row.call_id, auth.uid],
    }),
  });
  const releaseGate = relOpId(row.call_id);
  const statements = [
    releaseStatements[0],
    env.DB_META.prepare("UPDATE hf_bookings SET status='cancelled',settlement_status='released',cancelled_at=?1,updated_at=?1 " +
      "WHERE id=?2 AND status='confirmed' AND EXISTS (SELECT 1 FROM hf_token_ledger WHERE op_id=?3 AND note=?4)")
      .bind(now, row.id, releaseGate, nonce),
    ...releaseStatements.slice(1, -1),
    env.DB_META.prepare("UPDATE hf_booking_occupancy SET status='cancelled',updated_at=?1 WHERE booking_id=?2 AND " +
      "EXISTS (SELECT 1 FROM hf_bookings WHERE id=?2 AND status='cancelled')").bind(now, row.id),
    env.DB_META.prepare("UPDATE calendar_blocks SET status='cancelled' WHERE source_app='hf_booking' AND source_ref=?1 " +
      "AND EXISTS (SELECT 1 FROM hf_bookings WHERE id=?1 AND status='cancelled')").bind(row.id),
    env.DB_META.prepare("INSERT INTO hf_booking_events(id,booking_id,operation_id,actor_uid,from_status,to_status,details_json,created_at) " +
      "SELECT ?1,?2,?3,?4,'confirmed','cancelled',?5,?6 WHERE EXISTS (SELECT 1 FROM hf_bookings WHERE id=?2 AND status='cancelled') " +
      "AND EXISTS (SELECT 1 FROM hf_token_ledger WHERE op_id=?7)")
      .bind(crypto.randomUUID(), row.id, "cancel:" + row.id, auth.uid, JSON.stringify({ role, releasedPaise: row.reserved_paise }), now, releaseGate),
    releaseStatements[releaseStatements.length - 1],
  ];
  await env.DB_META.batch(statements);
  const saved = await env.DB_META.prepare("SELECT * FROM hf_bookings WHERE id=?1 AND (host_uid=?2 OR customer_uid=?2)")
    .bind(row.id, auth.uid).first<BookingRow>();
  if (!saved || saved.status !== "cancelled") return err(409, "booking_not_cancellable");
  eventTrack(env, auth.uid, "hf_booking_cancelled", { booking_id: row.id, call_id: row.call_id, role, released_paise: row.reserved_paise });
  return json({ booking: bookingPublic(saved, role) }, 200, { "cache-control": "private, no-store" });
}

async function startBookingRoute(req: Request, env: Env, bookingId: string): Promise<Response> {
  const auth = await requireUser(req, env);
  if (isFail(auth)) return err(auth.status, auth.error);
  const now = Date.now();
  const row = await env.DB_META.prepare("SELECT * FROM hf_bookings WHERE id=?1 AND customer_uid=?2")
    .bind(bookingId, auth.uid).first<BookingRow>();
  if (!row) return err(404, "booking_not_found");
  if (row.status === "starting" || row.status === "active" || row.status === "settling") {
    const existing = await env.DB_META.prepare("SELECT id,status FROM hf_calls WHERE booking_id=?1").bind(bookingId)
      .first<{ id: string; status: string }>();
    if (existing) {
      const response = await env.HF_CALL.get(env.HF_CALL.idFromName(existing.id)).fetch("https://hfcall/recover", {
        method: "POST", body: JSON.stringify({ callId: existing.id }),
      }).catch(() => null);
      if (!response?.ok) {
        if (response?.status === 409 || response?.status === 410) return err(409, "booking_call_manual_recovery");
        return err(502, "call_start_pending");
      }
      return json({ callId: existing.id, status: existing.status }, 200, { "cache-control": "private, no-store" });
    }
    return err(409, "booking_start_recovery_pending");
  }
  if (row.status !== "confirmed" || row.settlement_status !== "held") return err(409, "booking_not_startable");
  if (now < Number(row.starts_at) - 5 * 60_000 || now >= Number(row.ends_at)) return err(409, "outside_start_window");
  if (await isClosing(env, row.customer_uid) || await isClosing(env, row.host_uid)) return err(409, "account_closing");
  const reservation = await getReservation(env, row.call_id);
  if (!reservation || reservation.secondsCovered !== Number(row.duration_min) * 60 || reservation.lots.length === 0) {
    return err(409, "reservation_unavailable");
  }
  const host = await env.DB_META.prepare("SELECT uid,slug,status,presence,display_name,price_per_min,category,women_lane,lgbtq_lane FROM hf_hosts WHERE uid=?1")
    .bind(row.host_uid).first<HfHostPricingRow & { presence: string; display_name: string | null }>();
  if (!host || host.presence !== "online") return err(409, "host_unavailable");
  const policy = JSON.parse(row.policy_snapshot_json) as { lane?: string | null };
  const eligibility = await bookingEligibility(env, row.customer_uid, host, policy.lane ?? null);
  if (eligibility) return eligibility;
  const cfg = await readConfig(env).catch(() => ({})) as Record<string, unknown>;
  if (cfg.hfCallsEnabled !== true || !callsConfigured(env)) return err(404, "calls_not_enabled");
  const priceSnapshot = JSON.parse(row.price_snapshot_json) as Record<string, any>;
  const ratePaise = Math.trunc(Number(priceSnapshot.ratePaise));
  const maxSeconds = Number(row.duration_min) * 60;
  if (!(ratePaise > 0) || !Number.isInteger(maxSeconds)) return err(409, "pricing_snapshot_invalid");
  const callId = row.call_id;
  if (!(await claimHost(env, row.host_uid, callId))) return err(409, "host_unavailable");
  const conferenceName = `hf_${callId.replace(/-/g, "")}`;
  try {
    await env.DB_META.batch([
      env.DB_META.prepare(`UPDATE hf_bookings SET status='starting',updated_at=?1 WHERE id=?2 AND status='confirmed' AND settlement_status='held' AND starts_at<=?3+300000 AND ends_at>?3 AND NOT EXISTS (SELECT 1 FROM hf_exit_requests WHERE uid IN (?4,?5) AND status IN ('booking_cleanup','waiting_hold','waiting_payouts','ready')) AND NOT EXISTS (SELECT 1 FROM hf_blocks WHERE (blocker_uid=?4 AND blocked_uid=?5) OR (blocker_uid=?5 AND blocked_uid=?4)) AND EXISTS (SELECT 1 FROM contact_verification cv JOIN phone_otp p ON p.uid=cv.uid AND p.phone_hash=cv.phone_hash WHERE cv.uid=?4 AND cv.phone_verified=1 AND p.status='verified') AND EXISTS (SELECT 1 FROM contact_verification cv JOIN phone_otp p ON p.uid=cv.uid AND p.phone_hash=cv.phone_hash WHERE cv.uid=?5 AND cv.phone_verified=1 AND p.status='verified') AND EXISTS (SELECT 1 FROM hf_hosts WHERE uid=?5 AND status='live' AND presence='busy' AND presence_call_id=?6) AND ${laneGuardSql(4,5,policy.lane ?? null)}`)
        .bind(now, bookingId, now, row.customer_uid, row.host_uid, callId),
      env.DB_META.prepare("INSERT INTO hf_calls(id,caller_uid,host_uid,rate_paise,status,lane,created_at,conference_name,call_cost_paise_per_min,host_share_bps,tax_mode,split_rule_version,pricing_snapshot,booking_id) " +
        "SELECT ?1,?2,?3,?4,'ringing_host',?5,?6,?7,?8,?9,?10,?11,?12,?13 WHERE EXISTS (SELECT 1 FROM hf_bookings WHERE id=?13 AND status='starting' AND call_id=?1)")
        .bind(callId, row.customer_uid, row.host_uid, ratePaise, policy.lane ?? null, now, conferenceName,
          Number(priceSnapshot.callCostPaisePerMin), Number(priceSnapshot.hostShareBps), String(priceSnapshot.taxMode ?? ""), String(priceSnapshot.splitRuleVersion ?? ""),
          JSON.stringify(priceSnapshot.creator ?? priceSnapshot.std ?? priceSnapshot), bookingId),
      env.DB_META.prepare("INSERT INTO hf_booking_events(id,booking_id,operation_id,actor_uid,from_status,to_status,details_json,created_at) SELECT ?1,?2,?3,?4,'confirmed','starting',?5,?6 WHERE EXISTS (SELECT 1 FROM hf_bookings WHERE id=?2 AND status='starting')")
        .bind(crypto.randomUUID(), bookingId, "start:"+callId, auth.uid, JSON.stringify({ callId }), now),
    ]);
    const started = await env.DB_META.prepare("SELECT b.status AS booking_status,c.id AS call_id FROM hf_bookings b LEFT JOIN hf_calls c ON c.booking_id=b.id WHERE b.id=?1")
      .bind(bookingId).first<{ booking_status: string; call_id: string | null }>();
    if (started?.booking_status !== "starting" || started.call_id !== callId) {
      await releaseHost(env, row.host_uid, callId).catch(() => undefined);
      return err(409, "booking_start_conflict");
    }
  } catch {
    await releaseHost(env, row.host_uid, callId).catch(() => undefined);
    return err(409, "booking_start_conflict");
  }
  try {
    const stub = env.HF_CALL.get(env.HF_CALL.idFromName(callId));
    const response = await stub.fetch("https://hfcall/init", {
      method: "POST",
      body: JSON.stringify({
        callId, bookingId, bookedEndsAt: Number(row.ends_at), hardEndsAt: Number(row.ends_at), callerUid: row.customer_uid, hostUid: row.host_uid, rateRupees: ratePaise / 100,
        reservedRupees: 0, testReservedRupees: 0, fundsRupees: 0, maxMinutes: Number(row.duration_min),
        limitReason: "time_limit",
        tokens: {
          ratePaise, callCostPaisePerMin: Number(priceSnapshot.callCostPaisePerMin),
          hostShareBps: Number(priceSnapshot.hostShareBps), maxSeconds, booked: true,
          std: priceSnapshot.std ?? null, creator: priceSnapshot.creator ?? null,
        },
      }),
    });
    if (!response.ok) return err(502, "call_start_pending");
    return json({ callId, status: "ringing_host" }, 201, { "cache-control": "private, no-store" });
  } catch {
    return err(502, "call_start_pending");
  }
}

async function hostSummaryRoute(req: Request, env: Env): Promise<Response> {
  const auth = await requireUser(req, env);
  if (isFail(auth)) return err(auth.status, auth.error);
  const host = await env.DB_META.prepare("SELECT 1 AS x FROM hf_hosts WHERE uid=?1").bind(auth.uid).first();
  if (!host) return err(404, "host_not_found");
  const now = Date.now();
  const summary = await env.DB_META.prepare(
    "SELECT (SELECT COUNT(*) FROM hf_bookings WHERE host_uid=?1 AND status='confirmed' AND starts_at>?2) AS upcoming_count, " +
    "(SELECT COALESCE(SUM(expected_host_net_paise),0) FROM hf_bookings WHERE host_uid=?1 " +
    "AND status IN ('confirmed','starting','active','settling') AND settlement_status='held') AS expected, " +
    "(SELECT MIN(starts_at) FROM hf_bookings WHERE host_uid=?1 AND status='confirmed' AND starts_at>?2) AS next_start",
  ).bind(auth.uid, now).first<{ upcoming_count: number; expected: number; next_start: number | null }>();
  const next = summary?.next_start == null ? null : await env.DB_META.prepare("SELECT * FROM hf_bookings WHERE host_uid=?1 AND status='confirmed' AND starts_at=?2 ORDER BY id LIMIT 1")
    .bind(auth.uid, summary.next_start).first<BookingRow>();
  return json({ summary: {
    upcomingCount: Number(summary?.upcoming_count ?? 0),
    expectedHostNetPaise: Number(summary?.expected ?? 0),
    nextBooking: next ? bookingPublic(next, "host") : null,
  } }, 200, { "cache-control": "private, no-store" });
}

export async function hfBookingsRoute(req: Request, env: Env): Promise<Response | null> {
  const path = new URL(req.url).pathname;
  if (path === "/api/hosts/me/availability") {
    if (req.method !== "GET" && req.method !== "PUT") return err(405, "method_not_allowed");
    try { return await scheduleRoute(req, env); } catch { return err(500, "availability_unavailable"); }
  }
  const publicMatch = path.match(/^\/api\/hf\/hosts\/([a-z0-9-]{3,40})\/availability$/);
  if (publicMatch) {
    if (req.method !== "GET") return err(405, "method_not_allowed");
    try { return await publicAvailability(req, env, publicMatch[1]); } catch { return err(500, "availability_unavailable"); }
  }
  if (path === "/api/hf/bookings/quote") {
    if (req.method !== "POST") return err(405, "method_not_allowed");
    try { return await quoteRoute(req, env); } catch { return err(500, "booking_unavailable"); }
  }
  if (path === "/api/hf/bookings") {
    try {
      if (req.method === "POST") return await confirmRoute(req, env);
      if (req.method === "GET") return await listRoute(req, env);
      return err(405, "method_not_allowed");
    } catch { return err(500, "booking_unavailable"); }
  }
  if (path === "/api/hosts/me/bookings/summary" || path === "/api/hf/bookings/summary") {
    if (req.method !== "GET") return err(405, "method_not_allowed");
    try { return await hostSummaryRoute(req, env); } catch { return err(500, "booking_unavailable"); }
  }
  const bookingMatch = path.match(/^\/api\/hf\/bookings\/([a-f0-9-]{36})(?:\/(cancel|start))?$/i);
  if (bookingMatch) {
    try {
      if (bookingMatch[2]) {
        if (req.method !== "POST") return err(405, "method_not_allowed");
        return bookingMatch[2] === "start"
          ? await startBookingRoute(req, env, bookingMatch[1])
          : await cancelRoute(req, env, bookingMatch[1]);
      }
      if (req.method !== "GET") return err(405, "method_not_allowed");
      return await detailRoute(req, env, bookingMatch[1]);
    } catch { return err(500, "booking_unavailable"); }
  }
  return null;
}
