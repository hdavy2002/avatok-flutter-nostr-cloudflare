// AvaCalendar — Phase 5 (PHASE-05.md). ONE availability engine for the whole
// platform: slots + bookings now ride the calendar_blocks conflict engine
// (src/cal/engine.ts); every scheduling write is overlap-checked + policy-checked
// server-side. Keyed by Clerk uid (uid columns are legacy mirrors, still
// written for old readers until the cleanup migration drops them).
//
//   POST   /api/calendar/slots            → create a bookable slot (claims a block)
//   GET    /api/calendar/slots            → slot rows; with ?creator=&date=&dur= →
//                                            computed free/occupied slot grid (flagged, not omitted)
//   DELETE /api/calendar/slots/:id        → cancel a slot (releases the block)
//   POST   /api/calendar/book             → book (wallet debit, claims buyer block, emails+ICS)
//   POST   /api/calendar/cancel           → cancel a booking (refund per rules, emails)
//   GET    /api/calendar/events           → my upcoming events (both roles)
//   GET    /api/calendar/blocks?from=&to= → my occupancy (month render)
//   GET/PUT /api/calendar/rules           → availability rules (replace-set)
//   GET    /api/time                      → server epoch (client clock-skew, A2)
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { metaDb, metaSession } from "../db/shard";
import { transferCoins } from "./wallet";
import { track, brainFact } from "../hooks";
import { notifyUser } from "../notify";
import { claimBlock, releaseBlocks, freeSlots, loadPolicy, policyViolation } from "../cal/engine";
import { emailBookingConfirmed, emailBookingCancelled, emailRefundIssued } from "../cal/emails";
import { gcalExport } from "../cal/gcal";

const APP = "avacalendar";

async function nameOf(env: Env, uid: string): Promise<string> {
  try {
    const r = await metaDb(env).prepare("SELECT name, handle FROM profiles WHERE uid=?1 OR clerk_user_id=?1").bind(uid).first<any>();
    return r?.name || r?.handle || "an AvaTOK user";
  } catch { return "an AvaTOK user"; }
}

// GET /api/time — public; clients compute clockSkew at app start (device clocks lie).
export function getTime(): Response { return json({ now: Date.now() }); }

export async function createSlot(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  const start = Number(b.start_at), end = Number(b.end_at);
  if (!b.title || !(start > 0) || !(end > start)) return json({ error: "title, start_at, end_at (end>start) required" }, 400);
  const id = crypto.randomUUID();

  // Conflict engine: the creator's time is claimed at slot creation. An AvaLive
  // event (or gcal meeting) at the same time ⇒ 409 with the occupier.
  const claim = await claimBlock(env, { userId: ctx.uid, sourceApp: APP, sourceRef: id, start, end, title: String(b.title) });
  if (!claim.ok) return json({ error: "conflict", conflictWith: claim.conflict }, 409);

  await metaDb(env).prepare(
    `INSERT INTO calendar_slots (id, host_uid, host_uid, title, description, start_at, end_at, price_coins, capacity, booked_count, status, created_at)
     VALUES (?1,?2,?2,?3,?4,?5,?6,?7,?8,0,'open',?9)`,
  ).bind(id, ctx.uid, String(b.title), b.description ?? null, start, end, Math.max(0, Math.trunc(Number(b.price_coins || 0))), Math.max(1, Math.trunc(Number(b.capacity || 1))), Date.now()).run();
  try { await gcalExport(env, ctx.uid, claim.id, "upsert"); } catch { /* best-effort */ }
  track(env, ctx.uid, "calendar_slot_created", APP, { price_coins: b.price_coins ?? 0 });
  return json({ ok: true, slot_id: id });
}

export async function listSlots(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const u = new URL(req.url);

  // Computed picker grid: availability_rules minus blocks, policy-flagged.
  // Occupied slots are RETURNED flagged, not omitted (greyed-out pickers).
  const creator = u.searchParams.get("creator");
  const date = u.searchParams.get("date"); // YYYY-MM-DD
  if (creator && date) {
    const dur = Math.max(0, Number(u.searchParams.get("dur") || 0));
    try {
      const slots = await freeSlots(env, creator, date, dur);
      return json({ date, creator, slots });
    } catch { return json({ error: "bad date" }, 400); }
  }

  const host = u.searchParams.get("host") || ctx.uid;
  const rs = await metaSession(env).prepare(
    "SELECT id, host_uid, title, description, start_at, end_at, price_coins, capacity, booked_count, status FROM calendar_slots WHERE host_uid=?1 AND status!='cancelled' AND end_at > ?2 ORDER BY start_at ASC LIMIT 100",
  ).bind(host, Date.now()).all();
  return json({ slots: rs.results ?? [] });
}

export async function cancelSlot(req: Request, env: Env, slotId: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const slot = await metaDb(env).prepare("SELECT host_uid FROM calendar_slots WHERE id=?1").bind(slotId).first<{ host_uid: string }>();
  if (!slot || slot.host_uid !== ctx.uid) return json({ error: "slot not found" }, 404);
  const blk = await metaDb(env).prepare("SELECT id FROM calendar_blocks WHERE source_app=?1 AND source_ref=?2 AND status='busy'").bind(APP, slotId).first<{ id: string }>();
  await metaDb(env).prepare("UPDATE calendar_slots SET status='cancelled' WHERE id=?1").bind(slotId).run();
  if (blk) { try { await gcalExport(env, ctx.uid, blk.id, "delete"); } catch { /* best-effort */ } }
  await releaseBlocks(env, APP, slotId);
  return json({ ok: true });
}

// POST /api/calendar/book { slot_id }
export async function bookSlot(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  const slotId = String(b.slot_id || "");
  const isAgent = b.source === "agent";
  if (!slotId) return json({ error: "slot_id required" }, 400);

  const slot = await metaDb(env).prepare(
    "SELECT id, host_uid, title, start_at, end_at, price_coins, capacity, booked_count, status FROM calendar_slots WHERE id=?1",
  ).bind(slotId).first<any>();
  if (!slot || slot.status !== "open") return json({ error: "slot not available" }, 404);
  if (slot.host_uid === ctx.uid) return json({ error: "cannot book your own slot" }, 400);
  if (slot.booked_count >= slot.capacity) return json({ error: "slot full" }, 409);

  // A3: server-side policy re-validation (UI greying is not enforcement).
  const viol = await policyViolation(env, slot.host_uid, slot.start_at, slot.end_at);
  if (viol) return json({ error: "policy", reason: viol }, 409);

  // Conflict engine: the BUYER's time is claimed atomically — two parallel
  // claims on one window ⇒ exactly one wins (single-statement INSERT…NOT EXISTS).
  const bookingId = crypto.randomUUID();
  const buyerPol = await loadPolicy(env, ctx.uid);
  const claim = await claimBlock(env, {
    userId: ctx.uid, sourceApp: "avabooking", sourceRef: bookingId,
    start: slot.start_at, end: slot.end_at, title: slot.title, bufferMin: buyerPol.buffer_min,
  });
  if (!claim.ok) return json({ error: "conflict", conflictWith: claim.conflict }, 409);

  // Pay if priced: debit attendee → credit host. On failure, release the claim.
  const price = Math.trunc(Number(slot.price_coins || 0));
  if (price > 0) {
    const t = await transferCoins(env, ctx.uid, slot.host_uid, price, APP, `booking:${bookingId}`, 0);
    if (!t.ok) {
      await releaseBlocks(env, "avabooking", bookingId);
      return json({ error: "payment failed", detail: t.body }, t.status === 402 ? 402 : 502);
    }
  }

  const now = Date.now();
  const mk = (owner: string, role: string) => metaDb(env).prepare(
    `INSERT INTO calendar_events (id, booking_id, slot_id, owner_uid, owner_uid, role, host_uid, host_uid, attendee_uid, attendee_uid, title, start_at, end_at, price_coins, paid, status, source, created_at)
     VALUES (?1,?2,?3,?4,?4,?5,?6,?6,?7,?7,?8,?9,?10,?11,?12,'confirmed',?13,?14)`,
  ).bind(crypto.randomUUID(), bookingId, slotId, owner, role, slot.host_uid, ctx.uid, slot.title, slot.start_at, slot.end_at, price, price > 0 ? 1 : 0, isAgent ? "agent" : "user", now);

  await metaDb(env).batch([
    mk(ctx.uid, "attendee"),
    mk(slot.host_uid, "host"),
    metaDb(env).prepare(
      `INSERT INTO bookings (id, creator_id, buyer_id, listing_id, kind, starts_at, ends_at, price, order_id, status, created_at, updated_at)
       VALUES (?1,?2,?3,?4,'consult_1to1',?5,?6,?7,?8,'confirmed',?9,?9)`,
    ).bind(bookingId, slot.host_uid, ctx.uid, slotId, slot.start_at, slot.end_at, price, price > 0 ? `booking:${bookingId}` : null, now),
    metaDb(env).prepare("UPDATE calendar_slots SET booked_count=booked_count+1, status=CASE WHEN booked_count+1>=capacity THEN 'closed' ELSE 'open' END WHERE id=?1").bind(slotId),
  ]);

  // Email matrix (Brevo + ICS + join link) + in-app/push + brain hooks + gcal.
  const [creatorName, buyerName] = await Promise.all([nameOf(env, slot.host_uid), nameOf(env, ctx.uid)]);
  try {
    await emailBookingConfirmed(env, { bookingId, title: slot.title, start: slot.start_at, end: slot.end_at, price, creatorId: slot.host_uid, buyerId: ctx.uid, creatorName, buyerName });
  } catch { /* best-effort */ }
  try { await notifyUser(env, slot.host_uid, { type: "system", title: "New booking", body: slot.title, data: { deeplink: "/calendar", booking_id: bookingId } }); } catch { /* best-effort */ }
  try { await notifyUser(env, ctx.uid, { type: "system", title: "Booking confirmed", body: slot.title, data: { deeplink: "/calendar", booking_id: bookingId } }); } catch { /* best-effort */ }
  try { await gcalExport(env, ctx.uid, claim.id, "upsert"); } catch { /* best-effort */ }
  brainFact(env, ctx.uid, "calendar_booked", APP, { title: slot.title, start_at: slot.start_at, price });
  brainFact(env, slot.host_uid, "calendar_hosted", APP, { title: slot.title, start_at: slot.start_at });
  track(env, ctx.uid, "calendar_booked", APP, { price, source: isAgent ? "agent" : "user" });
  return json({ ok: true, booking_id: bookingId, start_at: slot.start_at, end_at: slot.end_at, paid: price > 0 });
}

// POST /api/calendar/cancel { booking_id } — refund per the universal rules:
// buyer ≥24h before → 100%; buyer <24h → 50%; creator cancels anytime → 100%.
// (The full data-driven refund engine lands in Phase 7; these are its defaults.)
export async function cancelBooking(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  const bookingId = String(b.booking_id || "");
  const bk = await metaDb(env).prepare(
    "SELECT id, creator_id, buyer_id, listing_id, starts_at, ends_at, price, status FROM bookings WHERE id=?1",
  ).bind(bookingId).first<any>();
  // Legacy bookings (pre-Phase-5) only have calendar_events rows.
  const rows = await metaDb(env).prepare("SELECT id, owner_uid, title, slot_id, status FROM calendar_events WHERE booking_id=?1").bind(bookingId).all();
  const list = (rows.results ?? []) as any[];
  if (!bk && !list.length) return json({ error: "booking not found" }, 404);
  const creatorId: string = bk?.creator_id ?? list.find((r) => r.owner_uid)?.owner_uid;
  const buyerId: string | undefined = bk?.buyer_id;
  const mine = bk ? (bk.creator_id === ctx.uid || bk.buyer_id === ctx.uid) : list.some((r) => r.owner_uid === ctx.uid);
  if (!mine) return json({ error: "not your booking" }, 403);
  if ((bk?.status ?? list[0]?.status) !== "confirmed") return json({ ok: true, already: true });

  const byCreator = ctx.uid === creatorId;
  const slotId = bk?.listing_id ?? list[0]?.slot_id;
  await metaDb(env).batch([
    metaDb(env).prepare("UPDATE calendar_events SET status='cancelled' WHERE booking_id=?1").bind(bookingId),
    ...(bk ? [metaDb(env).prepare("UPDATE bookings SET status=?2, updated_at=?3 WHERE id=?1").bind(bookingId, byCreator ? "cancelled_creator" : "cancelled_user", Date.now())] : []),
    ...(slotId ? [metaDb(env).prepare("UPDATE calendar_slots SET booked_count=MAX(0,booked_count-1), status=CASE WHEN status='closed' THEN 'open' ELSE status END WHERE id=?1").bind(slotId)] : []),
  ]);
  await releaseBlocks(env, "avabooking", bookingId);

  // Phase 7: escrow-backed bookings (orders table) route through the refund
  // ENGINE (rules R4/R5/R6 — escrow→buyer/creator splits, emails, strikes).
  // The legacy direct-pay path below stays for pre-Phase-6 bookings only.
  let refundNote: string | undefined;
  const orderId: string | null = bk
    ? ((await metaDb(env).prepare("SELECT order_id, kind FROM bookings WHERE id=?1").bind(bookingId).first<any>())?.order_id ?? null)
    : null;
  if (orderId && bk) {
    const now = Date.now();
    await metaDb(env).prepare(
      "UPDATE orders SET cancelled_by=?2, cancelled_at=?3, updated_at=?3 WHERE id=?1 AND status='held'",
    ).bind(orderId, byCreator ? "creator" : "buyer", now).run();
    const consult = (await metaDb(env).prepare("SELECT kind FROM bookings WHERE id=?1").bind(bookingId).first<any>())?.kind !== "live_event";
    await env.Q_MONEY.send({ type: "cancel", sid: consult ? bookingId : bk.listing_id, kind: consult ? "consult" : "live_event", orderId });
    refundNote = "Refund per the cancellation rules is on its way to the buyer's wallet (email follows).";
  }

  // Refund (legacy paid bookings; booking paid the host directly, so refund = host→buyer).
  const price = Math.trunc(Number(bk?.price || 0));
  if (!orderId && bk && price > 0 && buyerId) {
    const h24 = bk.starts_at - Date.now() >= 24 * 3_600_000;
    const pct = byCreator ? 100 : (h24 ? 100 : 50);
    const amount = Math.round(price * pct / 100);
    if (amount > 0) {
      const t = await transferCoins(env, creatorId, buyerId, amount, APP, `refund:${bookingId}`, 0);
      if (t.ok) {
        refundNote = `Refund: ${pct}% ($${(amount / 100).toFixed(2)}) returned to the buyer's wallet.`;
        const reason = byCreator ? "creator cancelled — full refund" : (h24 ? "cancelled ≥24h before — full refund" : "cancelled <24h before — 50% refund");
        try { await emailRefundIssued(env, buyerId, { title: list[0]?.title ?? "Booking", amount, reason }); } catch { /* best-effort */ }
        await metaDb(env).prepare("UPDATE bookings SET status='refunded', updated_at=?2 WHERE id=?1").bind(bookingId, Date.now()).run();
      }
    }
  }

  if (bk && buyerId) {
    const [creatorName, buyerName] = await Promise.all([nameOf(env, creatorId), nameOf(env, buyerId)]);
    try {
      await emailBookingCancelled(env, {
        bookingId, title: list[0]?.title ?? "Booking", start: bk.starts_at, end: bk.ends_at, price,
        creatorId, buyerId, creatorName, buyerName,
        cancelledBy: byCreator ? "creator" : "buyer", refundNote,
      });
    } catch { /* best-effort */ }
  }
  for (const uid of [creatorId, buyerId].filter(Boolean) as string[]) {
    try { await notifyUser(env, uid, { type: "system", title: "Booking cancelled", body: refundNote ?? "A booking was cancelled", data: { deeplink: "/calendar", booking_id: bookingId } }); } catch { /* best-effort */ }
  }
  track(env, ctx.uid, "calendar_cancelled", APP, { by: byCreator ? "creator" : "buyer" });
  return json({ ok: true, cancelled: true, refund: refundNote ?? null });
}

// GET /api/calendar/events — my upcoming events (both roles).
export async function listEvents(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const rs = await metaSession(env).prepare(
    "SELECT booking_id, slot_id, role, host_uid, attendee_uid, title, start_at, end_at, price_coins, paid, status, source FROM calendar_events WHERE owner_uid=?1 AND status='confirmed' AND end_at > ?2 ORDER BY start_at ASC LIMIT 100",
  ).bind(ctx.uid, Date.now()).all();
  return json({ events: rs.results ?? [] });
}

// GET /api/calendar/blocks?from=&to= — my cross-app occupancy (month render).
export async function listBlocks(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const u = new URL(req.url);
  const from = Number(u.searchParams.get("from") || Date.now() - 7 * 86_400_000);
  const to = Number(u.searchParams.get("to") || Date.now() + 60 * 86_400_000);
  const rs = await metaSession(env).prepare(
    "SELECT id, source_app, source_ref, starts_at, ends_at, title, status FROM calendar_blocks WHERE user_id=?1 AND status='busy' AND starts_at < ?3 AND ends_at > ?2 ORDER BY starts_at LIMIT 500",
  ).bind(ctx.uid, from, to).all();
  return json({ blocks: rs.results ?? [] });
}

// GET/PUT /api/calendar/rules — availability rules editor (replace-set).
export async function getRules(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const rs = await metaSession(env).prepare(
    "SELECT id, weekday, start_min, end_min, tz, slot_min FROM availability_rules WHERE user_id=?1 ORDER BY weekday, start_min",
  ).bind(ctx.uid).all();
  return json({ rules: rs.results ?? [] });
}

export async function putRules(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  const rules = Array.isArray(b.rules) ? b.rules : null;
  if (!rules) return json({ error: "rules[] required" }, 400);
  if (rules.length > 50) return json({ error: "too many rules" }, 400);
  const stmts = [metaDb(env).prepare("DELETE FROM availability_rules WHERE user_id=?1").bind(ctx.uid)];
  for (const r of rules) {
    const wd = Math.trunc(Number(r.weekday)), sm = Math.trunc(Number(r.start_min)), em = Math.trunc(Number(r.end_min));
    const tz = String(r.tz || "UTC"), slot = Math.max(5, Math.trunc(Number(r.slot_min || 60)));
    if (!(wd >= 0 && wd <= 6) || !(sm >= 0 && em > sm && em <= 1440)) return json({ error: "bad rule" }, 400);
    try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch { return json({ error: `bad tz: ${tz}` }, 400); }
    stmts.push(metaDb(env).prepare(
      "INSERT INTO availability_rules (id, user_id, weekday, start_min, end_min, tz, slot_min) VALUES (?1,?2,?3,?4,?5,?6,?7)",
    ).bind(crypto.randomUUID(), ctx.uid, wd, sm, em, tz, slot));
  }
  await metaDb(env).batch(stmts);
  track(env, ctx.uid, "calendar_rules_updated", APP, { count: rules.length });
  return json({ ok: true, count: rules.length });
}
