// AvaBooking — Phase 5 (PHASE-05.md). Bookings list, policies + vacation mode
// (A3), the reschedule flow (A4), and the public join-info endpoint (A1).
//
//   GET  /api/booking/list?role=&when=            → my bookings (creator|buyer, upcoming|past)
//   GET/PUT /api/booking/policies                  → buffer/min-notice/max-per-day/vacation
//   POST /api/booking/:id/reschedule               → propose a new time (max 2 per booking)
//   POST /api/booking/reschedule/:id/respond       → { accept: true|false }
//   GET  /api/booking/reschedules?booking=         → pending proposals for a booking
//   GET  /api/join-info/:token                     → PUBLIC display data for avatok.ai/j/<token>
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { metaDb, metaSession } from "../db/shard";
import { track } from "../hooks";
import { notifyUser } from "../notify";
import { checkAvailability, loadPolicy, policyViolation } from "../cal/engine";
import { emailBookingConfirmed } from "../cal/emails";
import { verifyJoinToken } from "../cal/ics";
import { gcalExport } from "../cal/gcal";

const APP = "avabooking";

async function nameOf(env: Env, uid: string): Promise<string> {
  try {
    const r = await metaDb(env).prepare("SELECT name, handle FROM profiles WHERE npub=?1 OR clerk_user_id=?1").bind(uid).first<any>();
    return r?.name || r?.handle || "an AvaTOK user";
  } catch { return "an AvaTOK user"; }
}

// ---------------------------------------------------------------------------
// GET /api/booking/list?role=creator|buyer|all&when=upcoming|past
// ---------------------------------------------------------------------------
export async function listBookings(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const u = new URL(req.url);
  const role = u.searchParams.get("role") || "all";
  const when = u.searchParams.get("when") || "upcoming";
  const now = Date.now();
  const who = role === "creator" ? "creator_id=?1" : role === "buyer" ? "buyer_id=?1" : "(creator_id=?1 OR buyer_id=?1)";
  const time = when === "past" ? "ends_at <= ?2" : "ends_at > ?2";
  const order = when === "past" ? "DESC" : "ASC";
  const rs = await metaSession(env).prepare(
    `SELECT b.id, b.creator_id, b.buyer_id, b.listing_id, b.kind, b.starts_at, b.ends_at, b.price, b.status,
            b.reschedule_count, b.created_at,
            (SELECT title FROM calendar_events e WHERE e.booking_id=b.id LIMIT 1) AS title
       FROM bookings b WHERE ${who} AND ${time} ORDER BY b.starts_at ${order} LIMIT 100`,
  ).bind(ctx.uid, now).all();
  return json({ bookings: rs.results ?? [] });
}

// ---------------------------------------------------------------------------
// Policies + vacation mode (A3)
// ---------------------------------------------------------------------------
export async function getPolicies(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  return json({ policy: await loadPolicy(env, ctx.uid) });
}

export async function putPolicies(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  const cur = await loadPolicy(env, ctx.uid);
  const buffer = Math.min(240, Math.max(0, Math.trunc(Number(b.buffer_min ?? cur.buffer_min))));
  const notice = Math.min(10080, Math.max(0, Math.trunc(Number(b.min_notice_min ?? cur.min_notice_min))));
  const maxDay = Math.min(48, Math.max(1, Math.trunc(Number(b.max_per_day ?? cur.max_per_day))));
  // vacation_until: ms epoch, null/0 clears. Existing bookings are unaffected (spec).
  const vac = b.vacation_until === undefined ? cur.vacation_until : (Number(b.vacation_until) > Date.now() ? Math.trunc(Number(b.vacation_until)) : null);
  await metaDb(env).prepare(
    `INSERT INTO booking_policies (user_id, buffer_min, min_notice_min, max_per_day, vacation_until)
     VALUES (?1,?2,?3,?4,?5)
     ON CONFLICT(user_id) DO UPDATE SET buffer_min=?2, min_notice_min=?3, max_per_day=?4, vacation_until=?5`,
  ).bind(ctx.uid, buffer, notice, maxDay, vac).run();
  track(env, ctx.uid, "booking_policy_updated", APP, { buffer, notice, maxDay, vacation: !!vac });
  return json({ ok: true, policy: { buffer_min: buffer, min_notice_min: notice, max_per_day: maxDay, vacation_until: vac } });
}

// ---------------------------------------------------------------------------
// Reschedule flow (A4) — propose → accept/decline; pending expires at original
// start; max 2 reschedules per booking; money untouched (same order).
// ---------------------------------------------------------------------------
export async function proposeReschedule(req: Request, env: Env, bookingId: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  const ns = Number(b.new_start), ne = Number(b.new_end);
  if (!(ns > Date.now()) || !(ne > ns)) return json({ error: "new_start/new_end required (future, end>start)" }, 400);

  const bk = await metaDb(env).prepare(
    "SELECT id, creator_id, buyer_id, starts_at, ends_at, status, reschedule_count FROM bookings WHERE id=?1",
  ).bind(bookingId).first<any>();
  if (!bk) return json({ error: "booking not found" }, 404);
  if (bk.creator_id !== ctx.uid && bk.buyer_id !== ctx.uid) return json({ error: "not your booking" }, 403);
  if (bk.status !== "confirmed") return json({ error: "booking not active" }, 409);
  if (bk.reschedule_count >= 2) return json({ error: "max_reschedules", detail: "Max 2 reschedules per booking — cancel per the rules instead." }, 409);

  const pending = await metaDb(env).prepare(
    "SELECT 1 FROM reschedule_requests WHERE booking_id=?1 AND status='pending' AND ?2 < ?3",
  ).bind(bookingId, Date.now(), bk.starts_at).first();
  if (pending) return json({ error: "proposal_pending" }, 409);

  // A conflicting proposal is rejected AT PROPOSE TIME: both parties' calendars
  // must be free (their existing block for THIS booking is excluded), and the
  // creator's policies must pass.
  for (const uid of [bk.creator_id, bk.buyer_id]) {
    const c = await checkAvailability(env, uid, ns, ne, { excludeRef: bookingId });
    // Also exclude the creator's slot-block backing this booking.
    if (c && !(c.starts_at === bk.starts_at && c.ends_at === bk.ends_at)) {
      return json({ error: "conflict", who: uid === bk.creator_id ? "creator" : "buyer", conflictWith: c }, 409);
    }
  }
  const viol = await policyViolation(env, bk.creator_id, ns, ne);
  if (viol && viol !== "max_per_day") return json({ error: "policy", reason: viol }, 409);

  const id = crypto.randomUUID();
  await metaDb(env).prepare(
    "INSERT INTO reschedule_requests (id, booking_id, proposed_by, new_start, new_end, status, created_at) VALUES (?1,?2,?3,?4,?5,'pending',?6)",
  ).bind(id, bookingId, ctx.uid, ns, ne, Date.now()).run();

  const other = ctx.uid === bk.creator_id ? bk.buyer_id : bk.creator_id;
  try { await notifyUser(env, other, { type: "system", title: "New time proposed", body: `Proposed: ${new Date(ns).toUTCString()}`, data: { deeplink: "/booking", booking_id: bookingId, reschedule_id: id } }); } catch { /* best-effort */ }
  track(env, ctx.uid, "booking_reschedule_proposed", APP, {});
  return json({ ok: true, reschedule_id: id });
}

export async function respondReschedule(req: Request, env: Env, rescheduleId: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  const accept = b.accept === true;

  const rr = await metaDb(env).prepare(
    "SELECT id, booking_id, proposed_by, new_start, new_end, status FROM reschedule_requests WHERE id=?1",
  ).bind(rescheduleId).first<any>();
  if (!rr) return json({ error: "not found" }, 404);
  const bk = await metaDb(env).prepare(
    "SELECT id, creator_id, buyer_id, starts_at, ends_at, price, status, reschedule_count FROM bookings WHERE id=?1",
  ).bind(rr.booking_id).first<any>();
  if (!bk) return json({ error: "booking not found" }, 404);
  if (bk.creator_id !== ctx.uid && bk.buyer_id !== ctx.uid) return json({ error: "not your booking" }, 403);
  if (ctx.uid === rr.proposed_by) return json({ error: "the other side must respond" }, 403);
  if (rr.status !== "pending") return json({ error: "already_resolved", status_now: rr.status }, 409);
  if (Date.now() >= bk.starts_at) { // pending expires at original start time
    await metaDb(env).prepare("UPDATE reschedule_requests SET status='expired' WHERE id=?1").bind(rr.id).run();
    return json({ error: "expired" }, 409);
  }

  if (!accept) {
    await metaDb(env).prepare("UPDATE reschedule_requests SET status='declined' WHERE id=?1").bind(rr.id).run();
    try { await notifyUser(env, rr.proposed_by, { type: "system", title: "Reschedule declined", body: "The original time stands.", data: { deeplink: "/booking", booking_id: bk.id } }); } catch { /* best-effort */ }
    return json({ ok: true, declined: true });
  }

  // Re-validate at accept time (the world may have changed since the proposal).
  for (const uid of [bk.creator_id, bk.buyer_id]) {
    const c = await checkAvailability(env, uid, rr.new_start, rr.new_end, { excludeRef: bk.id });
    if (c && !(c.starts_at === bk.starts_at && c.ends_at === bk.ends_at)) {
      await metaDb(env).prepare("UPDATE reschedule_requests SET status='declined' WHERE id=?1").bind(rr.id).run();
      return json({ error: "conflict", conflictWith: c }, 409);
    }
  }

  // Atomic swap: bookings + mirrored events + BOTH parties' blocks move together.
  const title = (await metaDb(env).prepare("SELECT title FROM calendar_events WHERE booking_id=?1 LIMIT 1").bind(bk.id).first<any>())?.title ?? "Booking";
  await metaDb(env).batch([
    metaDb(env).prepare("UPDATE bookings SET starts_at=?2, ends_at=?3, reschedule_count=reschedule_count+1, updated_at=?4 WHERE id=?1").bind(bk.id, rr.new_start, rr.new_end, Date.now()),
    metaDb(env).prepare("UPDATE calendar_events SET start_at=?2, end_at=?3, reminded_24=0, reminded_60=0, reminded_10=0 WHERE booking_id=?1").bind(bk.id, rr.new_start, rr.new_end),
    metaDb(env).prepare("UPDATE calendar_blocks SET starts_at=?2, ends_at=?3 WHERE source_ref=?1 AND status='busy'").bind(bk.id, rr.new_start, rr.new_end),
    // The creator's original slot-block (slot id ref) moves too when it matches the old window.
    metaDb(env).prepare("UPDATE calendar_blocks SET starts_at=?3, ends_at=?4 WHERE user_id=?1 AND status='busy' AND starts_at=?2 AND source_app='avacalendar'").bind(bk.creator_id, bk.starts_at, rr.new_start, rr.new_end),
    metaDb(env).prepare("UPDATE bookings SET reminder24_sent=0, reminder_sent=0, reminder10_sent=0 WHERE id=?1").bind(bk.id),
    metaDb(env).prepare("UPDATE reschedule_requests SET status='accepted' WHERE id=?1").bind(rr.id),
  ]);

  // Gcal events move too (acceptance criterion), ICS re-sent with bumped SEQUENCE.
  const moved = await metaDb(env).prepare("SELECT id, user_id FROM calendar_blocks WHERE source_ref IN (?1) AND status='busy'").bind(bk.id).all();
  for (const m of (moved.results ?? []) as any[]) {
    try { await gcalExport(env, m.user_id, m.id, "upsert"); } catch { /* best-effort */ }
  }
  const [creatorName, buyerName] = await Promise.all([nameOf(env, bk.creator_id), nameOf(env, bk.buyer_id)]);
  try {
    await emailBookingConfirmed(env, {
      bookingId: bk.id, title, start: rr.new_start, end: rr.new_end, price: bk.price ?? 0,
      creatorId: bk.creator_id, buyerId: bk.buyer_id, creatorName, buyerName,
    }, { sequence: (bk.reschedule_count ?? 0) + 1, resched: true });
  } catch { /* best-effort */ }
  for (const uid of [bk.creator_id, bk.buyer_id]) {
    try { await notifyUser(env, uid, { type: "system", title: "Booking rescheduled", body: `${title} → ${new Date(rr.new_start).toUTCString()}`, data: { deeplink: "/booking", booking_id: bk.id } }); } catch { /* best-effort */ }
  }
  track(env, ctx.uid, "booking_rescheduled", APP, {});
  return json({ ok: true, accepted: true, new_start: rr.new_start, new_end: rr.new_end });
}

export async function listReschedules(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const bookingId = new URL(req.url).searchParams.get("booking") || "";
  const bk = await metaDb(env).prepare("SELECT creator_id, buyer_id, starts_at FROM bookings WHERE id=?1").bind(bookingId).first<any>();
  if (!bk || (bk.creator_id !== ctx.uid && bk.buyer_id !== ctx.uid)) return json({ error: "not found" }, 404);
  // Lazy-expire pending proposals past the original start.
  await metaDb(env).prepare("UPDATE reschedule_requests SET status='expired' WHERE booking_id=?1 AND status='pending' AND ?2 >= ?3").bind(bookingId, Date.now(), bk.starts_at).run();
  const rs = await metaSession(env).prepare(
    "SELECT id, proposed_by, new_start, new_end, status, created_at FROM reschedule_requests WHERE booking_id=?1 ORDER BY created_at DESC LIMIT 10",
  ).bind(bookingId).all();
  return json({ reschedules: rs.results ?? [] });
}

// ---------------------------------------------------------------------------
// A1: PUBLIC join-info — display data only (title/time/names; no PII beyond
// that). Joining still requires the app + Clerk auth.
// ---------------------------------------------------------------------------
export async function joinInfo(req: Request, env: Env, token: string): Promise<Response> {
  const bookingId = await verifyJoinToken(env, token);
  if (!bookingId) return json({ error: "invalid or expired link" }, 404);
  const bk = await metaDb(env).prepare(
    "SELECT id, creator_id, starts_at, ends_at, status FROM bookings WHERE id=?1",
  ).bind(bookingId).first<any>();
  if (!bk) return json({ error: "not found" }, 404);
  const title = (await metaDb(env).prepare("SELECT title FROM calendar_events WHERE booking_id=?1 LIMIT 1").bind(bookingId).first<any>())?.title ?? "AvaTOK session";
  return json({
    title, starts_at: bk.starts_at, ends_at: bk.ends_at, status: bk.status,
    creator_name: await nameOf(env, bk.creator_id),
    deeplink: `avatok://booking/${bookingId}`,
  }, 200, { "cache-control": "public, max-age=60" });
}
