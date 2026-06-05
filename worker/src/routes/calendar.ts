// AvaCalendar (Phase 3, §10.2). Slots + bookings + mirrored events. Paid bookings
// debit the buyer's wallet and credit the host (7-day hold). Conflict-checked.
//   POST   /api/calendar/slots      → create a bookable slot
//   GET    /api/calendar/slots      → my slots (host) or ?host=<npub> public list
//   DELETE /api/calendar/slots/:id  → cancel a slot
//   POST   /api/calendar/book       → book a slot { slot_id }
//   POST   /api/calendar/cancel     → cancel a booking { booking_id }
//   GET    /api/calendar/events     → my upcoming events (both roles)
import type { Env } from "../types";
import { json } from "../util";
import { authenticate, isErr } from "../auth";
import { metaDb, metaSession } from "../db/shard";
import { transferCoins } from "./wallet";
import { track, brainFact } from "../hooks";
import { notifyUser } from "../notify";

const APP = "avacalendar";

export async function createSlot(req: Request, env: Env): Promise<Response> {
  const auth = await authenticate(req, env);
  if (isErr(auth)) return json({ error: auth.error }, auth.status);
  const b = (await req.json().catch(() => ({}))) as any;
  const start = Number(b.start_at), end = Number(b.end_at);
  if (!b.title || !(start > 0) || !(end > start)) return json({ error: "title, start_at, end_at (end>start) required" }, 400);
  const id = crypto.randomUUID();
  await metaDb(env).prepare(
    `INSERT INTO calendar_slots (id, host_npub, title, description, start_at, end_at, price_coins, capacity, booked_count, status, created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,0,'open',?9)`,
  ).bind(id, auth.npub, String(b.title), b.description ?? null, start, end, Math.max(0, Math.trunc(Number(b.price_coins || 0))), Math.max(1, Math.trunc(Number(b.capacity || 1))), Date.now()).run();
  track(env, auth.npub, "calendar_slot_created", APP, { price_coins: b.price_coins ?? 0 });
  return json({ ok: true, slot_id: id });
}

export async function listSlots(req: Request, env: Env): Promise<Response> {
  const auth = await authenticate(req, env);
  if (isErr(auth)) return json({ error: auth.error }, auth.status);
  const host = new URL(req.url).searchParams.get("host") || auth.npub;
  const rs = await metaSession(env).prepare(
    "SELECT id, host_npub, title, description, start_at, end_at, price_coins, capacity, booked_count, status FROM calendar_slots WHERE host_npub=?1 AND status!='cancelled' AND end_at > ?2 ORDER BY start_at ASC LIMIT 100",
  ).bind(host, Date.now()).all();
  return json({ slots: rs.results ?? [] });
}

export async function cancelSlot(req: Request, env: Env, slotId: string): Promise<Response> {
  const auth = await authenticate(req, env);
  if (isErr(auth)) return json({ error: auth.error }, auth.status);
  const slot = await metaDb(env).prepare("SELECT host_npub FROM calendar_slots WHERE id=?1").bind(slotId).first<{ host_npub: string }>();
  if (!slot || slot.host_npub !== auth.npub) return json({ error: "slot not found" }, 404);
  await metaDb(env).prepare("UPDATE calendar_slots SET status='cancelled' WHERE id=?1").bind(slotId).run();
  return json({ ok: true });
}

// POST /api/calendar/book { slot_id }
export async function bookSlot(req: Request, env: Env): Promise<Response> {
  const auth = await authenticate(req, env);
  if (isErr(auth)) return json({ error: auth.error }, auth.status);
  const b = (await req.json().catch(() => ({}))) as any;
  const slotId = String(b.slot_id || "");
  const isAgent = b.source === "agent";
  if (!slotId) return json({ error: "slot_id required" }, 400);

  const slot = await metaDb(env).prepare(
    "SELECT id, host_npub, title, start_at, end_at, price_coins, capacity, booked_count, status FROM calendar_slots WHERE id=?1",
  ).bind(slotId).first<any>();
  if (!slot || slot.status !== "open") return json({ error: "slot not available" }, 404);
  if (slot.host_npub === auth.npub) return json({ error: "cannot book your own slot" }, 400);
  if (slot.booked_count >= slot.capacity) return json({ error: "slot full" }, 409);

  // Conflict check: attendee must have no confirmed event overlapping [start,end).
  const clash = await metaDb(env).prepare(
    "SELECT 1 AS x FROM calendar_events WHERE owner_npub=?1 AND status='confirmed' AND start_at < ?3 AND end_at > ?2 LIMIT 1",
  ).bind(auth.npub, slot.start_at, slot.end_at).first<{ x: number }>();
  if (clash) return json({ error: "you have a conflicting booking" }, 409);

  // Pay if priced: debit attendee → credit host (full amount, no commission on consults).
  const price = Math.trunc(Number(slot.price_coins || 0));
  if (price > 0) {
    const t = await transferCoins(env, auth.npub, slot.host_npub, price, APP, `booking:${slotId}`, 0);
    if (!t.ok) return json({ error: "payment failed", detail: t.body }, t.status === 402 ? 402 : 502);
  }

  const bookingId = crypto.randomUUID();
  const now = Date.now();
  const mk = (owner: string, role: string) => metaDb(env).prepare(
    `INSERT INTO calendar_events (id, booking_id, slot_id, owner_npub, role, host_npub, attendee_npub, title, start_at, end_at, price_coins, paid, status, source, created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'confirmed',?13,?14)`,
  ).bind(crypto.randomUUID(), bookingId, slotId, owner, role, slot.host_npub, auth.npub, slot.title, slot.start_at, slot.end_at, price, price > 0 ? 1 : 0, isAgent ? "agent" : "user", now);

  await metaDb(env).batch([
    mk(auth.npub, "attendee"),
    mk(slot.host_npub, "host"),
    metaDb(env).prepare("UPDATE calendar_slots SET booked_count=booked_count+1, status=CASE WHEN booked_count+1>=capacity THEN 'closed' ELSE 'open' END WHERE id=?1").bind(slotId),
  ]);

  // Notify both + brain hooks.
  try { await notifyUser(env, slot.host_npub, { type: "system", title: "New booking", body: slot.title, data: { deeplink: "/calendar", booking_id: bookingId } }); } catch { /* best-effort */ }
  try { await notifyUser(env, auth.npub, { type: "system", title: "Booking confirmed", body: slot.title, data: { deeplink: "/calendar", booking_id: bookingId } }); } catch { /* best-effort */ }
  brainFact(env, auth.npub, "calendar_booked", APP, { title: slot.title, start_at: slot.start_at, price });
  brainFact(env, slot.host_npub, "calendar_hosted", APP, { title: slot.title, start_at: slot.start_at });
  track(env, auth.npub, "calendar_booked", APP, { price, source: isAgent ? "agent" : "user" });
  return json({ ok: true, booking_id: bookingId, start_at: slot.start_at, end_at: slot.end_at, paid: price > 0 });
}

// POST /api/calendar/cancel { booking_id }
export async function cancelBooking(req: Request, env: Env): Promise<Response> {
  const auth = await authenticate(req, env);
  if (isErr(auth)) return json({ error: auth.error }, auth.status);
  const b = (await req.json().catch(() => ({}))) as any;
  const bookingId = String(b.booking_id || "");
  const rows = await metaDb(env).prepare(
    "SELECT id, owner_npub, slot_id, status FROM calendar_events WHERE booking_id=?1",
  ).bind(bookingId).all();
  const list = (rows.results ?? []) as any[];
  if (!list.length) return json({ error: "booking not found" }, 404);
  if (!list.some((r) => r.owner_npub === auth.npub)) return json({ error: "not your booking" }, 403);
  if (list[0].status === "cancelled") return json({ ok: true, already: true });

  await metaDb(env).batch([
    metaDb(env).prepare("UPDATE calendar_events SET status='cancelled' WHERE booking_id=?1").bind(bookingId),
    metaDb(env).prepare("UPDATE calendar_slots SET booked_count=MAX(0,booked_count-1), status=CASE WHEN status='closed' THEN 'open' ELSE status END WHERE id=?1").bind(list[0].slot_id),
  ]);
  // Note: refunds for paid cancellations are a policy decision (host-set) — left to
  // a future refund flow; we record the cancellation now.
  track(env, auth.npub, "calendar_cancelled", APP, {});
  return json({ ok: true, cancelled: true });
}

// GET /api/calendar/events — my upcoming events (both roles).
export async function listEvents(req: Request, env: Env): Promise<Response> {
  const auth = await authenticate(req, env);
  if (isErr(auth)) return json({ error: auth.error }, auth.status);
  const rs = await metaSession(env).prepare(
    "SELECT booking_id, slot_id, role, host_npub, attendee_npub, title, start_at, end_at, price_coins, paid, status, source FROM calendar_events WHERE owner_npub=?1 AND status='confirmed' AND end_at > ?2 ORDER BY start_at ASC LIMIT 100",
  ).bind(auth.npub, Date.now()).all();
  return json({ events: rs.results ?? [] });
}
