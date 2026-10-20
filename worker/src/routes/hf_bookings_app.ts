// [HF-WIRE-8] Reels-app adapter over the rule-based bookings router (hf_bookings.ts). Whole thing sits behind hfBookingsEnabled (index.ts).
//   GET/PUT /api/hf/hosts/me/availability   day -> {open, slots[]} in IST (stored as dated "available" exceptions of hf_availability_schedules)
//   GET/PUT /api/hf/hosts/me/rate           influencer rate (+ GET ?rate=N previews "You get about Rs y a minute" by the server rule)
//   GET     /api/hf/hosts/:slug/slots       free slots only, from/to = IST dates
//   POST    /api/hf/bookings {hostSlug,startAt,note?}   quote + confirm in one step (10 min x rate held)
//   GET     /api/hf/bookings?role=fan|host&from=&to=&day=   handles only, never numbers
//   DELETE  /api/hf/bookings/:id            fan: free until 1 h before (any time while the booking is still waiting for approval); host: always refunds the fan
//   [HF-BOOK-APPROVE-BE] flag hfBookingApprovalEnabled (Specs/PLAN-2026-10-20-HF-BOOKING-APPROVAL.md §9b):
//   POST    /api/hf/bookings/:id/accept | /decline {reason?}      influencer decides a pending_approval booking (decline = full refund to the wallet)
//   GET/PUT /api/hf/hosts/me/booking-settings  {approval:'manual'|'auto', openAlerts}
// The old routes (quote/confirm/POST cancel, role=customer|host with ISO bounds) are untouched and still serve the web dashboard.
import type { Env } from "../types";
import { isFail, requireUser } from "../authz";
import { json } from "../util";
import { BRAND } from "../lib/brand";
import { readConfig } from "./config";
import { verifiedWhatsAppNumber } from "../lib/whatsapp_notify";
import { callerHandle } from "../lib/hf_call_math";
import { contactLeak, PRICE_MAX, PRICE_MIN } from "../lib/hf_options";
import { parseIstDate } from "../lib/hf_ist";
import {
  CREATOR_MAX_RUPEES, CREATOR_MIN_RUPEES, creatorCallSplit, creatorSnapshotFor, isCreatorCategory, validCreatorRate,
} from "../lib/hf_creator_pricing";
import { readHfStdPlan, readHfTokenConfig } from "../lib/hf_token_config";
import { callSplit, chargePaise, stdSplit } from "../lib/hf_token_math";
import {
  isCalendarDate, localDateAndMinute, slotsForDate, slotsForRange, isBookingDateRangeWithinHorizon,
  type HfBookingException, type HfBookingSchedule,
} from "../lib/hf_booking_availability";
import {
  acquireHfScheduleWriteLock, getHfBookingSchedule, listHfBusyIntervals, releaseHfScheduleWriteLock, saveHfBookingSchedule,
} from "../lib/hf_booking_store";
import {
  FAN_CANCEL_RULE_TEXT, FAN_FREE_CANCEL_MS, FAN_TOO_LATE_TEXT, cancelRoute, confirmRoute, loadHostPricing, quoteRoute,
  startBookingCore, type BookingRow, type HfHostPricingRow,
} from "./hf_bookings";
import { pricingStd, readInfluencerRate } from "../lib/hf_influencer_rate"; // [HF-WIRE-18]
import { track } from "../hooks";
import {
  type Defer, TOO_SOON_TEXT, acceptPending, approvalOn, approvalText, countdown, declinePending, emitBookingEvent, hostApprovalMode, hostTopics, notifyBooking,
  topicRef,
} from "../lib/hf_booking_approval"; // [HF-BOOK-APPROVE-BE]

export const APP_TZ = "Asia/Kolkata";
export const APP_MINUTES = 10;           // every booking is a 10-minute call (HF-REEL-19)
export const APP_HORIZON_DAYS = 21;      // 21 dates x up to 14 hourly chips stays under the 366-exception cap
const APP_MIN_NOTICE = 60;               // a booking must be made at least 1 h ahead, so a fan can always cancel free right after booking
const MAX_SLOTS_PER_DAY = 14;
const MAX_EXCEPTIONS = 366;
const ACTIVE = "('confirmed','pending_approval','starting','active')"; // [HF-BOOK-APPROVE-BE] a pending booking still blocks its slot
const err = (status: number, error: string, extra: Record<string, unknown> = {}) => json({ error, ...extra }, status);
const NOSTORE = { "cache-control": "private, no-store" };

/** Hourly chips the influencer can toggle, 09:00 .. 22:00 (24 h, IST). The app prints them as 9:00 am .. 10:00 pm. */
export const SLOT_CHOICES: string[] = Array.from({ length: 14 }, (_, i) => `${String(9 + i).padStart(2, "0")}:00`);

const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
function parseHhmm(v: unknown): number | null {
  const m = typeof v === "string" ? /^(\d{2}):(\d{2})$/.exec(v) : null;
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59 || mi % 5 !== 0) return null;
  const total = h * 60 + mi;
  return total <= 1430 ? total : null;
}
function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  const text = await req.text().catch(() => "");
  if (!text || text.length > 40_000) return null;
  try {
    const b: unknown = JSON.parse(text);
    return b && typeof b === "object" && !Array.isArray(b) ? b as Record<string, unknown> : null;
  } catch { return null; }
}
const rupees = (paise: number) => `₹${(paise / 100).toFixed(paise % 100 === 0 ? 0 : 2)}`;
const label = (ms: number) => new Date(ms).toLocaleString("en-IN", {
  timeZone: APP_TZ, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true,
});

// ───────────────────────────── rate ─────────────────────────────
type HostRateRow = { uid: string; slug: string | null; status: string; category: string; price_per_min: number };

export async function rateInfo(env: Env, host: { category: string; price_per_min: number }, previewRate?: number) {
  const cfg = (await readConfig(env).catch(() => ({}))) as unknown as Record<string, unknown>;
  const creator = isCreatorCategory(host.category);
  const infRate = readInfluencerRate(cfg); // [HF-WIRE-18] HF-REEL-37
  const std = pricingStd(readHfStdPlan(cfg), cfg);
  const fixed = std.enabled && !creator;
  const min = creator ? CREATOR_MIN_RUPEES : infRate.on ? infRate.minRupees : PRICE_MIN;
  const max = creator ? CREATOR_MAX_RUPEES : PRICE_MAX;
  const rate = previewRate ?? Number(host.price_per_min);
  let hostPaise = 0;
  try {
    if (creator) hostPaise = validCreatorRate(rate) ? creatorCallSplit(creatorSnapshotFor(host.category as "influencer" | "celebrity", rate), 60).hostPaise : 0;
    else if (fixed) hostPaise = stdSplit({ tariff: std.tariff, billableSeconds: 60, hostPaisePerMin: std.hostPaisePerMin, phoneCostPaisePerMin: std.phoneCostPaisePerMin }).hostPaise;
    else {
      const tk = readHfTokenConfig(cfg);
      hostPaise = callSplit({ ratePaise: rate * 100, billableSeconds: 60, callCostPaisePerMin: tk.callCostPaisePerMin, hostShareBps: tk.hostShareBps }).hostPaise;
    }
  } catch { hostPaise = 0; }
  return {
    ratePerMin: rate, minRate: min, maxRate: max, editable: !fixed,
    ...(fixed ? { fixedMessage: `${BRAND.name} sets one rate for everyone right now, so you can't change yours.` } : {}),
    hostGetsPerMinPaise: hostPaise, platformPerMinPaise: Math.max(0, rate * 100 - hostPaise),
    holdPaise: rate * 100 * APP_MINUTES,
  };
}

async function hostOf(env: Env, uid: string): Promise<HostRateRow | null> {
  return await env.DB_META.prepare("SELECT uid,slug,status,category,price_per_min FROM hf_hosts WHERE uid=?1").bind(uid).first<HostRateRow>();
}

async function rateRoute(req: Request, env: Env): Promise<Response> {
  const auth = await requireUser(req, env);
  if (isFail(auth)) return err(auth.status, auth.error);
  const host = await hostOf(env, auth.uid);
  if (!host) return err(404, "host_not_found");
  const current = await rateInfo(env, host);
  if (req.method === "GET") {
    const raw = new URL(req.url).searchParams.get("rate");
    if (raw == null) return json({ rate: current }, 200, NOSTORE);
    const n = Number(raw);
    if (!Number.isInteger(n) || n < current.minRate || n > current.maxRate) return err(400, "invalid_rate", { min: current.minRate, max: current.maxRate });
    return json({ rate: await rateInfo(env, host, n) }, 200, NOSTORE);
  }
  if (!current.editable) return err(409, "rate_fixed", { message: current.fixedMessage });
  const body = await readBody(req);
  const n = body?.pricePerMin;
  if (typeof n !== "number" || !Number.isInteger(n) || n < current.minRate || n > current.maxRate) {
    return err(400, "invalid_rate", { min: current.minRate, max: current.maxRate, message: `Pick a whole number from ₹${current.minRate} to ₹${current.maxRate} a minute.` });
  }
  await env.DB_META.prepare("UPDATE hf_hosts SET price_per_min=?1 WHERE uid=?2").bind(n, auth.uid).run();
  return json({ rate: await rateInfo(env, { ...host, price_per_min: n }) }, 200, NOSTORE);
}

// ───────────────────────────── availability ─────────────────────────────
type DayMap = Map<string, Set<number>>;

function baseSchedule(version: number, exceptions: HfBookingException[]): HfBookingSchedule {
  return {
    timezone: APP_TZ, version, durationsMinutes: [APP_MINUTES], slotIntervalMinutes: APP_MINUTES, bufferMinutes: 0,
    minNoticeMinutes: APP_MIN_NOTICE, horizonDays: APP_HORIZON_DAYS, rules: [], exceptions,
  };
}

/** Whatever the stored schedule is (app-made or rule-based), the dated 10-minute starts it opens, per IST date. */
export function materialize(schedule: HfBookingSchedule, now: number): DayMap {
  const out: DayMap = new Map();
  if (schedule.version === 0) return out;
  const today = localDateAndMinute(now, schedule.timezone).date;
  const open = { ...schedule, minNoticeMinutes: 0 };
  for (let i = 0; i < schedule.horizonDays; i++) {
    const date = addDays(today, i);
    const slots = slotsForDate(open, date, APP_MINUTES, [], now);
    if (slots.length) out.set(date, new Set(slots.map((s) => s.localStartMin)));
  }
  return out;
}

function toExceptions(days: DayMap): HfBookingException[] {
  const out: HfBookingException[] = [];
  for (const date of [...days.keys()].sort()) {
    const mins = [...days.get(date)!].sort((a, b) => a - b);
    let start = mins[0], prev = mins[0];
    for (let i = 1; i <= mins.length; i++) {
      const m = mins[i];
      if (m !== undefined && m === prev + APP_MINUTES) { prev = m; continue; }
      out.push({ date, startMin: start, endMin: prev + APP_MINUTES, status: "available" });
      start = m; prev = m;
    }
  }
  return out;
}

async function bookedSlots(env: Env, hostUid: string, now: number, tz: string): Promise<Record<string, string[]>> {
  const rows = (await env.DB_META.prepare(
    `SELECT starts_at FROM hf_bookings WHERE host_uid=?1 AND status IN ${ACTIVE} AND settlement_status='held' AND ends_at>?2 ORDER BY starts_at LIMIT 500`,
  ).bind(hostUid, now).all<{ starts_at: number }>().catch(() => null))?.results ?? [];
  const out: Record<string, string[]> = {};
  for (const r of rows) {
    const l = localDateAndMinute(Number(r.starts_at), tz);
    (out[l.date] ??= []).push(hhmm(l.minute));
  }
  return out;
}

async function availabilityPayload(env: Env, host: HostRateRow, schedule: HfBookingSchedule, now: number) {
  const map = materialize(schedule, now);
  const days: Record<string, { open: boolean; slots: string[] }> = {};
  for (const [date, mins] of [...map.entries()].sort()) days[date] = { open: true, slots: [...mins].sort((a, b) => a - b).map(hhmm) };
  return {
    timezone: schedule.timezone, version: schedule.version, minutes: APP_MINUTES, horizonDays: APP_HORIZON_DAYS,
    today: localDateAndMinute(now, APP_TZ).date, slotChoices: SLOT_CHOICES, days,
    booked: await bookedSlots(env, host.uid, now, schedule.timezone),
    rate: await rateInfo(env, host),
  };
}

async function availabilityRoute(req: Request, env: Env): Promise<Response> {
  const auth = await requireUser(req, env);
  if (isFail(auth)) return err(auth.status, auth.error);
  const host = await hostOf(env, auth.uid);
  if (!host) return err(404, "host_not_found");
  const now = Date.now();
  const current = await getHfBookingSchedule(env, auth.uid);
  if (req.method === "GET") return json(await availabilityPayload(env, host, current, now), 200, NOSTORE);

  const body = await readBody(req);
  const incoming = body?.days;
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) return err(400, "invalid_availability", { message: "Send days as { 'YYYY-MM-DD': { open, slots } }." });
  if (body!.expectedVersion !== undefined && body!.expectedVersion !== current.version) {
    return err(409, "schedule_changed", { message: "Your availability changed somewhere else. Reload it and try again." });
  }
  const today = localDateAndMinute(now, APP_TZ).date;
  const last = addDays(today, APP_HORIZON_DAYS - 1);
  const next = materialize(current, now);
  for (const [date, raw] of Object.entries(incoming as Record<string, unknown>)) {
    if (!isCalendarDate(date) || date < today || date > last) return err(400, "invalid_day", { date, message: `You can set dates from today up to ${APP_HORIZON_DAYS} days ahead.` });
    const d = raw as { open?: unknown; slots?: unknown } | null;
    if (!d || typeof d !== "object" || typeof d.open !== "boolean") return err(400, "invalid_day", { date });
    if (!d.open) { next.delete(date); continue; }
    if (!Array.isArray(d.slots) || d.slots.length > MAX_SLOTS_PER_DAY) return err(400, "invalid_slots", { date, message: `Pick up to ${MAX_SLOTS_PER_DAY} times a day.` });
    const mins = new Set<number>();
    for (const s of d.slots) {
      const m = parseHhmm(s);
      if (m == null) return err(400, "invalid_slots", { date, slot: s });
      mins.add(m);
    }
    if (mins.size) next.set(date, mins); else next.delete(date);
  }
  // A slot someone has booked can't be closed until that booking is cancelled.
  const rows = (await env.DB_META.prepare(
    `SELECT id,starts_at FROM hf_bookings WHERE host_uid=?1 AND status IN ('confirming','confirmed','pending_approval','starting','active','settling') AND ends_at>?2 ORDER BY starts_at LIMIT 500`,
  ).bind(auth.uid, now).all<{ id: string; starts_at: number }>()).results ?? [];
  // [HF-BOOK-APPROVE-QA-1] A booked (or pending) time always stays open: it is shown locked in the app, so the influencer never
  // sends it, and refusing the whole save made every edit fail once any booking sat outside her saved times.
  for (const r of rows) {
    const l = localDateAndMinute(Number(r.starts_at), APP_TZ);
    if (l.date < today) continue;
    const set = next.get(l.date) ?? new Set<number>();
    set.add(l.minute);
    next.set(l.date, set);
  }
  const exceptions = toExceptions(next);
  if (exceptions.length > MAX_EXCEPTIONS) return err(400, "too_many_slots", { message: "That is too many separate times. Keep fewer times open." });
  const schedule = baseSchedule(current.version, exceptions);
  const token = await acquireHfScheduleWriteLock(env, auth.uid, current.version, now);
  if (!token) return err(409, "schedule_changed", { message: "Your availability changed somewhere else. Reload it and try again." });
  try {
    const version = await saveHfBookingSchedule(env, auth.uid, current.version, token, schedule);
    if (version === null) return err(409, "schedule_changed", { message: "Your availability changed somewhere else. Reload it and try again." });
    return json(await availabilityPayload(env, host, { ...schedule, version }, now), 200, NOSTORE);
  } finally {
    await releaseHfScheduleWriteLock(env, auth.uid, token).catch(() => undefined);
  }
}

async function slotsRoute(req: Request, env: Env, slug: string): Promise<Response> {
  const host = await env.DB_META.prepare("SELECT uid,slug,status,category,price_per_min,women_lane,lgbtq_lane FROM hf_hosts WHERE slug=?1")
    .bind(slug).first<HfHostPricingRow>();
  if (!host || host.status !== "live") return err(404, "host_not_found");
  const schedule = await getHfBookingSchedule(env, host.uid);
  const now = Date.now();
  const today = localDateAndMinute(now, schedule.timezone).date;
  const lastAllowed = addDays(today, schedule.horizonDays - 1);
  const url = new URL(req.url);
  let from = url.searchParams.get("from") ?? today;
  let to = url.searchParams.get("to") ?? addDays(from, 13);
  if (!isCalendarDate(from) || !isCalendarDate(to) || to < from) return err(400, "invalid_date_range");
  if (from < today) from = today;
  if (to > lastAllowed) to = lastAllowed;
  const pricing = await loadHostPricing(env, host).catch(() => null);
  const holdPaise = pricing ? chargePaise(pricing.price, APP_MINUTES * 60) : Number(host.price_per_min) * 100 * APP_MINUTES;
  // [HF-BOOK-APPROVE-BE] flag on: the influencer's topics (for the fan's picker) and whether bookings wait for approval
  const approval = await approvalOn(env);
  const head = {
    timezone: schedule.timezone, minutes: APP_MINUTES, ratePerMin: Number(host.price_per_min), holdPaise,
    today, lastDate: lastAllowed,
    ...(approval ? { topics: await hostTopics(env, host.uid), approvalMode: await hostApprovalMode(env, host.uid) } : {}),
  };
  if (schedule.version === 0 || to < from || !schedule.durationsMinutes.includes(APP_MINUTES) || !isBookingDateRangeWithinHorizon(schedule, from, to, now)) {
    return json({ ...head, days: {}, openDates: [] }, 200, { "cache-control": "public, max-age=15" });
  }
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  const busy = await listHfBusyIntervals(env, host.uid, Date.UTC(fy, fm - 1, fd) - 2 * 86_400_000, Date.UTC(ty, tm - 1, td + 1) + 2 * 86_400_000);
  const days: Record<string, string[]> = {};
  for (const s of slotsForRange(schedule, from, to, APP_MINUTES, busy, now)) (days[s.localDate] ??= []).push(hhmm(s.localStartMin));
  return json({ ...head, days, openDates: Object.keys(days).sort() }, 200, { "cache-control": "public, max-age=15" });
}

// ───────────────────────────── booking ─────────────────────────────
const ERROR_TEXT: Record<string, string> = {
  slot_unavailable: "Someone just took that time. Please pick another.",
  host_unavailable: "This influencer can't take bookings right now.",
  not_verified: "Please verify your WhatsApp number first.",
  account_closing: "This account is being closed.",
  debt_open: "Please clear your pending balance before booking.",
  booking_payment_unavailable: "Booking payments are not open yet.",
  availability_unavailable: "This influencer has not opened any times yet.",
  invalid_duration: "This influencer has not opened any times yet.",
  slot_out_of_bounds: "That date is too far ahead.",
  quote_expired: "That took too long. Please pick the time again.",
  slot_or_wallet_changed: "Someone just took that time, or your wallet changed. Please try again.",
  too_soon_for_approval: TOO_SOON_TEXT, // [HF-BOOK-APPROVE-BE]
  bad_topic: "Pick one of the topics this influencer offers.",
};

async function passErr(res: Response): Promise<Response> {
  const b = await res.json().catch(() => ({})) as Record<string, unknown>;
  const code = String(b.error ?? "booking_unavailable");
  return json({ ...b, error: code, message: b.message ?? ERROR_TEXT[code] ?? "We couldn't book that. Please try again." }, res.status);
}

function innerReq(req: Request, path: string, body: Record<string, unknown>, extra: Record<string, string> = {}): Request {
  const h = new Headers(req.headers);
  h.set("content-type", "application/json");
  h.delete("content-length");
  for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return new Request(new URL(path, req.url), { method: "POST", headers: h, body: JSON.stringify(body) });
}

async function queueWhatsApp(env: Env, bookingId: string, uid: string, kind: string, tag: string, text: string): Promise<void> {
  try {
    const e164 = await verifiedWhatsAppNumber(env, uid);
    if (!e164) return;
    const now = Date.now();
    await env.DB_META.prepare(
      `INSERT OR IGNORE INTO whatsapp_outbox (checkout_id, uid, listing_id, kind, url_hash, e164, message, status, attempts, created_at, updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,'queued',0,?8,?8)`,
    ).bind(`hfb:${bookingId}:${uid}`, uid, bookingId, kind, tag, e164, text, now).run();
  } catch { /* a missed WhatsApp never fails a booking */ }
}

type JoinRow = BookingRow & {
  host_slug: string | null; host_name: string | null; fan_name: string | null;
  topic_slug?: string | null; approval_deadline?: number | null; cancel_reason?: string | null;
};

/** [HF-BOOK-APPROVE-BE] One plain-English line for the booking's state, in the viewer's own words. */
export function statusText(row: JoinRow, role: "fan" | "host", now: number): string {
  const host = (row.host_name ?? "").trim() || "the influencer";
  const fan = callerHandle(row.fan_name);
  const hold = rupees(Number(row.reserved_paise));
  switch (row.status) {
    case "pending_approval": {
      const ms = row.approval_deadline == null ? null : Number(row.approval_deadline) - now;
      const left = ms == null ? "" : ms <= 0 ? " — auto-cancels any moment now" : ` — auto-cancels in ${countdown(ms)}`;
      return role === "fan" ? `Waiting for ${host} to accept${left}` : `${fan} is waiting for you to accept${left}`;
    }
    case "confirmed": return role === "fan" ? `Confirmed with ${host}` : `Confirmed — ${fan} will call you`;
    case "starting": case "active": return "Call in progress";
    case "settling": return "Finishing up";
    case "completed": return "Completed";
    case "failed": return role === "fan" ? `The call didn't happen — ${hold} is back in your wallet` : "Missed — the call didn't happen";
    case "cancelled":
      switch (row.cancel_reason) {
        case "declined": return role === "fan" ? `${host} couldn't take this booking — ${hold} is back in your wallet` : "You declined this booking";
        case "not_accepted_24h": return role === "fan" ? `Not accepted in time — ${hold} is back in your wallet` : "Cancelled — not accepted within 24 hours";
        case "fan": return role === "fan" ? `You cancelled — ${hold} is back in your wallet` : `${fan} cancelled`;
        case "host": return role === "fan" ? `${host} cancelled — ${hold} is back in your wallet` : "You cancelled — the fan was refunded";
        default: return role === "fan" ? `Cancelled — ${hold} is back in your wallet` : "Cancelled";
      }
    default: return row.status;
  }
}

function shape(row: JoinRow, role: "fan" | "host", now: number, note?: string, approval = false) {
  const start = Number(row.starts_at);
  const l = localDateAndMinute(start, APP_TZ);
  const held = row.status === "confirmed" && row.settlement_status === "held";
  const pending = row.status === "pending_approval" && row.settlement_status === "held";
  const freeUntil = start - FAN_FREE_CANCEL_MS;
  const common = {
    id: row.id, status: row.status, startAt: new Date(start).toISOString(), endAt: new Date(Number(row.ends_at)).toISOString(),
    day: l.date, time: hhmm(l.minute), minutes: APP_MINUTES, holdPaise: Number(row.reserved_paise),
  };
  // flag on: the additive fields of the §9b contract (flag off: the response is exactly what it always was)
  const extra = approval ? {
    approvalDeadline: row.status === "pending_approval" && row.approval_deadline != null ? new Date(Number(row.approval_deadline)).toISOString() : null,
    topic: topicRef(row.topic_slug),
    cancelReason: row.status === "cancelled" ? (row.cancel_reason ?? null) : null,
    statusText: statusText(row, role, now),
  } : {};
  if (role === "fan") {
    const canCancel = (held && now < freeUntil) || pending; // waiting for approval: the fan can always withdraw, full refund
    return {
      ...common, hostSlug: row.host_slug, hostName: row.host_name ?? "Influencer",
      canCancel, freeCancelUntil: new Date(freeUntil).toISOString(), cancelRule: pending ? "You can cancel any time while you wait. Your full hold comes back." : FAN_CANCEL_RULE_TEXT,
      ...(held && !canCancel ? { cancelBlockedText: FAN_TOO_LATE_TEXT } : {}),
      ...extra,
    };
  }
  const open = pending && (row.approval_deadline == null || Number(row.approval_deadline) > now);
  return {
    ...common, fanHandle: callerHandle(row.fan_name), note: note ?? "",
    canCancel: held, expectedNetPaise: Number(row.expected_host_net_paise),
    cancelRule: "If you cancel, the fan's hold is refunded in full.",
    ...extra,
    ...(approval ? { canAccept: open, canDecline: open } : {}),
  };
}

async function createBooking(req: Request, env: Env, body: Record<string, unknown>, defer?: Defer): Promise<Response> {
  const auth = await requireUser(req, env);
  if (isFail(auth)) return err(auth.status, auth.error);
  const slug = typeof body.hostSlug === "string" ? body.hostSlug.trim().toLowerCase() : "";
  const ms = typeof body.startAt === "number" ? body.startAt : typeof body.startAt === "string" ? Date.parse(body.startAt) : NaN;
  if (!/^[a-z0-9-]{3,40}$/.test(slug) || !Number.isFinite(ms)) return err(400, "invalid_booking", { message: "Pick a host and a time." });
  let note = "";
  if (body.note != null) {
    if (typeof body.note !== "string" || body.note.trim().length > 200) return err(400, "invalid_note", { message: "Keep the note under 200 characters." });
    note = body.note.trim();
    if (note && contactLeak(note)) return err(400, "note_contact", { message: "Please don't put phone numbers or links in the note." });
  }
  // [HF-BOOK-APPROVE-BE] optional topic: one of this influencer's own topics (ignored entirely while the flag is off)
  const approval = await approvalOn(env);
  let topic: string | null = null;
  if (approval && body.topic != null && body.topic !== "") {
    topic = typeof body.topic === "string" ? body.topic.trim() : "";
    const h = await env.DB_META.prepare("SELECT uid FROM hf_hosts WHERE slug=?1").bind(slug).first<{ uid: string }>().catch(() => null);
    if (h && !(await hostTopics(env, h.uid)).some((t) => t.slug === topic)) return err(400, "bad_topic", { message: ERROR_TEXT.bad_topic });
  }
  const quoteRes = await quoteRoute(innerReq(req, "/api/hf/bookings/quote", { hostSlug: slug, startUtc: new Date(ms).toISOString(), durationMinutes: APP_MINUTES }), env);
  if (quoteRes.status !== 201) return passErr(quoteRes);
  const { quote } = await quoteRes.json() as { quote: { id: string; reservedPaise: number } };
  const confirmRes = await confirmRoute(innerReq(req, "/api/hf/bookings", { quoteId: quote.id, policyAccepted: true, ...(topic ? { topicSlug: topic } : {}) }, { "Idempotency-Key": `app-${quote.id}` }), env);
  if (confirmRes.status === 402) {
    const b = await confirmRes.json().catch(() => ({})) as Record<string, unknown>;
    const need = Number(b.reservedPaise ?? quote.reservedPaise);
    return json({ ...b, error: "low_balance", needPaise: need, needRupees: need / 100,
      message: `You need ${rupees(need)} in your wallet to hold this booking. Please top up.` }, 402);
  }
  if (confirmRes.status !== 200 && confirmRes.status !== 201) return passErr(confirmRes);
  const { booking } = await confirmRes.json() as { booking: { id: string } };
  const row = await env.DB_META.prepare(
    `SELECT b.*, h.slug AS host_slug, h.display_name AS host_name, u.display_name AS fan_name
       FROM hf_bookings b LEFT JOIN hf_hosts h ON h.uid=b.host_uid LEFT JOIN users u ON u.uid=b.customer_uid WHERE b.id=?1 AND b.customer_uid=?2`,
  ).bind(booking.id, auth.uid).first<JoinRow>();
  if (!row) return err(500, "booking_unavailable");
  if (note) {
    await env.DB_META.prepare("INSERT OR IGNORE INTO hf_booking_notes (booking_id,fan_uid,host_uid,note,created_at) VALUES (?1,?2,?3,?4,?5)")
      .bind(row.id, auth.uid, row.host_uid, note, Date.now()).run().catch(() => undefined);
  }
  if (approval) {
    // Flag on: the request / accepted messages (push + WhatsApp + email) replace the old two WhatsApp lines.
    const pending = row.status === "pending_approval";
    void emitBookingEvent(env, "hf_booking_requested", auth.uid, row.host_uid, row.customer_uid, {
      booking_id: row.id, mode: pending ? "manual" : "auto", amount_paise: Number(row.reserved_paise), topic: row.topic_slug ?? null,
    });
    const msgs = notifyBooking(env, pending ? "request" : "accepted", row); // [HF-BOOK-APPROVE-QA-1] after the response when possible
    if (defer) defer(msgs.catch(() => undefined)); else await msgs;
    const name = row.host_name ?? "your influencer";
    return json({
      booking: shape(row, "fan", Date.now(), note, true), needsApproval: pending,
      approvalText: pending ? approvalText(name, Number(row.reserved_paise)) : `Confirmed. ${name} will take your call.`,
    }, 201, NOSTORE);
  }
  const when = label(Number(row.starts_at));
  const hold = rupees(Number(row.reserved_paise));
  await queueWhatsApp(env, row.id, row.customer_uid, "hf_booking_confirm", "c",
    `${BRAND.name}: booked! Your call with ${row.host_name ?? "your influencer"} is on ${when} IST. ${hold} is held; you pay only for the minutes you talk and the rest comes back. Cancel free until 1 hour before. Your number stays hidden.`);
  await queueWhatsApp(env, row.id, row.host_uid, "hf_booking_confirm", "c",
    `${BRAND.name}: new booking. ${callerHandle(row.fan_name)} booked a ${APP_MINUTES}-minute call with you on ${when} IST. We will ring you first at that time.`);
  return json({ booking: shape(row, "fan", Date.now(), note) }, 201, NOSTORE);
}

function bound(v: string | null, endOfDay: boolean): number | null | undefined {
  if (v == null || v === "") return undefined;
  const d = parseIstDate(v);
  if (d != null) return endOfDay ? d + 86_400_000 : d;
  if (/^\d{4}-\d{2}-\d{2}T/.test(v)) { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }
  return null;
}

async function listBookings(req: Request, env: Env, role: "fan" | "host"): Promise<Response> {
  const auth = await requireUser(req, env);
  if (isFail(auth)) return err(auth.status, auth.error);
  const url = new URL(req.url);
  const now = Date.now();
  let fromAt = bound(url.searchParams.get("from"), false);
  let toAt = bound(url.searchParams.get("to"), true);
  const dayRaw = url.searchParams.get("day");
  if (dayRaw) {
    const d = parseIstDate(dayRaw);
    if (d == null) return err(400, "invalid_date_range");
    fromAt = d; toAt = d + 86_400_000;
  }
  if (fromAt === null || toAt === null || (fromAt !== undefined && toAt !== undefined && toAt <= fromAt)) return err(400, "invalid_date_range");
  if (role === "host") {
    const host = await hostOf(env, auth.uid);
    if (!host) return err(404, "host_not_found");
  }
  const col = role === "fan" ? "b.customer_uid" : "b.host_uid";
  // [HF-BOOK-APPROVE-BE] flag on: ?status=pending|upcoming|past (none = everything active, waiting-for-approval first). Flag off: the parameter is ignored.
  const approval = await approvalOn(env);
  const statusFilter = approval ? url.searchParams.get("status") : null;
  if (statusFilter != null && statusFilter !== "" && !["pending", "upcoming", "past"].includes(statusFilter)) return err(400, "invalid_status", { message: "Use status=pending, upcoming or past." });
  const values: unknown[] = [auth.uid];
  let where = ` WHERE ${col}=?1 AND b.status IN ${ACTIVE}`;
  if (statusFilter === "pending") where = ` WHERE ${col}=?1 AND b.status='pending_approval'`;
  else if (statusFilter === "upcoming") where = ` WHERE ${col}=?1 AND b.status IN ('confirmed','starting','active')`;
  else if (statusFilter === "past") where = ` WHERE ${col}=?1 AND b.status IN ('completed','cancelled','failed')`;
  if (statusFilter === "past") {
    if (fromAt !== undefined) { values.push(fromAt); where += ` AND b.ends_at>?${values.length}`; }
  } else { values.push(fromAt ?? now); where += ` AND b.ends_at>?${values.length}`; }
  if (toAt !== undefined) { values.push(toAt); where += ` AND b.starts_at<?${values.length}`; }
  const order = statusFilter === "past" ? "b.starts_at DESC, b.id" : approval ? "(b.status='pending_approval') DESC, b.starts_at, b.id" : "b.starts_at, b.id";
  const rows = (await env.DB_META.prepare(
    `SELECT b.*, h.slug AS host_slug, h.display_name AS host_name, u.display_name AS fan_name
       FROM hf_bookings b LEFT JOIN hf_hosts h ON h.uid=b.host_uid LEFT JOIN users u ON u.uid=b.customer_uid${where} ORDER BY ${order} LIMIT 200`,
  ).bind(...values).all<JoinRow>()).results ?? [];
  const notes = new Map<string, string>();
  if (role === "host" && rows.length) {
    const ids = rows.map((r) => r.id);
    const found = (await env.DB_META.prepare(`SELECT booking_id,note FROM hf_booking_notes WHERE booking_id IN (${ids.map((_, i) => `?${i + 1}`).join(",")})`)
      .bind(...ids).all<{ booking_id: string; note: string }>().catch(() => null))?.results ?? [];
    for (const n of found) notes.set(n.booking_id, n.note);
  }
  return json({ role, bookings: rows.map((r) => shape(r, role, now, notes.get(r.id), approval)) }, 200, NOSTORE);
}

async function deleteBooking(req: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireUser(req, env);
  if (isFail(auth)) return err(auth.status, auth.error);
  const row = await env.DB_META.prepare(
    `SELECT b.*, h.display_name AS host_name, u.display_name AS fan_name FROM hf_bookings b
       LEFT JOIN hf_hosts h ON h.uid=b.host_uid LEFT JOIN users u ON u.uid=b.customer_uid
      WHERE b.id=?1 AND (b.host_uid=?2 OR b.customer_uid=?2)`,
  ).bind(id, auth.uid).first<BookingRow & { host_name: string | null; fan_name: string | null }>();
  if (!row) return err(404, "booking_not_found");
  const role = row.host_uid === auth.uid ? "host" : "fan";
  const res = await cancelRoute(req, env, id, { fanCutoff: true });
  if (res.status !== 200) {
    const b = await res.json().catch(() => ({})) as Record<string, unknown>;
    const code = String(b.error ?? "booking_unavailable");
    return json({ ...b, error: code, message: b.message ?? (code === "booking_not_cancellable" ? "This booking can't be cancelled any more." : "We couldn't cancel that. Please try again.") }, res.status);
  }
  const hold = Number(row.reserved_paise);
  const when = label(Number(row.starts_at));
  if (role === "host") {
    await queueWhatsApp(env, id, row.customer_uid, "hf_booking_cancel", "x", `${BRAND.name}: ${row.host_name ?? "Your influencer"} cancelled your call on ${when} IST. Your hold of ${rupees(hold)} is back in your wallet.`);
  } else {
    await queueWhatsApp(env, id, row.host_uid, "hf_booking_cancel", "x", `${BRAND.name}: ${callerHandle(row.fan_name)} cancelled the call on ${when} IST.`);
  }
  return json({
    ok: true, bookingId: id, status: "cancelled", refunded: true, refundPaise: hold,
    message: role === "host" ? "Booking cancelled. The fan's hold was refunded in full." : `Booking cancelled. Your hold of ${rupees(hold)} is back in your wallet.`,
  }, 200, NOSTORE);
}

// ───────────────────────────── approval (flag hfBookingApprovalEnabled) ─────────────────────────────
const DECIDE_TEXT: Record<string, string> = {
  not_pending: "This booking is no longer waiting for you.",
  expired: "This booking was not accepted in time, so it was cancelled and the caller was refunded.",
  booking_hold_unavailable: "We couldn't release the hold right now. Please try again in a moment.",
};

async function loadJoined(env: Env, id: string): Promise<JoinRow | null> {
  return await env.DB_META.prepare(
    `SELECT b.*, h.slug AS host_slug, h.display_name AS host_name, u.display_name AS fan_name
       FROM hf_bookings b LEFT JOIN hf_hosts h ON h.uid=b.host_uid LEFT JOIN users u ON u.uid=b.customer_uid WHERE b.id=?1`,
  ).bind(id).first<JoinRow>();
}

async function decideRoute(req: Request, env: Env, id: string, action: "accept" | "decline", defer?: Defer): Promise<Response> {
  if (req.method !== "POST") return err(405, "method_not_allowed");
  const auth = await requireUser(req, env);
  if (isFail(auth)) return err(auth.status, auth.error);
  const host = await hostOf(env, auth.uid);
  if (!host) return err(404, "host_not_found");
  const out = action === "accept" ? await acceptPending(env, id, auth.uid, Date.now(), defer) : await declinePending(env, id, auth.uid, Date.now(), defer);
  if (!out.ok) {
    if (out.reason === "not_found") return err(404, "booking_not_found", { message: "We couldn't find that booking." });
    const code = out.reason === "hold_unavailable" ? "booking_hold_unavailable" : out.reason;
    return err(409, code, { message: DECIDE_TEXT[code] });
  }
  const row = await loadJoined(env, id);
  if (!row) return err(500, "booking_unavailable");
  const note = (await env.DB_META.prepare("SELECT note FROM hf_booking_notes WHERE booking_id=?1").bind(id).first<{ note: string }>().catch(() => null))?.note;
  const booking = shape(row, "host", Date.now(), note, true);
  return action === "accept"
    ? json({ ok: true, booking }, 200, NOSTORE)
    : json({ ok: true, refunded: true, refundPaise: Number(row.reserved_paise), booking }, 200, NOSTORE);
}

async function settingsRoute(req: Request, env: Env): Promise<Response> {
  const auth = await requireUser(req, env);
  if (isFail(auth)) return err(auth.status, auth.error);
  const host = await hostOf(env, auth.uid);
  if (!host) return err(404, "host_not_found");
  const read = async () => {
    const r = await env.DB_META.prepare("SELECT booking_approval,open_alerts FROM hf_hosts WHERE uid=?1").bind(auth.uid).first<{ booking_approval: string | null; open_alerts: number | null }>();
    return { approval: r?.booking_approval === "auto" ? "auto" : "manual", openAlerts: r?.open_alerts == null ? true : Number(r.open_alerts) !== 0 };
  };
  if (req.method === "GET") return json(await read(), 200, NOSTORE);
  const body = await readBody(req);
  const approvalIn = body?.approval, alertsIn = body?.openAlerts;
  if (!body || (approvalIn === undefined && alertsIn === undefined) ||
      (approvalIn !== undefined && approvalIn !== "manual" && approvalIn !== "auto") || (alertsIn !== undefined && typeof alertsIn !== "boolean")) {
    return err(400, "invalid_settings", { message: "Send approval as 'manual' or 'auto', and/or openAlerts as true or false." });
  }
  const before = await read();
  await env.DB_META.prepare("UPDATE hf_hosts SET booking_approval=COALESCE(?1,booking_approval), open_alerts=COALESCE(?2,open_alerts), updated_at=?3 WHERE uid=?4")
    .bind(approvalIn ?? null, alertsIn === undefined ? null : alertsIn ? 1 : 0, Date.now(), auth.uid).run();
  const after = await read();
  if (before.approval !== after.approval) void track(env, auth.uid, "hf_booking_mode_changed", BRAND.slug, { from: before.approval, to: after.approval }).catch(() => undefined);
  return json(after, 200, NOSTORE);
}

/** Cron: at the booked minute start the call (rings the influencer first, then the fan). Bounded; retried each tick until the booking ends. */
export async function runHfBookingAutoStart(env: Env, now = Date.now()): Promise<{ scanned: number; started: number; blocked: number }> {
  const out = { scanned: 0, started: 0, blocked: 0 };
  const rows = (await env.DB_META.prepare(
    `SELECT b.* FROM hf_bookings b WHERE b.status='confirmed' AND b.settlement_status='held' AND b.starts_at<=?1 AND b.ends_at>?1
       AND NOT EXISTS (SELECT 1 FROM hf_calls c WHERE c.booking_id=b.id) ORDER BY b.starts_at LIMIT 20`,
  ).bind(now).all<BookingRow>().catch(() => null))?.results ?? [];
  for (const row of rows) {
    out.scanned++;
    try {
      const r = await startBookingCore(env, row, null, now);
      if (r.status === 200 || r.status === 201) out.started++; else out.blocked++;
    } catch { out.blocked++; }
  }
  return out;
}

/** Which handler (if any) of this adapter owns the request. null = the older router's. */
async function pick(req: Request, env: Env, defer?: Defer): Promise<null | (() => Promise<Response>)> {
  const url = new URL(req.url);
  const p = url.pathname;
  const m = req.method;
  if (p === "/api/hf/hosts/me/availability") return async () => (m !== "GET" && m !== "PUT") ? err(405, "method_not_allowed") : availabilityRoute(req, env);
  if (p === "/api/hf/hosts/me/rate") return async () => (m !== "GET" && m !== "PUT") ? err(405, "method_not_allowed") : rateRoute(req, env);
  const sm = p.match(/^\/api\/hf\/hosts\/([a-z0-9-]{3,40})\/slots$/);
  if (sm) return async () => m !== "GET" ? err(405, "method_not_allowed") : slotsRoute(req, env, sm[1]);
  if (p === "/api/hf/bookings") {
    if (m === "POST") {
      const peek = await req.clone().json().catch(() => null) as Record<string, unknown> | null;
      if (peek && typeof peek === "object" && typeof peek.hostSlug === "string" && peek.startAt !== undefined) return () => createBooking(req, env, peek, defer);
      return null;
    }
    if (m === "GET") {
      const role = url.searchParams.get("role");
      if (role === "fan") return () => listBookings(req, env, "fan");
      if (role === "host" && (url.searchParams.get("shape") === "app" || url.searchParams.has("day") ||
          /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("from") ?? "") || /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("to") ?? ""))) {
        return () => listBookings(req, env, "host");
      }
    }
    return null;
  }
  const dm = p.match(/^\/api\/hf\/bookings\/([a-f0-9-]{36})$/i);
  if (dm && m === "DELETE") return () => deleteBooking(req, env, dm[1]);
  // [HF-BOOK-APPROVE-BE] flag off -> null, exactly as these paths were before (the older router answers 404)
  const am = p.match(/^\/api\/hf\/bookings\/([a-f0-9-]{36})\/(accept|decline)$/i);
  if (am && await approvalOn(env)) return () => decideRoute(req, env, am[1], am[2].toLowerCase() as "accept" | "decline", defer);
  if (p === "/api/hf/hosts/me/booking-settings" && await approvalOn(env)) return async () => (m !== "GET" && m !== "PUT") ? err(405, "method_not_allowed") : settingsRoute(req, env);
  return null;
}

/** Returns null for every path/shape that belongs to the older router. Dark (404) unless hfBookingsEnabled. */
export async function hfBookingsAppRoute(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response | null> {
  try {
    const defer: Defer | undefined = ctx ? (p) => ctx.waitUntil(p) : undefined;
    const handler = await pick(req, env, defer);
    if (!handler) return null;
    const cfg = (await readConfig(env).catch(() => null)) as unknown as Record<string, unknown> | null;
    if (cfg?.hfBookingsEnabled !== true) return new Response(null, { status: 404 });
    return await handler();
  } catch (e) {
    console.error("[hf-bookings-app] failed:", String(e));
    return err(500, "booking_unavailable");
  }
}
