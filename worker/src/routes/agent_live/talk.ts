// [AGENT-LIVE-1] Talk prejoin + WebSocket upgrade (BUILD SPEC §3, §9; R2 §3.3;
// M12). Owned by WS-E1.
//
// `agentTalkPrejoin` mints a short-lived HMAC room token bound to
// (bookingId, buyerUid, roomGeneration) and returns the R2 §3 prejoin body.
// `agentTalkWs` verifies that token (auth) + re-checks the booking, then
// forwards the WebSocket upgrade to the per-booking `AgentLiveRoom` DO,
// stamping the verified identity onto trusted headers the DO reads (the DO
// is only reachable through this binding call, never directly by a browser,
// so headers set here are safe for the DO to trust without re-verifying the
// HMAC itself).
import type { Env } from "../../types";
import type { AgentLiveHandler } from "../../lib/agent_live/types";
import type { AgentLiveBookingRow } from "../../lib/agent_live/types";
import { json } from "../../util";
import { requireUser, isFail } from "../../authz";
import { readConfig } from "../../routes/config";
import { talkGate, adminUid } from "../../lib/agent_live/gate";

const ROOM_TOKEN_TTL_MS = 5 * 60_000;
const PREJOIN_WINDOW_MS = 120_000; // starts_at - 120s

// ---------------------------------------------------------------------------
// Room token — HMAC over bookingId.buyerUid.gen.exp, base64url encoded
// (mirrors the pattern in lib/genui_thumb_sign.ts).
// ---------------------------------------------------------------------------

function b64urlEncode(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s: string): string {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
}

async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function mintRoomToken(
  env: Env,
  bookingId: string,
  buyerUid: string,
  gen: number,
): Promise<string> {
  const exp = Date.now() + ROOM_TOKEN_TTL_MS;
  const payload = `${bookingId}.${buyerUid}.${gen}.${exp}`;
  const sig = await hmacHex(env.JOIN_LINK_SECRET || "", payload);
  return `v1.${b64urlEncode(bookingId)}.${b64urlEncode(buyerUid)}.${gen}.${exp}.${sig}`;
}

interface VerifiedRoomToken {
  bookingId: string;
  buyerUid: string;
  gen: number;
}

async function verifyRoomToken(env: Env, token: string): Promise<VerifiedRoomToken | null> {
  const parts = token.split(".");
  if (parts.length !== 6 || parts[0] !== "v1") return null;
  const [, bId, bUid, genStr, expStr, sig] = parts;
  let bookingId: string, buyerUid: string;
  try {
    bookingId = b64urlDecode(bId);
    buyerUid = b64urlDecode(bUid);
  } catch {
    return null;
  }
  const gen = Number(genStr);
  const exp = Number(expStr);
  if (!bookingId || !buyerUid || !Number.isFinite(gen) || !Number.isFinite(exp)) return null;
  if (Date.now() > exp) return null;
  const payload = `${bookingId}.${buyerUid}.${gen}.${exp}`;
  const want = await hmacHex(env.JOIN_LINK_SECRET || "", payload);
  if (want.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff !== 0) return null;
  return { bookingId, buyerUid, gen };
}

function roomStub(env: Env, bookingId: string) {
  return env.AGENT_LIVE_ROOMS.get(env.AGENT_LIVE_ROOMS.idFromName(bookingId));
}

async function loadBooking(env: Env, bookingId: string): Promise<AgentLiveBookingRow | null> {
  return env.DB_META
    .prepare("SELECT * FROM agent_live_bookings WHERE id = ?1")
    .bind(bookingId)
    .first<AgentLiveBookingRow>();
}

// ---------------------------------------------------------------------------
// POST /api/agents/talk/:bookingId/prejoin
// ---------------------------------------------------------------------------
export const agentTalkPrejoin: AgentLiveHandler = async (req, env, _ctx, params) => {
  const bookingId = params.bookingId;
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);

  const booking = await loadBooking(env, bookingId);
  if (!booking) return json({ error: "booking_not_found" }, 404);

  const admin = adminUid(env);
  const isOwnerOrAdminTest = booking.buyer_uid === ctx.uid || (booking.is_test === 1 && admin === ctx.uid);
  if (!isOwnerOrAdminTest) return json({ error: "forbidden" }, 403);

  const now = Date.now();
  if (now < booking.starts_at - PREJOIN_WINDOW_MS || now >= booking.ends_at) {
    return json({ error: "outside_join_window", startsAt: booking.starts_at, endsAt: booking.ends_at }, 409);
  }

  const cfg = await readConfig(env);
  const gate = talkGate(env, cfg);
  let reattaching = false;
  if (!gate.ok) {
    // M12: reattachment to an already-running session still works even when
    // agentTalkEnabled is off (only NEW provider starts / quotes are blocked).
    const stateResp = await roomStub(env, bookingId)
      .fetch("https://room/state")
      .then((r) => r.json())
      .catch(() => null);
    const live = stateResp && (stateResp as any).live && (stateResp as any).buyerUid === booking.buyer_uid;
    if (!live) return json({ error: gate.reason }, 503);
    reattaching = true;
  }

  // Defensive: ensure the room has a schedule armed (idempotent) — the sweep
  // also re-calls this for any `booked` row the room reports as unscheduled.
  await roomStub(env, bookingId)
    .fetch("https://room/schedule", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bookingId }),
    })
    .catch(() => {});

  const roomState = await roomStub(env, bookingId)
    .fetch("https://room/state")
    .then((r) => r.json() as Promise<{ sessionGeneration?: number }>)
    .catch(() => null as { sessionGeneration?: number } | null);
  const gen = roomState?.sessionGeneration ?? 1;

  const roomToken = await mintRoomToken(env, bookingId, booking.buyer_uid, gen);

  const agentRow = await env.DB_META
    .prepare(
      `SELECT l.title AS title, l.cover_media AS cover_media, a.voice AS voice,
              a.image_reading AS image_reading, a.memory_enabled AS memory_enabled
         FROM agent_live_agents a JOIN listings l ON l.id = a.listing_id
        WHERE a.listing_id = ?1`,
    )
    .bind(booking.agent_id)
    .first<{
      title: string;
      cover_media: string | null;
      voice: string;
      image_reading: number;
      memory_enabled: number;
    }>();

  let avatar: string | null = null;
  if (agentRow?.cover_media) {
    try {
      const arr = JSON.parse(agentRow.cover_media);
      avatar = Array.isArray(arr) && arr.length ? String(arr[0]) : null;
    } catch {
      avatar = null;
    }
  }

  const url = new URL(req.url);
  const wsUrl = `wss://${url.host}/api/agents/talk/${bookingId}/ws`;

  return json({
    ws_url: wsUrl,
    room_token: roomToken,
    starts_at: booking.starts_at,
    ends_at: booking.ends_at,
    server_now: now,
    agent: { name: agentRow?.title ?? "AI agent", avatar, voice: agentRow?.voice ?? "willow" },
    image_reading: cfg.agentImageReadingEnabled && !!agentRow?.image_reading,
    memory_enabled: cfg.agentMemoryEnabled && !!agentRow?.memory_enabled && booking.is_test !== 1,
    reattaching,
  });
};

// ---------------------------------------------------------------------------
// GET /api/agents/talk/:bookingId/ws?token=<room_token>
// ---------------------------------------------------------------------------
export const agentTalkWs: AgentLiveHandler = async (req, env, _ctx, params) => {
  if (req.headers.get("Upgrade") !== "websocket") {
    return json({ error: "expected_websocket" }, 426);
  }
  const bookingId = params.bookingId;
  const url = new URL(req.url);
  const token = url.searchParams.get("token") || "";
  const verified = token ? await verifyRoomToken(env, token) : null;
  if (!verified || verified.bookingId !== bookingId) {
    return json({ error: "invalid_room_token" }, 401);
  }

  const booking = await loadBooking(env, bookingId);
  if (!booking) return json({ error: "booking_not_found" }, 404);
  if (booking.buyer_uid !== verified.buyerUid) return json({ error: "forbidden" }, 403);
  if (Date.now() >= booking.ends_at) return json({ error: "session_ended" }, 410);
  if (booking.status === "cancelled" || booking.status === "failed") {
    return json({ error: "session_ended" }, 410);
  }

  const headers = new Headers(req.headers);
  headers.set("X-Room-Booking", bookingId);
  headers.set("X-Room-Buyer", verified.buyerUid);
  headers.set("X-Room-Gen", String(verified.gen));
  const forwarded = new Request(req, { headers });

  return roomStub(env, bookingId).fetch(forwarded);
};
