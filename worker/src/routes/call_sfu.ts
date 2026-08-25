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
 *   POST /api/callsfu/:room/prepare -> establish the datachannel-only transport
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
import { trackException, trackUser } from "../hooks";
import { emailFor } from "../lib/identity";
import { readConfig } from "./config";
import { mintIceServersWithStatus } from "./media";
import { loadMessengerCallAuthorizationForParticipant, type MessengerCallAuthorizationRecord } from "./messenger_call_billing";

const APP = "avatok";

/**
 * [CALL-STAGE0A-1 2026-08-17] Telemetry must never sit on the media path.
 *
 * Every event in this module used to be `await`ed before the response returned
 * — my own change on 2026-08-16, made because workerd was DROPPING unawaited
 * queue sends ([TELEMETRY-AWAIT-1]). It fixed the drop and silently bought a
 * queue round trip on the latency of every join / publish / pull, i.e. on the
 * critical path of answering a call. `ctx.waitUntil` gives both: the send is
 * guaranteed to complete, and the response does not wait for it.
 *
 * SAMPLING. `rate` is deterministic **per call**, never per event: a call is
 * either fully recorded or fully absent, so a sampled timeline is never a
 * timeline with holes in it. Errors are never sampled.
 *
 * The rate is 1.0 today — the mechanism ships now, the reduction happens when
 * volume demands it, and the two are deliberately separate changes.
 *
 * NOTE for whoever lowers it: once successes are sampled, "the event is missing
 * therefore the code never ran" stops being a valid inference — that inference
 * caught three never-executing features this week. Add an unsampled
 * feature-entry breadcrumb before turning this down.
 */
const SFU_SUCCESS_SAMPLE_RATE = 1.0;

function sampledIn(callId: string, rate: number): boolean {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  // FNV-1a over the call id — stable across isolates, colos and both legs of
  // the same call, so caller and callee are sampled together or not at all.
  let h = 0x811c9dc5;
  for (let i = 0; i < callId.length; i++) {
    h ^= callId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h % 10000) / 10000 < rate;
}

/** Sampling wrapper around `trackUser`. Errors always pass. */
async function sfuTrack(
  env: Env,
  uid: string,
  event: string,
  app: string,
  props: Record<string, unknown> = {},
): Promise<void> {
  const isError = event.endsWith("_error") || event.endsWith("_blocked");
  const callId = typeof props.call_id === "string" ? props.call_id : "";
  if (!isError && callId && !sampledIn(callId, SFU_SUCCESS_SAMPLE_RATE)) return;
  // [CALL-STAGE0A-2 2026-08-17] The email lookup lives HERE, inside the work
  // `ctx.waitUntil` owns — not in `guard()`. It exists only to enrich
  // telemetry, so the media path must never wait on it. The in-isolate memo in
  // lib/identity.ts only accelerates warm hits; a cold hit is a KV read and can
  // fall through to Clerk, which is precisely the tail latency that must not
  // sit in front of join/publish/pull.
  const email = await emailFor(env, uid).catch(() => null);
  await trackUser(env, uid, email, event, app, props);
}

/**
 * ICE credential lifetime. 6h matches the group path deliberately: a 1:1 call
 * that outlives its TURN credentials would fail its next reconnect for a reason
 * with no relationship to the network, and 6h is far past any real call.
 */
const ICE_TTL_S = 6 * 3600;

/** Same ceiling the group path enforces, so both transports agree. */
const MAX_TRACK_NAME_LEN = 128;
const PREPARE_DATA_CHANNEL = "server-events";

/** Cloudflare Realtime is configured, or every route here fails closed. */
function sfuConfigured(env: Env): boolean {
  return Boolean(env.CF_RT_SFU_APP_ID && env.CF_RT_SFU_APP_TOKEN);
}

type SfuResult = { ok: boolean; status: number; data: Record<string, unknown> };

export type SfuDependency = "call_room" | "provider";
export type SfuDependencyAttempt<T> =
  | { ok: true; value: T }
  | { ok: false; dependency: SfuDependency; error: unknown };

/** Keep dependency exceptions inside the SFU route so clients can fall back. */
export async function attemptSfuDependency<T>(
  dependency: SfuDependency,
  operation: () => Promise<T>,
): Promise<SfuDependencyAttempt<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return { ok: false, dependency, error };
  }
}

export function sfuUnavailableBody(dependency: SfuDependency): Record<string, unknown> {
  return {
    error: "sfu_unavailable",
    reason: dependency === "call_room" ? "call_room_unavailable" : "provider_unavailable",
    fallback: true,
    retry: false,
  };
}

function dependencyUnavailable(
  env: Env,
  ctx: ExecutionContext,
  uid: string,
  room: string,
  stage: string,
  failure: Extract<SfuDependencyAttempt<never>, { ok: false }>,
): Response {
  const telemetry = {
    call_id: room,
    stage,
    status: 503,
    error_category: failure.dependency === "call_room" ? "call_room_do" : "sfu_provider",
    dependency: failure.dependency,
  };
  ctx.waitUntil(sfuTrack(env, uid, "call_sfu_error", APP, telemetry));
  ctx.waitUntil(trackException(env, failure.error, {
    uid,
    route: `/api/callsfu/:room/${stage}`,
    method: "DEPENDENCY",
    handled: true,
    app_name: APP,
    extra: telemetry,
  }));
  // Never expose exception text, provider bodies, session ids, or credentials.
  return json(sfuUnavailableBody(failure.dependency), 503);
}

/** A prewarm offer must not be able to smuggle media into the transport-only path. */
export function isDataChannelOnlySdp(sdp: string): boolean {
  const mediaSections = sdp.split(/\r?\n/).filter((line) => line.startsWith("m="));
  return mediaSections.length === 1 &&
    /^m=application\s+\d+\s+UDP\/DTLS\/SCTP\s+webrtc-datachannel(?:\s|$)/.test(mediaSections[0]);
}

/** Exact Cloudflare Realtime DataChannel establish payload. */
export function buildSfuPrepareBody(offerSdp: string): Record<string, unknown> {
  return {
    // Cloudflare's current Connection API expects camel-case `dataChannel`.
    // The lower-case spelling is accepted by neither the live endpoint nor
    // the official server-events example and caused every transport prewarm
    // to fail with provider status 400.
    dataChannel: { location: "remote", dataChannelName: PREPARE_DATA_CHANNEL },
    sessionDescription: { type: "offer", sdp: offerSdp },
  };
}

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

async function ownsSession(env: Env, room: string, uid: string, sessionId: string): Promise<boolean> {
  const r = await roomFetch(env, room, `/sfu-seat-self?callId=${encodeURIComponent(room)}&uid=${encodeURIComponent(uid)}`);
  if (!r.ok) return false;
  const b = (await r.json().catch(() => ({}))) as { seat?: { session_id?: string } | null };
  return b.seat?.session_id === sessionId;
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
type Guard = { uid: string; video: boolean };

async function guard(req: Request, env: Env, ctx: ExecutionContext): Promise<Guard | Response> {
  const cfg = await readConfig(env);
  const u = await requireUser(req, env);
  if (isFail(u)) return json({ error: (u as { error: string }).error }, (u as { status: number }).status);
  const uid = (u as { uid: string }).uid;

  if (!cfg.callSfuV1) {
    ctx.waitUntil(sfuTrack(env, uid, "call_sfu_blocked", APP, { reason: "flag_off" }));
    return json({ error: "sfu_unavailable", reason: "flag_off" }, 503);
  }
  if (!sfuConfigured(env)) {
    // Secrets missing. This is the branch that must never be silent: a
    // misconfigured environment and a working one would otherwise be
    // indistinguishable from the client, which is precisely how the TURN
    // "relay_degraded" blind spot happened on the P2P path.
    ctx.waitUntil(sfuTrack(env, uid, "call_sfu_blocked", APP, { reason: "unconfigured" }));
    return json({ error: "sfu_unavailable", reason: "unconfigured" }, 503);
  }
  return { uid, video: !cfg.callSfuAudioOnly };
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
export async function callSfuJoin(req: Request, env: Env, room: string, ctx: ExecutionContext): Promise<Response> {
  const g = await guard(req, env, ctx);
  if (g instanceof Response) return g;
  const startedAt = Date.now();
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  // Messenger audio has a separate admission boundary from the legacy SFU
  // transport. /api/call initializes the CallRoom context, but a client can
  // still call this route directly (or replay an old join), so the provider
  // session MUST NOT be minted until this route re-loads and validates the
  // immutable D1 authorization. All terms below come from D1; the request is
  // used only to carry the authorization identity already held by CallSession.
  // This branch is deliberately audio-only: video remains the Stream lane and
  // unrelated SFU behavior stays unchanged while the Messenger gate is dark.
  let messengerAudioAuthorization: MessengerCallAuthorizationRecord | null = null;
  const cfg = await readConfig(env);
  const roomBillingContext = cfg.messengerCallBillingEnabled === true
    ? await roomFetch(env, room, `/billing-context?callId=${encodeURIComponent(room)}`)
    .then(async (r) => r.ok ? await r.json().catch(() => null) as {
      ok?: boolean; authorization_id?: unknown; call_id?: unknown; payer_uid?: unknown; callee_uid?: unknown;
      media?: unknown; quality_sku?: unknown; provider?: unknown; price_version?: unknown;
    } | null : null)
    .catch(() => null)
    : null;
  const requestAuthorizationId = typeof body.authorization_id === "string" ? body.authorization_id.trim() : "";
  // This route is the 1:1 Messenger Cloudflare lane. Once the master is armed,
  // every join is billing-admitted; provider capability (`g.video`) and an
  // absent/stale CallRoom marker must never classify a request as legacy.
  if (cfg.messengerCallBillingEnabled === true) {
    const authorizationId = requestAuthorizationId;
    const attemptId = typeof body.attempt_id === "string" ? body.attempt_id.trim() : "";
    const clientPriceVersion = Number(body.price_version);
    if (!authorizationId || !attemptId || !Number.isInteger(clientPriceVersion)) {
      return json({ error: "messenger_audio_authorization_required", code: "authorization_required" }, 402);
    }
    const row = await loadMessengerCallAuthorizationForParticipant(env, authorizationId, g.uid, attemptId).catch(() => null);
    // The participant lookup is server-to-DO. It proves that the D1 callee is
    // the callee of this exact CallRoom, rather than accepting a client-chosen
    // peer identity. The caller is the authenticated SFU request user.
    const participants = await roomFetch(env, room, `/participants?callId=${encodeURIComponent(room)}`)
      .then(async (r) => r.ok ? await r.json().catch(() => null) as { callerUid?: unknown; calleeUid?: unknown } | null : null)
      .catch(() => null);
    const callerUid = typeof participants?.callerUid === "string" ? participants.callerUid : "";
    const calleeUid = typeof participants?.calleeUid === "string" ? participants.calleeUid : "";
    const now = Date.now();
    const valid = !!row && !!roomBillingContext && roomBillingContext.ok === true && row.authorization_id === authorizationId &&
      row.call_id === room &&
      roomBillingContext.authorization_id === row.authorization_id && roomBillingContext.call_id === row.call_id &&
      roomBillingContext.payer_uid === row.payer_uid && roomBillingContext.callee_uid === row.callee_uid &&
      roomBillingContext.media === row.media && roomBillingContext.quality_sku === row.quality_sku && roomBillingContext.provider === row.provider &&
      Number(roomBillingContext.price_version) === row.price_version &&
      row.payer_uid === callerUid && row.callee_uid === calleeUid &&
      (g.uid === callerUid || g.uid === calleeUid) &&
      row.media === "audio" &&
      row.quality_sku === "audio" && row.provider === "cloudflare" &&
      row.attempt_id === attemptId && row.price_version === clientPriceVersion &&
      row.status === "authorized" && (row.expires_at <= 0 || row.expires_at > now);
    if (!valid) {
      ctx.waitUntil(sfuTrack(env, g.uid, "call_sfu_blocked", APP, {
        call_id: room, reason: "messenger_audio_authorization_invalid",
        authorization_id: authorizationId,
      }));
      return json({ error: "messenger_audio_authorization_invalid", code: "authorization_invalid" }, 409);
    }
    messengerAudioAuthorization = row;
  }

  const prewarm = body.prewarm as Record<string, unknown> | undefined;
  const prewarmNonce = typeof prewarm?.nonce === "string" ? prewarm.nonce.slice(0, 128) : "";
  const prewarmDeviceId = typeof prewarm?.deviceId === "string" ? prewarm.deviceId.trim().slice(0, 128) : "";
  const rawPrewarmGeneration = Number(prewarm?.generation);
  const prewarmGeneration = Number.isFinite(rawPrewarmGeneration) ? Math.max(1, Math.round(rawPrewarmGeneration)) : null;
  const taggedPrewarm = Boolean(prewarmNonce || prewarmDeviceId || prewarmGeneration != null);
  if (taggedPrewarm && (!prewarmNonce || !prewarmDeviceId || prewarmGeneration == null)) {
    return json({ error: "prewarm_identity_required" }, 400);
  }

  // [CALL-SFU-LAT-1] The Realtime session mint and the TURN credential mint are
  // independent network calls; running them serially put the full ICE-mint
  // latency inside every join. The 2026-08-16 audited call spent ~1.6s in
  // /join alone (client stage sfu_begin→sfu_join) — this and the phase timings
  // below are that finding turned into code.
  const sfuStart = Date.now();
  const [sAttempt, iceAttempt] = await Promise.all([
    attemptSfuDependency("provider", () => sfu(env, "/sessions/new", { method: "POST" })),
    attemptSfuDependency("provider", () => mintIceServersWithStatus(env, ICE_TTL_S)),
  ]);
  if (!sAttempt.ok) return dependencyUnavailable(env, ctx, g.uid, room, "session_new", sAttempt);
  if (!iceAttempt.ok) return dependencyUnavailable(env, ctx, g.uid, room, "ice_mint", iceAttempt);
  const s = sAttempt.value;
  const ice = iceAttempt.value;
  const sfuMs = Date.now() - sfuStart;
  const sessionId = typeof s.data.sessionId === "string" ? s.data.sessionId : "";
  if (!s.ok || !sessionId) {
    ctx.waitUntil(sfuTrack(env, g.uid, "call_sfu_error", APP, {
      call_id: room, stage: "session_new", status: s.status,
      error_category: "sfu_provider", dependency: "provider",
    }));
    return json({ error: "sfu_session_failed", status: s.status }, 502);
  }

  // Register the seat BEFORE returning. If this fails the client holds a session
  // the peer can never discover, which presents as a connected call with silence
  // — the worst possible failure shape. Better to fail the join and let the
  // client fall back to P2P while it still can.
  const seatStart = Date.now();
  const seatAttempt = await attemptSfuDependency("call_room", () => roomFetch(env, room, "/sfu-seat", {
    method: "POST",
    body: JSON.stringify({
      callId: room, uid: g.uid, sessionId,
      ...(messengerAudioAuthorization ? {
        // Server-frozen identifiers let CallRoom correlate this seat with the
        // billed CallSession. Never copy payer/provider/rate from the request.
        authorization_id: messengerAudioAuthorization.authorization_id,
        attempt_id: messengerAudioAuthorization.attempt_id,
        price_version: messengerAudioAuthorization.price_version,
        billing_call_id: messengerAudioAuthorization.call_id,
      } : {}),
      ...(taggedPrewarm ? {
        deviceId: prewarmDeviceId,
        prewarmNonce,
        prewarmGeneration,
      } : {}),
    }),
  }));
  if (!seatAttempt.ok) return dependencyUnavailable(env, ctx, g.uid, room, "seat_register", seatAttempt);
  const seatRes = seatAttempt.value;
  if (!seatRes.ok) {
    ctx.waitUntil(sfuTrack(env, g.uid, "call_sfu_error", APP, {
      call_id: room, stage: "seat_register", status: seatRes.status,
      error_category: "call_room_do", dependency: "call_room",
    }));
    return json({ error: "sfu_seat_failed", status: seatRes.status }, seatRes.status === 403 ? 403 : 502);
  }

  ctx.waitUntil(sfuTrack(env, g.uid, "call_sfu_joined", APP, {
    call_id: room,
    session_id: sessionId,
    video_allowed: messengerAudioAuthorization ? false : g.video,
    prewarm: taggedPrewarm,
    relay_available: !ice.relayDegraded,
    relay_degraded: ice.relayDegraded,
    elapsed_ms: Date.now() - startedAt,
    // [CALL-SFU-LAT-1] Phase timings: sfu_ms covers the parallel Realtime
    // session + ICE mint (the max of the two), seat_ms the DO write. The
    // difference to elapsed_ms is guard overhead (auth + email + config).
    sfu_ms: sfuMs,
    seat_ms: Date.now() - seatStart,
  }));

  return json({
    ok: true,
    provider: "cloudflare_realtime",
    call_id: room,
    session_id: sessionId,
    ice_servers: ice.iceServers,
    relay_available: !ice.relayDegraded,
    relay_degraded: ice.relayDegraded,
    ...(ice.relayReason ? { relay_reason: ice.relayReason } : {}),
    media: { audio: true, video: messengerAudioAuthorization ? false : g.video },
  });
}

/**
 * POST /api/callsfu/:room/prepare — establish a datachannel-only transport.
 *
 * Cloudflare's `/datachannels/establish` endpoint accepts an optional client
 * offer and returns the SFU answer. This route deliberately accepts only an
 * application m-line: prewarm is transport-only and must never become a media
 * publish bypass. The DO marker is written only after Cloudflare accepts the
 * offer, and is bound to the authenticated uid's currently owned seat.
 */
export async function callSfuPrepare(req: Request, env: Env, room: string, ctx: ExecutionContext): Promise<Response> {
  const g = await guard(req, env, ctx);
  if (g instanceof Response) return g;

  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const sessionId = typeof b.sessionId === "string" ? b.sessionId : "";
  const offer = b.offer as { type?: unknown; sdp?: unknown } | undefined;
  const offerSdp = typeof offer?.sdp === "string" ? offer.sdp : "";
  const offerType = typeof offer?.type === "string" ? offer.type : "offer";
  if (!sessionId || !offerSdp || offerType !== "offer") {
    return json({ error: "session_and_offer_required" }, 400);
  }
  if (!isDataChannelOnlySdp(offerSdp)) {
    return json({ error: "datachannel_only_offer_required" }, 400);
  }
  const ownership = await attemptSfuDependency("call_room", () => ownsSession(env, room, g.uid, sessionId));
  if (!ownership.ok) return dependencyUnavailable(env, ctx, g.uid, room, "prepare_ownership", ownership);
  if (!ownership.value) {
    return json({ error: "session_not_owned" }, 403);
  }

  const providerAttempt = await attemptSfuDependency("provider", () => sfu(env, `/sessions/${encodeURIComponent(sessionId)}/datachannels/establish`, {
    method: "POST",
    body: JSON.stringify(buildSfuPrepareBody(offerSdp)),
  }));
  if (!providerAttempt.ok) return dependencyUnavailable(env, ctx, g.uid, room, "prepare", providerAttempt);
  const r = providerAttempt.value;
  if (!r.ok) {
    ctx.waitUntil(sfuTrack(env, g.uid, "call_sfu_error", APP, {
      call_id: room, session_id: sessionId, stage: "prepare", status: r.status,
      error_category: "sfu_provider", dependency: "provider",
    }));
    return json({ error: "prepare_failed", status: r.status }, 502);
  }
  const providerAnswer = r.data.sessionDescription as { type?: unknown; sdp?: unknown } | undefined;
  if (r.data.requiresImmediateRenegotiation === true ||
      providerAnswer?.type !== "answer" || typeof providerAnswer.sdp !== "string" || !providerAnswer.sdp) {
    ctx.waitUntil(sfuTrack(env, g.uid, "call_sfu_error", APP, {
      call_id: room, session_id: sessionId, stage: "prepare_contract",
      requires_renegotiation: r.data.requiresImmediateRenegotiation === true,
    }));
    return json({ error: "prepare_contract_unsupported" }, 502);
  }

  // The marker is intentionally a separate DO operation: generic seat writes
  // from media publish must not be able to claim transport readiness.
  const markerAttempt = await attemptSfuDependency("call_room", () => roomFetch(env, room, "/sfu-seat-prepare", {
    method: "POST",
    body: JSON.stringify({ callId: room, uid: g.uid, sessionId }),
  }));
  if (!markerAttempt.ok) return dependencyUnavailable(env, ctx, g.uid, room, "prepare_marker", markerAttempt);
  const marked = markerAttempt.value;
  if (!marked.ok) {
    ctx.waitUntil(sfuTrack(env, g.uid, "call_sfu_error", APP, {
      call_id: room, session_id: sessionId, stage: "prepare_marker", status: marked.status,
      error_category: "call_room_do", dependency: "call_room",
    }));
    return json({ error: "sfu_prepare_marker_failed", status: marked.status }, 502);
  }

  ctx.waitUntil(sfuTrack(env, g.uid, "call_sfu_prepared", APP, {
    call_id: room, session_id: sessionId, datachannel: PREPARE_DATA_CHANNEL,
  }));
  return json({ ok: true, session_id: sessionId, datachannel: PREPARE_DATA_CHANNEL,
    answer: providerAnswer, requires_immediate_renegotiation: false });
}

/**
 * POST /api/callsfu/:room/publish  — client offers, SFU answers.
 *
 * `location` is forced to "local" and only `mid` / `trackName` are taken from the
 * client, so a malformed or hostile body cannot turn a publish into a pull of
 * somebody else's session. Same shape as the group path.
 */
export async function callSfuPublish(req: Request, env: Env, room: string, ctx: ExecutionContext): Promise<Response> {
  const startedAt = Date.now(); // [CALL-SFU-LAT-1]
  const g = await guard(req, env, ctx);
  if (g instanceof Response) return g;

  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const sessionId = typeof b.sessionId === "string" ? b.sessionId : "";
  const preaccept = b.preaccept as Record<string, unknown> | undefined;
  const preacceptNonce = typeof preaccept?.nonce === "string" ? preaccept.nonce.slice(0, 128) : "";
  const preacceptDeviceId = typeof preaccept?.deviceId === "string" ? preaccept.deviceId.trim().slice(0, 128) : "";
  const rawPreacceptGeneration = Number(preaccept?.generation);
  const preacceptGeneration = Number.isFinite(rawPreacceptGeneration) ? Math.max(1, Math.round(rawPreacceptGeneration)) : null;
  const preacceptMedia = Boolean(preaccept);
  const offer = b.offer as { sdp?: unknown } | undefined;
  const offerSdp = typeof offer?.sdp === "string" ? offer.sdp : "";
  const rawTracks = Array.isArray(b.tracks) ? b.tracks : [];
  if (!sessionId || !offerSdp || rawTracks.length === 0) {
    return json({ error: "session_offer_and_tracks_required" }, 400);
  }
  if (preacceptMedia && (!preacceptNonce || !preacceptDeviceId || preacceptGeneration == null)) {
    return json({ error: "preaccept_identity_required" }, 400);
  }
  const ownership = await attemptSfuDependency("call_room", () => ownsSession(env, room, g.uid, sessionId));
  if (!ownership.ok) return dependencyUnavailable(env, ctx, g.uid, room, "publish_ownership", ownership);
  if (!ownership.value) {
    return json({ error: "session_not_owned" }, 403);
  }

  if (preacceptMedia) {
    // Authorize against the live, serialized CallRoom lease immediately before
    // the provider operation. A self-seat read can be stale if another device
    // accepted or the prewarm deadline elapsed after that read.
    const authAttempt = await attemptSfuDependency("call_room", () => roomFetch(env, room, "/sfu-preaccept-authorize", {
      method: "POST",
      body: JSON.stringify({
        callId: room, uid: g.uid, sessionId,
        deviceId: preacceptDeviceId,
        prewarmNonce: preacceptNonce,
        prewarmGeneration: preacceptGeneration,
      }),
    }));
    if (!authAttempt.ok) return dependencyUnavailable(env, ctx, g.uid, room, "preaccept_authorize", authAttempt);
    const authRes = authAttempt.value;
    const authBody = (await authRes.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!authRes.ok || authBody.ok !== true) {
      ctx.waitUntil(sfuTrack(env, g.uid, "call_sfu_preaccept_blocked", APP, {
        call_id: room, session_id: sessionId, reason: authBody.error ?? "stale_prewarm_identity",
      }));
      return json({ error: authBody.error ?? "stale_prewarm", retry: false }, authRes.status === 409 ? 409 : 502);
    }
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
  if (preacceptMedia && (tracks.length !== 1 || String((rawTracks[0] as Record<string, unknown>).kind ?? "audio") !== "audio")) {
    return json({ error: "preaccept_audio_only_required" }, 400);
  }

  const sfuStart = Date.now(); // [CALL-SFU-LAT-1]
  const providerAttempt = await attemptSfuDependency("provider", () => sfu(env, `/sessions/${sessionId}/tracks/new`, {
    method: "POST",
    body: JSON.stringify({ sessionDescription: { type: "offer", sdp: offerSdp }, tracks }),
  }));
  if (!providerAttempt.ok) return dependencyUnavailable(env, ctx, g.uid, room, "publish", providerAttempt);
  const r = providerAttempt.value;
  const sfuMs = Date.now() - sfuStart;
  if (!r.ok) {
    ctx.waitUntil(sfuTrack(env, g.uid, "call_sfu_error", APP, {
      call_id: room, stage: "publish", status: r.status,
      error_category: "sfu_provider", dependency: "provider",
    }));
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
      names.videoMid = String(t.mid);
    } else {
      names.audioTrack = name;
      names.audioMid = String(t.mid);
    }
  }
  const seatAttempt = await attemptSfuDependency("call_room", () => roomFetch(env, room, "/sfu-seat", {
    method: "POST",
    body: JSON.stringify({
      callId: room, uid: g.uid, sessionId, ...names,
      ...(preacceptMedia ? {
        deviceId: preacceptDeviceId,
        prewarmNonce: preacceptNonce,
        prewarmGeneration: preacceptGeneration,
        preacceptMedia: true,
      } : {}),
    }),
  }));
  if (!seatAttempt.ok) return dependencyUnavailable(env, ctx, g.uid, room, "publish_marker", seatAttempt);
  const seatWrite = seatAttempt.value;
  if (preacceptMedia && !seatWrite.ok) {
    ctx.waitUntil(sfuTrack(env, g.uid, "call_sfu_preaccept_blocked", APP, {
      call_id: room, session_id: sessionId, reason: "media_marker_failed",
      status: seatWrite.status,
    }));
    return json({ error: "preaccept_media_marker_failed", retry: true }, 502);
  }
  if (!seatWrite.ok) {
    ctx.waitUntil(sfuTrack(env, g.uid, "call_sfu_error", APP, {
      call_id: room, stage: "publish_marker", status: seatWrite.status,
      error_category: "call_room_do", dependency: "call_room",
    }));
    return json(sfuUnavailableBody("call_room"), 503);
  }

  ctx.waitUntil(sfuTrack(env, g.uid, "call_sfu_published", APP, {
    call_id: room, session_id: sessionId, track_count: tracks.length,
    has_video: Boolean(names.videoTrack),
    preaccept_media: preacceptMedia,
    elapsed_ms: Date.now() - startedAt, sfu_ms: sfuMs, // [CALL-SFU-LAT-1]
  }));

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
export async function callSfuPeer(req: Request, env: Env, room: string, ctx: ExecutionContext): Promise<Response> {
  const g = await guard(req, env, ctx);
  if (g instanceof Response) return g;
  const peerAttempt = await attemptSfuDependency("call_room", () =>
    roomFetch(env, room, `/sfu-peer?callId=${encodeURIComponent(room)}&uid=${encodeURIComponent(g.uid)}`));
  if (!peerAttempt.ok) return dependencyUnavailable(env, ctx, g.uid, room, "peer_read", peerAttempt);
  const r = peerAttempt.value;
  const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (body.media_access === "blocked_callee_not_accepted") {
    ctx.waitUntil(sfuTrack(env, g.uid, "call_sfu_preaccept_blocked", APP, {
      call_id: room, stage: "peer", reason: "callee_not_accepted",
    }));
  }
  return json(body, r.status);
}

/** POST /api/callsfu/:room/heartbeat — renew the server-owned SFU lease. */
export async function callSfuHeartbeat(req: Request, env: Env, room: string, ctx: ExecutionContext): Promise<Response> {
  const g = await guard(req, env, ctx);
  if (g instanceof Response) return g;
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const sessionId = typeof b.sessionId === "string" ? b.sessionId : "";
  if (!sessionId) return json({ error: "session_required" }, 400);
  if (!(await ownsSession(env, room, g.uid, sessionId))) {
    return json({ error: "session_not_owned" }, 403);
  }
  const r = await roomFetch(env, room, "/sfu-seat-heartbeat", {
    method: "POST",
    body: JSON.stringify({ uid: g.uid, sessionId }),
  });
  return json(await r.json().catch(() => ({ ok: false })), r.status);
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
export async function callSfuPull(req: Request, env: Env, room: string, ctx: ExecutionContext): Promise<Response> {
  const startedAt = Date.now(); // [CALL-SFU-LAT-1]
  const g = await guard(req, env, ctx);
  if (g instanceof Response) return g;

  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const sessionId = typeof b.sessionId === "string" ? b.sessionId : "";
  const kind = b.kind === "video" ? "video" : "audio";
  if (!sessionId) return json({ error: "session_required" }, 400);
  if (kind === "video" && !g.video) return json({ error: "video_not_allowed", reason: "audio_only" }, 409);

  // [CALL-SFU-LAT-1] Ownership check and peer-seat read are two READS of the
  // same DO; running them serially charged every pull two DO round trips. Both
  // results are still enforced before anything is sent to the SFU, so the
  // authorization semantics are unchanged — the peer read is merely discarded
  // when ownership fails.
  const [ownership, peerAttempt] = await Promise.all([
    attemptSfuDependency("call_room", () => ownsSession(env, room, g.uid, sessionId)),
    attemptSfuDependency("call_room", () =>
      roomFetch(env, room, `/sfu-peer?callId=${encodeURIComponent(room)}&uid=${encodeURIComponent(g.uid)}`)),
  ]);
  if (!ownership.ok) return dependencyUnavailable(env, ctx, g.uid, room, "pull_ownership", ownership);
  if (!peerAttempt.ok) return dependencyUnavailable(env, ctx, g.uid, room, "pull_peer_read", peerAttempt);
  if (!ownership.value) return json({ error: "session_not_owned" }, 403);
  const peerRes = peerAttempt.value;
  const peer = (await peerRes.json().catch(() => ({}))) as {
    seat?: { session_id?: string; audio_track?: string | null; video_track?: string | null } | null;
    media_access?: string;
  };
  if (peer.media_access === "blocked_callee_not_accepted") {
    ctx.waitUntil(sfuTrack(env, g.uid, "call_sfu_preaccept_blocked", APP, {
      call_id: room, stage: "pull", kind, reason: "callee_not_accepted",
    }));
    return json({ error: "callee_not_accepted", retry: true, kind }, 409);
  }
  const seat = peer.seat;
  if (!seat?.session_id) return json({ error: "peer_not_published", retry: true }, 409);

  const trackName = kind === "video" ? seat.video_track : seat.audio_track;
  if (!trackName) return json({ error: "peer_track_not_published", retry: true, kind }, 409);

  const sfuStart = Date.now(); // [CALL-SFU-LAT-1]
  const providerAttempt = await attemptSfuDependency("provider", () => sfu(env, `/sessions/${sessionId}/tracks/new`, {
    method: "POST",
    body: JSON.stringify({ tracks: [{ location: "remote", sessionId: seat.session_id, trackName }] }),
  }));
  if (!providerAttempt.ok) return dependencyUnavailable(env, ctx, g.uid, room, "pull", providerAttempt);
  const r = providerAttempt.value;
  if (!r.ok) {
    ctx.waitUntil(sfuTrack(env, g.uid, "call_sfu_error", APP, {
      call_id: room, stage: "pull", status: r.status, kind,
      error_category: "sfu_provider", dependency: "provider",
    }));
    return json({ error: "pull_failed", status: r.status }, 502);
  }

  ctx.waitUntil(sfuTrack(env, g.uid, "call_sfu_pulled", APP, {
    call_id: room, session_id: sessionId, kind,
    elapsed_ms: Date.now() - startedAt, sfu_ms: Date.now() - sfuStart, // [CALL-SFU-LAT-1]
  }));

  return json({
    ok: true,
    offer: r.data.sessionDescription,
    tracks: r.data.tracks,
    renegotiate: r.data.requiresImmediateRenegotiation === true,
  });
}

/** PUT /api/callsfu/:room/renegotiate — deliver the client's answer to a pull offer. */
export async function callSfuRenegotiate(req: Request, env: Env, room: string, ctx: ExecutionContext): Promise<Response> {
  const g = await guard(req, env, ctx);
  if (g instanceof Response) return g;

  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const sessionId = typeof b.sessionId === "string" ? b.sessionId : "";
  const answer = b.answer as { sdp?: unknown } | undefined;
  const answerSdp = typeof answer?.sdp === "string" ? answer.sdp : "";
  if (!sessionId || !answerSdp) return json({ error: "session_and_answer_required" }, 400);
  if (!(await ownsSession(env, room, g.uid, sessionId))) {
    return json({ error: "session_not_owned" }, 403);
  }

  const sfuStart = Date.now(); // [CALL-SFU-LAT-1]
  const r = await sfu(env, `/sessions/${sessionId}/renegotiate`, {
    method: "PUT",
    body: JSON.stringify({ sessionDescription: { type: "answer", sdp: answerSdp } }),
  });
  if (!r.ok) {
    ctx.waitUntil(sfuTrack(env, g.uid, "call_sfu_error", APP, {
      call_id: room, stage: "renegotiate", status: r.status,
    }));
    return json({ error: "renegotiate_failed", status: r.status }, 502);
  }
  ctx.waitUntil(sfuTrack(env, g.uid, "call_sfu_renegotiated", APP, {
    call_id: room, session_id: sessionId, sfu_ms: Date.now() - sfuStart, // [CALL-SFU-LAT-1]
  }));
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
export async function callSfuClose(req: Request, env: Env, room: string, ctx: ExecutionContext): Promise<Response> {
  const g = await guard(req, env, ctx);
  if (g instanceof Response) return g;

  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const sessionId = typeof b.sessionId === "string" ? b.sessionId : "";
  const mids = Array.isArray(b.mids) ? b.mids.filter((m) => typeof m === "string") : [];

  if (sessionId) {
    if (!(await ownsSession(env, room, g.uid, sessionId))) {
      return json({ error: "session_not_owned" }, 403);
    }
    const seatRes = await roomFetch(env, room, `/sfu-seat-self?callId=${encodeURIComponent(room)}&uid=${encodeURIComponent(g.uid)}`);
    const seatBody = seatRes.ok
      ? (await seatRes.json().catch(() => ({}))) as { seat?: Record<string, unknown> | null }
      : {};
    const seat = seatBody.seat ?? null;
    const effectiveMids = mids.length > 0
      ? mids
      : [seat?.audio_mid, seat?.video_mid].filter((m): m is string => typeof m === "string" && m.length > 0);
    if (effectiveMids.length > 0) {
      await sfu(env, `/sessions/${sessionId}/tracks/close`, {
        method: "PUT",
        body: JSON.stringify({ tracks: effectiveMids.map((mid) => ({ mid })), force: b.force === true }),
      }).catch(() => undefined);
    }
  }
  await roomFetch(env, room, "/sfu-seat-clear", {
    method: "POST",
    body: JSON.stringify({ uid: g.uid }),
  }).catch(() => undefined);

  ctx.waitUntil(sfuTrack(env, g.uid, "call_sfu_closed", APP, { call_id: room, session_id: sessionId, mid_count: mids.length }));
  return json({ ok: true });
}
