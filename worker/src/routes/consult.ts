// AvaConsult delivery (Phase 7). 1:1 sessions are P2P over the existing
// CallRoom-DO signaling pattern (2-peer cap reused); 1:10 / 1:20 group sessions
// use the Cloudflare Realtime SFU via its HTTPS API + the shared flutter_webrtc
// (NO RealtimeKit/Dyte SDK — perf budget §1). Attendance + chat + countdown ride
// the session's StreamSessionDO (`consult:<bookingId>`) — the same room layer
// as AvaLive.
//
//   GET  /api/consult/:bookingId/join       entitled party → mode + tokens
//   GET  /api/consult/:bookingId/room       WS → session DO (signed token)
//   ANY  /api/consult/:bookingId/sfu/*      authed proxy → Cloudflare Realtime SFU
//   POST /api/consult/:bookingId/complete   host marks complete (R3)
//   POST /api/consult/:bookingId/cancel     buyer/creator cancel (R4/R5/R6)
//   POST /api/consult/:bookingId/extend     +15 min when the host's calendar is free
//   GET  /api/consult/probe                 pre-call RTT probe (A3)
//   GET  /api/consult/probe/blob            ~256 KB for a 2 s bandwidth estimate (A3)
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { metaDb } from "../db/shard";
import { checkAvailability } from "../cal/engine";
import { track } from "../hooks";
import { notifyUser } from "../notify";
import { signSessionToken, verifySessionToken, sessionStub, sessionOp, creatorBlocked } from "./live";

const APP = "avaconsult";
const PRE_JOIN_MS = 10 * 60_000;   // both sides can enter 10 min early
const END_GRACE_MS = 2 * 60_000;   // session auto-ends at slot end (grace 2 min)
const EXTEND_MS = 15 * 60_000;

interface Bk {
  id: string; creator_id: string; buyer_id: string; listing_id: string | null;
  kind: string; starts_at: number; ends_at: number; price: number; status: string;
  order_id: string | null; title: string; capacity: number;
}

async function loadBooking(env: Env, id: string): Promise<Bk | null> {
  const r = await metaDb(env).prepare(
    `SELECT b.id, b.creator_id, b.buyer_id, b.listing_id, b.kind, b.starts_at, b.ends_at, b.price, b.status, b.order_id,
            COALESCE(l.title, (SELECT title FROM calendar_events e WHERE e.booking_id=b.id LIMIT 1), 'Consultation') AS title,
            COALESCE(l.capacity, 1) AS capacity
       FROM bookings b LEFT JOIN listings l ON l.id=b.listing_id WHERE b.id=?1`,
  ).bind(id).first<any>();
  return r ? { ...r, starts_at: Number(r.starts_at), ends_at: Number(r.ends_at), capacity: Number(r.capacity) || 1 } as Bk : null;
}

async function nameOf(env: Env, uid: string): Promise<string> {
  try {
    const r = await metaDb(env).prepare("SELECT name, handle FROM profiles WHERE uid=?1 OR clerk_user_id=?1").bind(uid).first<any>();
    return r?.name || r?.handle || "Someone";
  } catch { return "Someone"; }
}

const bid = (req: Request): string | null => {
  const m = new URL(req.url).pathname.match(/^\/api\/consult\/([A-Za-z0-9-]{1,64})(?:\/|$)/);
  return m ? m[1] : null;
};

// ---------------------------------------------------------------------------
// GET /api/consult/:bookingId/join
// ---------------------------------------------------------------------------
export async function consultJoin(req: Request, env: Env): Promise<Response> {
  const id = bid(req); if (!id) return json({ error: "bad booking id" }, 400);
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const bk = await loadBooking(env, id);
  if (!bk) return json({ error: "booking not found" }, 404);
  const isHost = bk.creator_id === ctx.uid;
  const isBuyer = bk.buyer_id === ctx.uid;
  if (!isHost && !isBuyer) return json({ error: "not your session" }, 403);
  if (bk.kind === "live_event") return json({ error: "live_event", listing_id: bk.listing_id }, 409); // join via /api/live
  if (!["confirmed", "completed"].includes(bk.status)) return json({ error: "session not active", status: bk.status }, 409);
  if (!isHost && await creatorBlocked(env, bk.creator_id, ctx.uid)) return json({ error: "not available" }, 403);

  const now = Date.now();
  if (now < bk.starts_at - PRE_JOIN_MS) return json({ error: "too early", starts_at: bk.starts_at, opens_at: bk.starts_at - PRE_JOIN_MS }, 425);
  if (now > bk.ends_at + END_GRACE_MS) return json({ error: "session over", ended_at: bk.ends_at }, 410);

  // Paid entitlement: buyer needs the order (held or free listing).
  let orderId: string | null = null;
  if (isBuyer && bk.order_id) {
    const o = await metaDb(env).prepare("SELECT id, status FROM orders WHERE id=?1").bind(bk.order_id).first<any>();
    if (!o || !["held", "free", "settled"].includes(String(o.status))) return json({ error: "no valid order for this session", status: o?.status }, 403);
    orderId = String(o.id);
  }

  const group = bk.capacity > 1;
  // Capacity: the (capacity+1)-th participant is refused (host doesn't count
  // against the listing's buyer capacity; entitlement is per-order anyway).
  if (group) {
    const ps = await sessionOp(env, `consult:${id}`, { op: "participants" });
    const attendees = (ps?.uids ?? []).filter((p: any) => p.role !== "host");
    const already = attendees.some((p: any) => p.uid === ctx.uid);
    if (!isHost && !already && attendees.length >= bk.capacity) return json({ error: "session full", capacity: bk.capacity }, 403);
    if (!env.CALLS_APP_ID || !env.CALLS_APP_SECRET) return json({ error: "group sessions unavailable", reason: "CALLS_APP_ID/CALLS_APP_SECRET unset" }, 503);
  }

  // Arm the session DO once (idempotent re-arm on every join).
  await sessionOp(env, `consult:${id}`, { op: "schedule", sid: id, kind: "consult", starts_at: bk.starts_at, ends_at: bk.ends_at, host_id: bk.creator_id });

  const token = await signSessionToken(env, {
    sid: id, uid: ctx.uid, role: isHost ? "host" : "attendee", order: orderId,
    name: await nameOf(env, ctx.uid), exp: bk.ends_at + 2 * 3_600_000,
  });
  track(env, ctx.uid, "consult_join", APP, { mode: group ? "sfu" : "p2p", host: isHost });
  return json({
    ok: true,
    mode: group ? "sfu" : "p2p",
    room: group ? null : `consult-${id}`,            // CallRoom DO id (1:1 P2P)
    room_token: token,                                // session DO WS (attendance/chat/countdown)
    starts_at: bk.starts_at, ends_at: bk.ends_at, title: bk.title,
    capacity: bk.capacity, host_id: bk.creator_id, listing_id: bk.listing_id,
    peer: isHost ? bk.buyer_id : bk.creator_id,
    peer_name: await nameOf(env, isHost ? bk.buyer_id : bk.creator_id),
    // The other thread for the in-room "Send file" button (files flow through
    // the normal AvaTok media pipeline → AvaLibrary on both sides).
    thread_peer: isHost ? bk.buyer_id : bk.creator_id,
  });
}

// ---------------------------------------------------------------------------
// GET /api/consult/:bookingId/room — WS into the session DO.
// ---------------------------------------------------------------------------
export async function consultRoom(req: Request, env: Env): Promise<Response> {
  const id = bid(req); if (!id) return json({ error: "bad booking id" }, 400);
  if (req.headers.get("Upgrade") !== "websocket") return json({ error: "expected websocket" }, 426);
  const p = await verifySessionToken(env, new URL(req.url).searchParams.get("token") || "");
  if (!p || p.sid !== id) return json({ error: "bad token" }, 403);
  const h = new Headers(req.headers);
  h.set("x-session-uid", p.uid);
  h.set("x-session-role", p.role);
  h.set("x-session-name", p.name);
  if (p.order) h.set("x-session-order", p.order);
  return sessionStub(env, `consult:${id}`).fetch(new Request(req.url, { method: "GET", headers: h }));
}

// ---------------------------------------------------------------------------
// ANY /api/consult/:bookingId/sfu/* — thin authed proxy to Cloudflare Realtime
// SFU (the client negotiates WebRTC itself via flutter_webrtc; the app secret
// never leaves the Worker). Token in `x-session-token` (or ?token=).
// ---------------------------------------------------------------------------
export async function consultSfu(req: Request, env: Env): Promise<Response> {
  const id = bid(req); if (!id) return json({ error: "bad booking id" }, 400);
  if (!env.CALLS_APP_ID || !env.CALLS_APP_SECRET) return json({ error: "group sessions unavailable" }, 503);
  const u = new URL(req.url);
  const p = await verifySessionToken(env, req.headers.get("x-session-token") || u.searchParams.get("token") || "");
  if (!p || p.sid !== id) return json({ error: "bad token" }, 403);
  const sub = u.pathname.replace(/^\/api\/consult\/[A-Za-z0-9-]+\/sfu/, "");
  const target = `https://rtc.live.cloudflare.com/v1/apps/${env.CALLS_APP_ID}${sub}${u.search ? (u.search.replace(/([?&])token=[^&]*&?/, "$1").replace(/[?&]$/, "")) : ""}`;
  // The app always POSTs (one signing path); x-sfu-method carries the real verb.
  const method = (req.headers.get("x-sfu-method") || req.method).toUpperCase();
  const r = await fetch(target, {
    method,
    headers: { Authorization: `Bearer ${env.CALLS_APP_SECRET}`, "content-type": req.headers.get("content-type") || "application/json" },
    body: method === "GET" || method === "HEAD" ? undefined : await req.arrayBuffer(),
  });
  return new Response(r.body, { status: r.status, headers: { "content-type": r.headers.get("content-type") || "application/json" } });
}

// ---------------------------------------------------------------------------
// POST /api/consult/:bookingId/complete — host marks complete (R3 trigger).
// ---------------------------------------------------------------------------
export async function consultComplete(req: Request, env: Env): Promise<Response> {
  const id = bid(req); if (!id) return json({ error: "bad booking id" }, 400);
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const bk = await loadBooking(env, id);
  if (!bk) return json({ error: "booking not found" }, 404);
  if (bk.creator_id !== ctx.uid) return json({ error: "host only" }, 403);
  await metaDb(env).prepare("UPDATE bookings SET host_marked_complete=1, updated_at=?2 WHERE id=?1").bind(id, Date.now()).run();
  await env.Q_MONEY.send({ type: "evaluate", sid: id, kind: "consult", phase: "end" });
  track(env, ctx.uid, "consult_marked_complete", APP, {});
  return json({ ok: true, state: "settlement_pending" });
}

// ---------------------------------------------------------------------------
// POST /api/consult/:bookingId/cancel — refund rules R4/R5/R6 via the engine.
// ---------------------------------------------------------------------------
export async function consultCancel(req: Request, env: Env): Promise<Response> {
  const id = bid(req); if (!id) return json({ error: "bad booking id" }, 400);
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const bk = await loadBooking(env, id);
  if (!bk) return json({ error: "booking not found" }, 404);
  const byCreator = bk.creator_id === ctx.uid;
  if (!byCreator && bk.buyer_id !== ctx.uid) return json({ error: "not your session" }, 403);
  if (bk.status !== "confirmed") return json({ ok: true, already: true, status: bk.status });
  const now = Date.now();

  if (bk.order_id) {
    await metaDb(env).prepare(
      "UPDATE orders SET cancelled_by=?2, cancelled_at=?3, updated_at=?3 WHERE id=?1 AND status='held'",
    ).bind(bk.order_id, byCreator ? "creator" : "buyer", now).run();
    await env.Q_MONEY.send({ type: "cancel", sid: id, kind: "consult", orderId: bk.order_id });
  }
  await metaDb(env).batch([
    metaDb(env).prepare("UPDATE bookings SET status=?2, updated_at=?3 WHERE id=?1").bind(id, byCreator ? "cancelled_creator" : "cancelled_user", now),
    metaDb(env).prepare("UPDATE calendar_events SET status='cancelled' WHERE booking_id=?1").bind(id),
    metaDb(env).prepare("DELETE FROM calendar_blocks WHERE source_ref=?1").bind(id),
  ]);
  const other = byCreator ? bk.buyer_id : bk.creator_id;
  try { await notifyUser(env, other, { type: "system", title: "Session cancelled", body: `${bk.title} was cancelled — any refund lands per the rules.`, data: { deeplink: "/booking", booking_id: id } }); } catch { /* best-effort */ }
  track(env, ctx.uid, "consult_cancelled", APP, { by: byCreator ? "creator" : "buyer" });
  return json({ ok: true, cancelled: true, refund: "per rules — wallet + email" });
}

// ---------------------------------------------------------------------------
// POST /api/consult/:bookingId/extend — +15 min, only if the host's calendar is
// free right after (Phase 5 conflict engine).
// ---------------------------------------------------------------------------
export async function consultExtend(req: Request, env: Env): Promise<Response> {
  const id = bid(req); if (!id) return json({ error: "bad booking id" }, 400);
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const bk = await loadBooking(env, id);
  if (!bk) return json({ error: "booking not found" }, 404);
  if (bk.creator_id !== ctx.uid) return json({ error: "host only" }, 403);
  const newEnd = bk.ends_at + EXTEND_MS;
  const conflict = await checkAvailability(env, bk.creator_id, bk.ends_at, newEnd, { excludeRef: id });
  if (conflict) return json({ error: "next slot not free", conflictWith: conflict }, 409);
  await metaDb(env).batch([
    metaDb(env).prepare("UPDATE bookings SET ends_at=?2, updated_at=?3 WHERE id=?1").bind(id, newEnd, Date.now()),
    metaDb(env).prepare("UPDATE calendar_events SET end_at=?2 WHERE booking_id=?1").bind(id, newEnd),
    metaDb(env).prepare("UPDATE calendar_blocks SET ends_at=?2 WHERE source_ref=?1").bind(id, newEnd),
  ]);
  await sessionOp(env, `consult:${id}`, { op: "schedule", sid: id, kind: "consult", starts_at: bk.starts_at, ends_at: newEnd, host_id: bk.creator_id });
  try { await notifyUser(env, bk.buyer_id, { type: "system", title: "Session extended", body: "The host extended your session by 15 minutes.", data: { deeplink: "/booking", booking_id: id } }); } catch { /* best-effort */ }
  track(env, ctx.uid, "consult_extended", APP, {});
  return json({ ok: true, ends_at: newEnd });
}

// ---------------------------------------------------------------------------
// Pre-call check (A3): RTT probe + bandwidth blob.
// ---------------------------------------------------------------------------
export function consultProbe(): Response {
  return json({ ok: true, ts: Date.now() }, 200, { "cache-control": "no-store" });
}
export function consultProbeBlob(): Response {
  const blob = new Uint8Array(256 * 1024); // zeros compress — disable that
  crypto.getRandomValues(blob.subarray(0, 65535));
  for (let i = 65535; i < blob.length; i += 65535) blob.set(blob.subarray(0, Math.min(65535, blob.length - i)), i);
  return new Response(blob, { status: 200, headers: { "content-type": "application/octet-stream", "cache-control": "no-store", "content-encoding": "identity" } });
}
