/**
 * [CALL-SFU-1 2026-08-06] 1:1 calls on the Cloudflare Realtime SFU.
 *
 * WHY THIS EXISTS
 * ---------------
 * 1:1 calls were raw peer-to-peer. That is cheap and low-latency, and it is also
 * why they could not survive a network change: when a phone switches WiFi to
 * mobile data its address changes, the direct path is gone, and TWO phones behind
 * two NATs have to re-find each other by negotiating over a signalling channel
 * that may itself be broken. On 2026-08-05 that failed 12 times out of 12.
 *
 * With an SFU in the middle only the MOVING phone's leg breaks. The other side
 * keeps sending to a server that has not moved, at a fixed publicly-routable
 * address, with no NAT to traverse. Recovery becomes "reconnect to a server",
 * which is a solved problem, instead of "two phones re-negotiate with each
 * other", which is the problem that kept failing.
 *
 * It also deletes a whole category of code rather than fixing it: offerer
 * election, glare handling, attempt-id matching, relay migration and both peers
 * independently proving health all exist ONLY because there are two phones to
 * coordinate. None of them have an SFU analogue.
 *
 * WHAT THIS IS NOT
 * ----------------
 * This is a MEDIA path only. Ringing, accept, decline, busy, presence, the
 * receptionist handoff and billing all still run through `CallRoom` exactly as
 * before, and the 2-peer cap is untouched. Nothing above the media layer changes.
 *
 * RELATIONSHIP TO `groupcall.ts`
 * ------------------------------
 * Group conferences have run on this same Cloudflare Realtime app since the
 * LiveKit cutover, so the SFU contract here is not new or unproven — this module
 * deliberately mirrors `groupcall.ts`'s proxy shape (session/new, tracks/new,
 * renegotiate, tracks/close) so the two stay legible side by side.
 *
 * It is a separate module rather than a `groupId`-shaped reuse because the
 * authority model is genuinely different: groups have a roster, a 25-cap and a
 * GroupCallRoom DO with join tickets; a 1:1 call has exactly two known uids that
 * `CallRoom` already owns. Forcing 1:1 through the group path would mean a second
 * DO per call and a second answer to "who is on this call".
 *
 * THE CONTRACT, in the order a client uses it
 * -------------------------------------------
 *   POST /api/callsfu/:room/join    -> mint a CF session, get ICE servers
 *   POST /api/callsfu/:room/publish -> client offers, SFU answers (our tracks up)
 *   GET  /api/callsfu/:room/peer    -> what is the other side publishing?
 *   POST /api/callsfu/:room/pull    -> SFU offers, client answers (their tracks down)
 *   PUT  /api/callsfu/:room/renegotiate -> deliver that answer
 *   POST /api/callsfu/:room/close   -> drop tracks + seat
 *
 * Note the asymmetry, which is Cloudflare's and not ours: on PUBLISH the client
 * offers and the SFU answers; on PULL the SFU offers and the client answers via
 * /renegotiate. There is no client-initiated re-offer on this transport at all,
 * which is exactly why none of the P2P ICE-restart machinery ports over.
 */

import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { trackUser } from "../hooks";
import { emailFor } from "../lib/identity";
import { readConfig } from "./config";
import { mintIceServersWithStatus } from "./media";

const APP = "avatok";

/**
 * ICE credential lifetime. 6h matches the group path deliberately: a 1:1 call
 * that outlives its TURN credentials would fail its next reconnect for a reason
 * with no relationship to the network, and 6h is far past any real call.
 */
const ICE_TTL_S = 6 * 3600;

/** Same ceiling the group path enforces, so both transports agree. */
const MAX_TRACK_NAME_LEN = 128;

/** Cloudflare Realtime is configured, or every route here fails closed. */
function sfuConfigured(env: Env): boolean {
  return Boolean(env.CF_RT_SFU_APP_ID && env.CF_RT_SFU_APP_TOKEN);
}

type SfuResult = { ok: boolean; status: number; data: Record<string, unknown> };

/**
 * The only place this module talks to Cloudflare. Body is parsed defensively:
 * a non-JSON error page from an edge must not throw inside a call path, it must
 * become a 502 the client can fall back from.
 */
async function sfu(env: Env, path: string, init: RequestInit): Promise<SfuResult> {
  const url = `https://rtc.live.cloudflare.com/v1/apps/${env.CF_RT_SFU_APP_ID}${path}`;
  const r = await fetch(url, {
    ...init,
    headers: {
      "Authorization": `Bearer ${env.CF_RT_SFU_APP_TOKEN}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  let data: Record<string, unknown> = {};
  try { data = (await r.json()) as Record<string, unknown>; } catch { /* non-JSON edge error */ }
  return { ok: r.ok, status: r.status, data };
}

function roomStub(env: Env, room: string): DurableObjectStub {
  return env.CALL_ROOMS.get(env.CALL_ROOMS.idFromName(room));
}

async function roomFetch(env: Env, room: string, path: string, init?: RequestInit): Promise<Response> {
  return await roomStub(env, room).fetch(`https://call${path}`, init);
}

/**
 * Every route starts here. The uid is resolved BEFORE the flag refusals so a
 * block is attributable to a person — the same rule `groupcall.ts` follows,
 * learned from blocks that could not be traced to anyone.
 *
 * `email` is carried on every event on purpose. Per the project telemetry rule,
 * an event without it cannot be pulled back for a named tester later, and a call
 * bug is usually a conversation between two people — you need both sides.
 */
type Guard = { uid: string; email: string | null; video: boolean };

async function guard(req: Request, env: Env): Promise<Guard | Response> {
  const cfg = await readConfig(env);
  const u = await requireUser(req, env);
  if (isFail(u)) return json({ error: (u as { error: string }).error }, (u as { status: number }).status);
  const uid = (u as { uid: string }).uid;
  const email = await emailFor(env, uid).catch(() => null);

  if (!cfg.callSfuV1) {
    trackUser(env, uid, email, "call_sfu_blocked", APP, { reason: "flag_off" });
    return json({ error: "sfu_unavailable", reason: "flag_off" }, 503);
  }
  if (!sfuConfigured(env)) {
    // Secrets missing. This is the branch that must never be silent: a
    // misconfigured environment and a working one would otherwise be
    // indistinguishable from the client, which is precisely how the TURN
    // "relay_degraded" blind spot happened on the P2P path.
    trackUser(env, uid, email, "call_sfu_blocked", APP, { reason: "unconfigured" });
    return json({ error: "sfu_unavailable", reason: "unconfigured" }, 503);
  }
  return { uid, email, video: !cfg.callSfuAudioOnly };
}

/**
 * POST /api/callsfu/:room/join
 *
 * Mints a Cloudflare session and registers this phone's seat in `CallRoom`, which
 * is what makes the peer able to find it. Returns the ICE servers in the same
 * response so the client never needs a second round trip before building its
 * peer connection.
 *
 * `relay_available` / `relay_degraded` are passed through and the client is
 * expected to READ them. On the P2P path the equivalent fields were dropped on
 * the floor by `ice_cache.dart`, so a TURN outage looked identical to a healthy
 * deployment. Not repeating that here.
 */
export async function callSfuJoin(req: Request, env: Env, room: string): Promise<Response> {
  const g = await guard(req, env);
  if (g instanceof Response) return g;
  const startedAt = Date.now();

  const s = await sfu(env, "/sessions/new", { method: "POST" });
  const sessionId = typeof s.data.sessionId === "string" ? s.data.sessionId : "";
  if (!s.ok || !sessionId) {
    trackUser(env, g.uid, g.email, "call_sfu_error", APP, {
      call_id: room, stage: "session_new", status: s.status,
    });
    return json({ error: "sfu_session_failed", status: s.status }, 502);
  }

  const ice = await mintIceServersWithStatus(env, ICE_TTL_S);

  // Register the seat BEFORE returning. If this fails the client holds a session
  // the peer can never discover, which presents as a connected call with silence
  // — the worst possible failure shape. Better to fail the join and let the
  // client fall back to P2P while it still can.
  const seatRes = await roomFetch(env, room, "/sfu-seat", {
    method: "POST",
    body: JSON.stringify({ callId: room, uid: g.uid, sessionId }),
  });
  if (!seatRes.ok) {
    trackUser(env, g.uid, g.email, "call_sfu_error", APP, {
      call_id: room, stage: "seat_register", status: seatRes.status,
    });
    return json({ error: "sfu_seat_failed", status: seatRes.status }, seatRes.status === 403 ? 403 : 502);
  }

  trackUser(env, g.uid, g.email, "call_sfu_joined", APP, {
    call_id: room,
    session_id: sessionId,
    video_allowed: g.video,
    relay_available: !ice.relayDegraded,
    relay_degraded: ice.relayDegraded,
    elapsed_ms: Date.now() - startedAt,
  });

  return json({
    ok: true,
    provider: "cloudflare_realtime",
    call_id: room,
    session_id: sessionId,
    ice_servers: ice.iceServers,
    relay_available: !ice.relayDegraded,
    relay_degraded: ice.relayDegraded,
    ...(ice.relayReason ? { relay_reason: ice.relayReason } : {}),
    media: { audio: true, video: g.video },
  });
}

/**
 * POST /api/callsfu/:room/publish  — client offers, SFU answers.
 *
 * `location` is forced to "local" and only `mid` / `trackName` are taken from the
 * client, so a malformed or hostile body cannot turn a publish into a pull of
 * somebody else's session. Same shape as the group path.
 */
export async function callSfuPublish(req: Request, env: Env, room: string): Promise<Response> {
  const g = await guard(req, env);
  if (g instanceof Response) return g;

  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const sessionId = typeof b.sessionId === "string" ? b.sessionId : "";
  const offer = b.offer as { sdp?: unknown } | undefined;
  const offerSdp = typeof offer?.sdp === "string" ? offer.sdp : "";
  const rawTracks = Array.isArray(b.tracks) ? b.tracks : [];
  if (!sessionId || !offerSdp || rawTracks.length === 0) {
    return json({ error: "session_offer_and_tracks_required" }, 400);
  }

  const tracks: Array<Record<string, unknown>> = [];
  for (const t of rawTracks.slice(0, 2)) { // at most one audio + one video
    const o = t as Record<string, unknown>;
    const mid = typeof o.mid === "string" ? o.mid : "";
    const trackName = typeof o.trackName === "string" ? o.trackName.slice(0, MAX_TRACK_NAME_LEN) : "";
    const kind = o.kind === "video" ? "video" : "audio";
    if (!mid || !trackName) return json({ error: "mid_and_track_name_required" }, 400);
    if (kind === "video" && !g.video) {
      // callSfuAudioOnly is on. Refuse rather than silently publishing video the
      // operator asked to keep off the SFU — a silent accept would make the flag
      // a lie and the bandwidth bill a surprise.
      return json({ error: "video_not_allowed", reason: "audio_only" }, 409);
    }
    tracks.push({ location: "local", mid, trackName });
  }

  const r = await sfu(env, `/sessions/${sessionId}/tracks/new`, {
    method: "POST",
    body: JSON.stringify({ sessionDescription: { type: "offer", sdp: offerSdp }, tracks }),
  });
  if (!r.ok) {
    trackUser(env, g.uid, g.email, "call_sfu_error", APP, {
      call_id: room, stage: "publish", status: r.status,
    });
    return json({ error: "publish_failed", status: r.status }, 502);
  }

  // Record the track names on the seat so the peer's /peer read is enough to pull
  // without any extra signalling message. On P2P the equivalent information was
  // announced over the WebSocket; going through the DO instead means a phone that
  // reconnects mid-call can rediscover the peer's tracks by polling, with no
  // dependency on a live socket at that instant.
  const names: Record<string, string> = {};
  for (const t of tracks) {
    const name = String(t.trackName);
    // `mid` "1" is video by the same convention the conference controller uses.
    if (rawTracks.some((rt) => (rt as Record<string, unknown>).trackName === name && (rt as Record<string, unknown>).kind === "video")) {
      names.videoTrack = name;
    } else {
      names.audioTrack = name;
    }
  }
  await roomFetch(env, room, "/sfu-seat", {
    method: "POST",
    body: JSON.stringify({ callId: room, uid: g.uid, sessionId, ...names }),
  }).catch(() => undefined);

  trackUser(env, g.uid, g.email, "call_sfu_published", APP, {
    call_id: room, session_id: sessionId, track_count: tracks.length,
    has_video: Boolean(names.videoTrack),
  });

  return json({ ok: true, answer: r.data.sessionDescription, tracks: r.data.tracks });
}

/**
 * GET /api/callsfu/:room/peer
 *
 * `seat: null` is a NORMAL answer, not an error: both phones mint their sessions
 * concurrently, so whoever asks first legitimately finds nothing. The client
 * retries. Returning 404 here would be indistinguishable from a real failure and
 * would push callers into an unnecessary fallback to P2P on every single call.
 */
export async function callSfuPeer(req: Request, env: Env, room: string): Promise<Response> {
  const g = await guard(req, env);
  if (g instanceof Response) return g;
  const r = await roomFetch(env, room, `/sfu-peer?callId=${encodeURIComponent(room)}&uid=${encodeURIComponent(g.uid)}`);
  const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  return json(body, r.status);
}

/**
 * POST /api/callsfu/:room/pull  — the SFU offers, the client answers.
 *
 * The remote session id is NOT taken from the request body. It is read from the
 * DO seat registry, which only ever holds the two participants of this call. If
 * the client could name an arbitrary session id, any authenticated user could
 * pull any other user's audio by guessing one — the single most dangerous thing
 * this module could get wrong.
 */
export async function callSfuPull(req: Request, env: Env, room: string): Promise<Response> {
  const g = await guard(req, env);
  if (g instanceof Response) return g;

  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const sessionId = typeof b.sessionId === "string" ? b.sessionId : "";
  const kind = b.kind === "video" ? "video" : "audio";
  if (!sessionId) return json({ error: "session_required" }, 400);
  if (kind === "video" && !g.video) return json({ error: "video_not_allowed", reason: "audio_only" }, 409);

  const peerRes = await roomFetch(env, room, `/sfu-peer?callId=${encodeURIComponent(room)}&uid=${encodeURIComponent(g.uid)}`);
  const peer = (await peerRes.json().catch(() => ({}))) as { seat?: { session_id?: string; audio_track?: string | null; video_track?: string | null } | null };
  const seat = peer.seat;
  if (!seat?.session_id) return json({ error: "peer_not_published", retry: true }, 409);

  const trackName = kind === "video" ? seat.video_track : seat.audio_track;
  if (!trackName) return json({ error: "peer_track_not_published", retry: true, kind }, 409);

  const r = await sfu(env, `/sessions/${sessionId}/tracks/new`, {
    method: "POST",
    body: JSON.stringify({ tracks: [{ location: "remote", sessionId: seat.session_id, trackName }] }),
  });
  if (!r.ok) {
    trackUser(env, g.uid, g.email, "call_sfu_error", APP, {
      call_id: room, stage: "pull", status: r.status, kind,
    });
    return json({ error: "pull_failed", status: r.status }, 502);
  }

  trackUser(env, g.uid, g.email, "call_sfu_pulled", APP, { call_id: room, session_id: sessionId, kind });

  return json({
    ok: true,
    offer: r.data.sessionDescription,
    tracks: r.data.tracks,
    renegotiate: r.data.requiresImmediateRenegotiation === true,
  });
}

/** PUT /api/callsfu/:room/renegotiate — deliver the client's answer to a pull offer. */
export async function callSfuRenegotiate(req: Request, env: Env, room: string): Promise<Response> {
  const g = await guard(req, env);
  if (g instanceof Response) return g;

  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const sessionId = typeof b.sessionId === "string" ? b.sessionId : "";
  const answer = b.answer as { sdp?: unknown } | undefined;
  const answerSdp = typeof answer?.sdp === "string" ? answer.sdp : "";
  if (!sessionId || !answerSdp) return json({ error: "session_and_answer_required" }, 400);

  const r = await sfu(env, `/sessions/${sessionId}/renegotiate`, {
    method: "PUT",
    body: JSON.stringify({ sessionDescription: { type: "answer", sdp: answerSdp } }),
  });
  if (!r.ok) {
    trackUser(env, g.uid, g.email, "call_sfu_error", APP, {
      call_id: room, stage: "renegotiate", status: r.status,
    });
    return json({ error: "renegotiate_failed", status: r.status }, 502);
  }
  return json({ ok: true });
}

/**
 * POST /api/callsfu/:room/close
 *
 * Clearing the seat matters as much as closing the tracks. A stale seat leaves
 * the peer pulling a dead session id, which produces silence with no error
 * anywhere — the client thinks it pulled successfully and the server thinks it
 * answered honestly. Best-effort on both, and never fails the call teardown.
 */
export async function callSfuClose(req: Request, env: Env, room: string): Promise<Response> {
  const g = await guard(req, env);
  if (g instanceof Response) return g;

  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const sessionId = typeof b.sessionId === "string" ? b.sessionId : "";
  const mids = Array.isArray(b.mids) ? b.mids.filter((m) => typeof m === "string") : [];

  if (sessionId && mids.length > 0) {
    await sfu(env, `/sessions/${sessionId}/tracks/close`, {
      method: "PUT",
      body: JSON.stringify({ tracks: mids.map((mid) => ({ mid })), force: b.force === true }),
    }).catch(() => undefined);
  }
  await roomFetch(env, room, "/sfu-seat-clear", {
    method: "POST",
    body: JSON.stringify({ uid: g.uid }),
  }).catch(() => undefined);

  trackUser(env, g.uid, g.email, "call_sfu_closed", APP, { call_id: room, session_id: sessionId, mid_count: mids.length });
  return json({ ok: true });
}
