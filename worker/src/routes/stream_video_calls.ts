// Stream 1:1 audio call control plane.
//
// This is deliberately separate from routes/stream.ts, which owns Cloudflare
// Stream Live webhooks. Nothing in this module is reachable until the
// streamCallPilotEnabled platform flag is explicitly enabled. Despite the
// retained rollout-key name, production is audio-only; video and groups stay
// outside this provider.
//
// Stream references:
// - https://getstream.io/video/docs/api/authentication/
// - https://getstream.io/video/docs/api/calls/
// - https://getstream.io/docs/platform/webhooks/
//
// The Worker mints short-lived user JWTs and creates ring calls server-side.
// The API secret is never returned to the client. Webhooks verify the raw body
// with HMAC-SHA256 (including Stream's optional gzip payload form) and use the
// stable X-Webhook-Id as a D1 idempotency key.

import type { Env } from "../types";
import { json } from "../util";
import { isFail, requireUser } from "../authz";
import { admitCall, unavailableBody, CALLER_VISIBLE_OUTCOME, CALLER_VISIBLE_COPY } from "../lib/call_admission";
import { nameFor, emailFor } from "../lib/identity";
import { readConfig } from "./config";
import { emitCallEvent, CallEvent } from "../lib/call_telemetry_events";
// [STREAM-AUTH-1 2026-08-21] The checks the Stream lane was bypassing.
import { track, trackUser } from "../hooks";
import { callerContactPolicy, shouldRouteUnknownAvatokCaller } from "../lib/call_contact_directory";
import { APP_BUILD_HEADER, UPDATE_REQUIRED_MESSAGE, callMinBuildFrom, clientBuildFrom } from "../lib/call_build_gate";

const PROVIDER = "stream" as const;
const CALL_TYPE = "default";
const SERVER_TOKEN_TTL_SECONDS = 15 * 60;
// The Android Application must be able to restore Stream before Flutter/Clerk
// starts when a killed app receives an incoming-call push. This user-scoped
// token is encrypted on-device, refreshed whenever AvaTOK opens, and cleared
// on logout/account switch. Staging remains allowlisted; production requires
// the explicit flag, rollout percentage, credentials, and capable client.
const BACKGROUND_USER_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const IDEMPOTENCY_TTL_SECONDS = 10 * 60;
const WEBHOOK_ID_MAX = 256;
const USER_ID_MAX = 128;
const CALL_ID_MAX = 128;
// [STREAM-ENFORCE-2 2026-08-21] POST /api/stream-calls/place hardening.
// How long a client-supplied `attempt_id` dedupes a retry to the SAME
// approval/call_id. Generous enough to cover a phone's normal retry/backoff
// window, short enough that a genuinely new call attempt minutes later still
// mints its own id.
const PLACE_ATTEMPT_TTL_SECONDS = 2 * 60;
// One bounded budget for Stream user preparation + ringing. The app keeps the
// caller engaged while this runs, but the Worker must never continue a ring
// side effect after returning a terminal timeout.
const STREAM_PLACE_TOTAL_DEADLINE_MS = 7_500;
// How long an approved-and-not-yet-ended Stream call counts as "live" for
// glare detection (job 3, plan §8). Conservative: long enough to catch the
// realistic window between A dialing B and B dialing back before either side
// answers, short enough that a call whose `call.ended`/`call.session_ended`
// webhook never arrives (Stream outage, dropped webhook) does not glare-trap
// every later call between the same two people forever.
const GLARE_LIVE_WINDOW_MS = 45_000;

export type CallProvider = "cloudflare" | "stream";
export type CallScope = "one_to_one" | "group";

export type CallProviderDecision = {
  provider: CallProvider;
  /** Stable bucket used for percentage rollout (0..99). */
  bucket: number;
  /** Effective rollout percentage after defensive clamping. */
  percent: number;
  allowlisted: boolean;
};

type StreamTokenPayload = {
  user_id: string;
  iat: number;
  exp: number;
};

type StreamServerTokenPayload = {
  server: true;
  iat: number;
  exp: number;
};

type StreamCallEvent = {
  type?: string;
  call_cid?: string;
  call?: { cid?: string; id?: string; type?: string; custom?: Record<string, unknown> };
  data?: { call_cid?: string; call?: { cid?: string; id?: string; custom?: Record<string, unknown> } };
  user?: { id?: string };
  reason?: string;
};

function enabled(config: { streamCallPilotEnabled?: boolean }): boolean {
  return config.streamCallPilotEnabled === true;
}

function pilotUsers(env: Env): Set<string> {
  return new Set(String(env.STREAM_VIDEO_PILOT_UIDS ?? "")
    .split(",").map((value) => value.trim()).filter(Boolean));
}

function rolloutAllowed(env: Env, ...uids: string[]): boolean {
  if (env.ENVIRONMENT_NAME === "prod") return true;
  if (env.ENVIRONMENT_NAME !== "staging") return false;
  const allowed = pilotUsers(env);
  return allowed.size > 0 && uids.every((uid) => allowed.has(uid));
}

function rolloutPercent(config: { streamCallPilotPercent?: number }): number {
  const value = Number(config.streamCallPilotPercent ?? 0);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.floor(value)));
}

/**
 * Cheap deterministic bucket for a call attempt. A call id is part of the
 * seed, so the provider choice is sticky for retries of that call. The user
 * ids are included to avoid any accidental correlation if a caller reuses a
 * client-generated id across recipients.
 */
function rolloutBucket(callId: string, callerUid: string, calleeUid: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(`${callId}\u0000${callerUid}\u0000${calleeUid}`)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 100;
}

/**
 * Server-authoritative provider choice for a NEW call.
 *
 * Cloudflare is the fail-closed default. Stream requires the remote flag,
 * configured server credentials, an audio-only 1:1 call, the deterministic
 * percentage bucket, and an explicit Stream-capable client. Staging also
 * requires both users in its allowlist. The existing `/api/call` path invokes
 * this only for that opt-in capability, before its first legacy ring side
 * effect; old clients therefore remain byte-for-byte on Cloudflare.
 */
export function selectCallProvider(args: {
  config: { streamCallPilotEnabled?: boolean; streamCallPilotPercent?: number };
  env: Env;
  callerUid: string;
  calleeUid: string;
  callId: string;
  scope?: CallScope;
  media?: "audio" | "video";
  clientSupportsStream?: boolean;
}): CallProviderDecision {
  const percent = rolloutPercent(args.config);
  const bucket = rolloutBucket(args.callId, args.callerUid, args.calleeUid);
  const allowlisted = rolloutAllowed(args.env, args.callerUid, args.calleeUid);
  const stream = args.config.streamCallPilotEnabled === true
    && (args.scope ?? "one_to_one") === "one_to_one"
    && (args.media ?? "audio") === "audio"
    && args.clientSupportsStream === true
    && streamConfigured(args.env)
    && allowlisted
    && percent > bucket;
  return { provider: stream ? "stream" : "cloudflare", bucket, percent, allowlisted };
}

function b64url(value: Uint8Array | string): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function hmac(secret: string, data: string | ArrayBuffer): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, typeof data === "string" ? new TextEncoder().encode(data) : data));
}

function fixedTimeEqual(a: string, b: string): boolean {
  const aa = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  let diff = aa.length ^ bb.length;
  const length = Math.max(aa.length, bb.length);
  for (let i = 0; i < length; i++) diff |= (aa[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

async function signJwt(secret: string, payload: StreamTokenPayload | StreamServerTokenPayload): Promise<string> {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const signature = b64url(await hmac(secret, `${header}.${body}`));
  return `${header}.${body}.${signature}`;
}

async function streamServerToken(env: Env): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signJwt(env.STREAM_VIDEO_API_SECRET as string, {
    server: true,
    iat: now,
    exp: now + SERVER_TOKEN_TTL_SECONDS,
  });
}

async function streamUserToken(env: Env, uid: string): Promise<{ token: string; expiresAt: number }> {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + BACKGROUND_USER_TOKEN_TTL_SECONDS;
  return {
    token: await signJwt(env.STREAM_VIDEO_API_SECRET as string, { user_id: uid, iat: now, exp: expiresAt }),
    expiresAt,
  };
}

function validUid(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= USER_ID_MAX && /^[A-Za-z0-9_:@.-]+$/.test(value);
}

function validCallId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= CALL_ID_MAX && /^[A-Za-z0-9_:@.-]+$/.test(value);
}

type StickyProviderRecord = {
  provider: CallProvider;
  caller_uid: string;
  callee_uid: string;
  scope: CallScope;
  chosen_at: number;
  bucket: number;
  percent: number;
};

async function readStickyProvider(env: Env, callId: string): Promise<StickyProviderRecord | null> {
  try {
    const value = await env.DB_META.prepare(
      "SELECT provider, caller_uid, callee_uid, scope, chosen_at, bucket, percent FROM stream_video_provider_decisions WHERE call_id=?1",
    ).bind(callId).first<StickyProviderRecord>();
    if (!value || (value.provider !== "stream" && value.provider !== "cloudflare")) return null;
    if (value.scope !== "one_to_one" && value.scope !== "group") return null;
    return value;
  } catch {
    // A missing/unavailable authority is treated as no decision on reads; the
    // first-write path below fails closed instead of ringing a provider.
    return null;
  }
}

async function persistStickyProvider(env: Env, callId: string, record: StickyProviderRecord): Promise<StickyProviderRecord | null> {
  try {
    // INSERT OR IGNORE is the concurrency gate. Whichever request first
    // claims a call id wins; the SELECT returns the authoritative winner to
    // the losing request, so a percentage flip cannot migrate the call.
    await env.DB_META.prepare(
      "INSERT OR IGNORE INTO stream_video_provider_decisions (call_id, provider, caller_uid, callee_uid, scope, chosen_at, bucket, percent) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    ).bind(callId, record.provider, record.caller_uid, record.callee_uid, record.scope, record.chosen_at, record.bucket, record.percent).run();
    return await readStickyProvider(env, callId);
  } catch {
    return null;
  }
}

/**
 * Glare detection (job 3, plan §8): is there ALREADY a live Stream call with
 * `callerUid` (the reverse direction's callee) as the ORIGINAL caller and
 * `calleeUid` (the reverse direction's caller) as the ORIGINAL callee? If A
 * called B and that call is still live, B calling A back should join A's
 * call, not mint a second one.
 *
 * Requires the `ended_at` column and pair index from
 * worker/migrations/2026-08-21-stream-call-place-hardening.sql. If that
 * migration has not been applied to prod yet, the query throws (unknown
 * column) and this fails OPEN — glare detection is simply unavailable, the
 * same "not yet migrated" posture the rest of this file already documents for
 * `stream_video_provider_decisions`. It does not affect the fail-CLOSED
 * behaviour of the authority record itself (see `persistStickyProvider`
 * call site in `streamCallPlace`).
 */
async function readLiveCounterCall(
  env: Env,
  callerUid: string,
  calleeUid: string,
): Promise<(StickyProviderRecord & { call_id: string }) | null> {
  try {
    const cutoff = Date.now() - GLARE_LIVE_WINDOW_MS;
    const row = await env.DB_META.prepare(
      `SELECT call_id, provider, caller_uid, callee_uid, scope, chosen_at, bucket, percent
       FROM stream_video_provider_decisions
       WHERE caller_uid=?1 AND callee_uid=?2 AND provider=?3 AND scope=?4
         AND chosen_at>=?5 AND ended_at IS NULL
       ORDER BY chosen_at DESC LIMIT 1`,
    ).bind(calleeUid, callerUid, PROVIDER, "one_to_one", cutoff)
      .first<StickyProviderRecord & { call_id: string }>();
    return row ?? null;
  } catch {
    return null;
  }
}

/** Marks a provider-decision row ended so it stops matching glare lookups.
 *  Best-effort: called from the webhook handler, which must never 500 just
 *  because this bookkeeping table isn't there yet. */
async function markProviderDecisionEnded(env: Env, callId: string): Promise<void> {
  try {
    await env.DB_META.prepare(
      "UPDATE stream_video_provider_decisions SET ended_at=?1 WHERE call_id=?2 AND ended_at IS NULL",
    ).bind(Date.now(), callId).run();
  } catch { /* migration not applied yet, or row doesn't exist — fine */ }
}

function streamConfigured(env: Env): boolean {
  return Boolean(env.STREAM_VIDEO_API_KEY && env.STREAM_VIDEO_API_SECRET);
}

function streamCallUrl(env: Env, callId: string): string {
  return `https://video.stream-io-api.com/api/v2/video/call/${CALL_TYPE}/${encodeURIComponent(callId)}?api_key=${encodeURIComponent(env.STREAM_VIDEO_API_KEY as string)}`;
}

function streamUsersUrl(env: Env): string {
  return `https://video.stream-io-api.com/api/v2/users?api_key=${encodeURIComponent(env.STREAM_VIDEO_API_KEY as string)}`;
}

function streamEndCallUrl(env: Env, callId: string): string {
  return `${streamCallUrl(env, callId).replace(/\?/, "/mark_ended?")}`;
}

async function fetchBefore(url: string, init: RequestInit, deadlineAt: number): Promise<Response> {
  if (!Number.isFinite(deadlineAt)) return await fetch(url, init);
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new DOMException("Stream deadline exceeded", "TimeoutError");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("Stream deadline exceeded"), remaining);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function ensureStreamUsers(
  env: Env,
  token: string,
  profiles: Array<{ id: string; name?: string }>,
  deadlineAt = Number.POSITIVE_INFINITY,
): Promise<boolean> {
  const users = Object.fromEntries(profiles.map((profile) => [profile.id, {
    id: profile.id,
    role: "user",
    ...(profile.name ? { name: profile.name } : {}),
  }]));
  try {
    const response = await fetchBefore(streamUsersUrl(env), {
      method: "POST",
      headers: { Authorization: token, "Content-Type": "application/json", "stream-auth-type": "jwt" },
      body: JSON.stringify({ users }),
    }, deadlineAt);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * [STREAM-ENFORCE-2 2026-08-21] Server-side call creation for the
 * authorization endpoint (`streamCallPlace`), job 1a.
 *
 * Before this, `POST /api/stream-calls/place` only approved and minted a call
 * id; the PHONE then called Stream's `getOrCreate(ringing:true)` directly
 * with its own user token. A modified client with a valid Stream user token
 * could skip `/place` entirely and ring anyone. This function makes the
 * Worker itself the thing that calls Stream, using the SERVER token (API
 * secret), so approval and creation happen in the same trusted place. The
 * client's job becomes JOIN only (contract agreed with STREAM-CALLFLOW-1).
 *
 * Deliberately duplicates (rather than reuses) the create-call POST that
 * `prepareStreamCall` above already does for the older percentage-rollout
 * lane. That lane is independently gated (`streamCallPilotEnabled`) and
 * working; refactoring it to share this helper would widen the blast radius
 * of this change for no behavioural benefit.
 */
async function createRingingStreamCall(env: Env, args: {
  callerUid: string;
  calleeUid: string;
  callId: string;
  video: boolean;
  traceId: string;
  deadlineAt: number;
  cancelled?: () => Promise<boolean>;
}): Promise<{ ok: true; usersMs: number; createMs: number; totalMs: number } | { ok: false; status: number; stage: string; elapsedMs: number }> {
  const startedAt = Date.now();
  let usersReady = false;
  try {
    const serverToken = await streamServerToken(env);
    const [callerName, calleeName] = await Promise.all([
      nameFor(env, args.callerUid).catch(() => null),
      nameFor(env, args.calleeUid).catch(() => null),
    ]);
    if (!await ensureStreamUsers(env, serverToken, [
      { id: args.callerUid, ...(callerName ? { name: callerName } : {}) },
      { id: args.calleeUid, ...(calleeName ? { name: calleeName } : {}) },
    ], args.deadlineAt)) {
      const timedOut = Date.now() >= args.deadlineAt;
      return {
        ok: false,
        status: timedOut ? 504 : 502,
        stage: timedOut ? "provider_timeout" : "ensure_users",
        elapsedMs: Date.now() - startedAt,
      };
    }
    usersReady = true;
    const usersReadyAt = Date.now();
    if (args.cancelled && await args.cancelled()) {
      return { ok: false, status: 409, stage: "cancelled", elapsedMs: Date.now() - startedAt };
    }
    const payload = {
      ring: true,
      video: args.video,
      data: {
        created_by_id: args.callerUid,
        members: [{ user_id: args.callerUid }, { user_id: args.calleeUid }],
        custom: {
          avatok_provider: PROVIDER,
          avatok_call_id: args.callId,
          avatok_trace_id: args.traceId,
          avatok_caller_uid: args.callerUid,
          avatok_callee_uid: args.calleeUid,
          video: args.video,
          lane: "streamlane",
        },
      },
    };
    const response = await fetchBefore(streamCallUrl(env, args.callId), {
      method: "POST",
      headers: { Authorization: serverToken, "Content-Type": "application/json", "stream-auth-type": "jwt" },
      body: JSON.stringify(payload),
    }, args.deadlineAt);
    if (!response.ok) return { ok: false, status: response.status >= 500 ? 502 : 400, stage: "stream_create", elapsedMs: Date.now() - startedAt };
    return { ok: true, usersMs: usersReadyAt - startedAt, createMs: Date.now() - usersReadyAt, totalMs: Date.now() - startedAt };
  } catch (error) {
    const timedOut = Date.now() >= args.deadlineAt || (error instanceof DOMException && error.name === "AbortError");
    return { ok: false, status: timedOut ? 504 : 502, stage: timedOut ? "provider_timeout" : (usersReady ? "stream_create" : "ensure_users"), elapsedMs: Date.now() - startedAt };
  }
}

async function endStreamCall(env: Env, callId: string): Promise<boolean> {
  try {
    const token = await streamServerToken(env);
    const response = await fetchBefore(streamEndCallUrl(env, callId), {
      method: "POST",
      headers: { Authorization: token, "stream-auth-type": "jwt" },
    }, Date.now() + 2_000);
    // A missing call is already safely not ringing.
    return response.ok || response.status === 404;
  } catch {
    return false;
  }
}

/** GET /api/stream-video/token — protected background-capable user token. */
export async function streamVideoToken(req: Request, env: Env): Promise<Response> {
  const config = await readConfig(env);
  if (!streamConfigured(env)) return json({ error: "stream video unavailable" }, 503);

  const auth = await requireUser(req, env);
  if (isFail(auth)) return json({ error: auth.error }, auth.status);
  const callId = new URL(req.url).searchParams.get("call_id");
  const existing = callId && validCallId(callId) ? await readStickyProvider(env, callId) : null;
  const existingStreamCall = existing?.provider === PROVIDER
    && (existing.caller_uid === auth.uid || existing.callee_uid === auth.uid);
  // A flag rollback blocks NEW Stream calls but does not strand an already
  // selected Stream call whose short-lived user token needs refreshing.
  // `streamCallsEnabled` is the separate kill switch for the new streamlane
  // client lane: when on, it mints tokens on its own terms and does not fall
  // through to the pilot rollout/allowlist gates below (which remain
  // untouched for `streamCallPilotEnabled` callers).
  const streamlane = config.streamCallsEnabled === true;
  if (!enabled(config) && !streamlane && !existingStreamCall) return json({ error: "stream video pilot disabled" }, 404);
  if (!existingStreamCall && !streamlane && !rolloutAllowed(env, auth.uid)) return json({ error: "stream audio unavailable" }, 404);
  const minted = await streamUserToken(env, auth.uid);
  return json({
    ok: true,
    provider: PROVIDER,
    api_key: env.STREAM_VIDEO_API_KEY,
    user_id: auth.uid,
    token: minted.token,
    expires_at: minted.expiresAt,
  });
}

/** Create a Stream call after the server has authenticated the caller. */
export async function prepareStreamCall(args: {
  env: Env;
  config: { streamCallPilotEnabled?: boolean; streamCallPilotPercent?: number };
  callerUid: string;
  calleeUid: string;
  callId: string;
  clientSupportsStream: boolean;
  scope?: CallScope;
  media?: "audio" | "video";
  idempotencyKey?: string | null;
  ctx?: ExecutionContext;
  admissionAlreadyGranted?: boolean;
  traceId?: string;
}): Promise<Response> {
  const { env, config, callerUid, calleeUid, callId, clientSupportsStream, ctx } = args;
  const traceId = args.traceId?.trim() || callId;
  const prepareStartedAt = Date.now();
  const scope = args.scope ?? "one_to_one";
  const idempotencyKey = args.idempotencyKey ?? null;
  const idemKey = idempotencyKey ? `stream-video:prepare:${callerUid}:${idempotencyKey}` : null;
  // Replay before provider selection. Without this ordering, a retry that did
  // not repeat the optional call_id could create a second sticky record even
  // though the idempotency result correctly returned the first Stream call.
  if (idemKey) {
    const prior = await env.TOKENS.get(idemKey, "json").catch(() => null) as Record<string, unknown> | null;
    if (prior) return json({ ...prior, idempotent_replay: true });
  }
  const existing = await readStickyProvider(env, callId);
  if (existing && (existing.caller_uid !== callerUid || existing.callee_uid !== calleeUid || existing.scope !== scope)) {
    return json({ error: "call_id already belongs to another call" }, 409);
  }
  if (!enabled(config) && existing?.provider !== PROVIDER) {
    // A rollback applies to new calls immediately. Return the ordinary legacy
    // decision so `/api/call` can continue without requiring an app rebuild.
    return json({
      ok: false,
      provider: "cloudflare",
      call_id: callId,
      fallback: "cloudflare",
      error: "stream video pilot disabled",
    }, 409);
  }
  // An old client cannot accidentally enter Stream merely because the server
  // flag is on. It must advertise the isolated Stream bridge explicitly.
  if (existing?.provider === PROVIDER && !clientSupportsStream) {
    return json({ ok: false, provider: "cloudflare", call_id: callId, fallback: "cloudflare", error: "stream capability required" }, 409);
  }
  const selected = selectCallProvider({
    config,
    env,
    callerUid,
    calleeUid,
    callId,
    scope,
    media: args.media,
    clientSupportsStream,
  });
  let decision: StickyProviderRecord = existing ?? {
    provider: selected.provider,
    caller_uid: callerUid,
    callee_uid: calleeUid,
    scope,
    chosen_at: Date.now(),
    bucket: selected.bucket,
    percent: selected.percent,
  };
  if (!existing && config.streamCallPilotEnabled === true) {
    // Persist the provider before admission can reach any ring side effect or
    // the Stream API. A retry with the same call id cannot switch providers if
    // an operator changes the percentage while the request is in flight.
    const persisted = await persistStickyProvider(env, callId, decision);
    if (!persisted) return json({ error: "call provider authority unavailable" }, 503);
    decision = persisted;
  }
  if (decision.provider !== PROVIDER) {
    // This is a control-plane answer, not a provider failure. The caller can
    // immediately use the unchanged Cloudflare `/api/call` path. A flag flip
    // therefore affects only NEW calls and never requires a client rebuild.
    return json({
      ok: false,
      provider: decision.provider,
      call_id: callId,
      fallback: "cloudflare",
      error: "stream video pilot not selected",
    }, 409);
  }
  if (!streamConfigured(env)) return json({ error: "stream video unavailable" }, 503);
  if (!args.admissionAlreadyGranted) {
    const admission = await admitCall(env, callerUid, calleeUid);
    if (!admission.admit) return json(unavailableBody());
  }
  const video = args.media === "video";
  const streamToken = await streamUserToken(env, callerUid);
  const serverToken = await streamServerToken(env);
  const payload = {
    ring: true,
    video,
    data: {
      created_by_id: callerUid,
      members: [{ user_id: callerUid }, { user_id: calleeUid }],
      custom: {
        avatok_provider: PROVIDER,
        avatok_call_id: callId,
        avatok_trace_id: traceId,
        avatok_caller_uid: callerUid,
        avatok_callee_uid: calleeUid,
        video,
      },
    },
  };

  let response: Response;
  let usersReadyAt = prepareStartedAt;
  try {
    const [callerName, calleeName] = await Promise.all([
      nameFor(env, callerUid).catch(() => null),
      nameFor(env, calleeUid).catch(() => null),
    ]);
    if (!await ensureStreamUsers(env, serverToken, [
      { id: callerUid, ...(callerName ? { name: callerName } : {}) },
      { id: calleeUid, ...(calleeName ? { name: calleeName } : {}) },
    ])) {
      return json({ error: "stream user preparation failed" }, 502);
    }
    usersReadyAt = Date.now();
    response = await fetch(streamCallUrl(env, callId), {
      method: "POST",
      headers: { Authorization: serverToken, "Content-Type": "application/json", "stream-auth-type": "jwt" },
      body: JSON.stringify(payload),
    });
  } catch {
    emitCallEvent(env, CallEvent.call_ended, {
      call_trace_id: traceId, call_id: callId, account_id: callerUid,
      rtc_provider: PROVIDER, ended_reason: "provider_failure",
      extra: {
        stage: "stream_create",
        user_prepare_ms: usersReadyAt - prepareStartedAt,
        stream_prepare_total_ms: Date.now() - prepareStartedAt,
      },
    }, ctx);
    return json({ error: "stream provider unavailable" }, 502);
  }

  if (!response.ok) {
    // Avoid echoing Stream's response body: it can contain provider internals.
    emitCallEvent(env, CallEvent.call_ended, {
      call_trace_id: traceId, call_id: callId, account_id: callerUid,
      rtc_provider: PROVIDER, ended_reason: "provider_failure",
      extra: {
        stage: "stream_create",
        status: response.status,
        user_prepare_ms: usersReadyAt - prepareStartedAt,
        provider_create_ms: Date.now() - usersReadyAt,
        stream_prepare_total_ms: Date.now() - prepareStartedAt,
      },
    }, ctx);
    return json({ error: "stream call creation failed" }, response.status >= 500 ? 502 : 400);
  }

  const result = {
    ok: true,
    provider: PROVIDER,
    call_type: CALL_TYPE,
    call_id: callId,
    api_key: env.STREAM_VIDEO_API_KEY,
    user_id: callerUid,
    token: streamToken.token,
    token_expires_at: streamToken.expiresAt,
    video,
    callee_uid: calleeUid,
    trace_id: traceId,
  };
  if (idemKey) await env.TOKENS.put(idemKey, JSON.stringify(result), { expirationTtl: IDEMPOTENCY_TTL_SECONDS }).catch(() => undefined);
  emitCallEvent(env, CallEvent.call_ring_started, {
    call_trace_id: traceId, call_id: callId, account_id: callerUid,
    rtc_provider: PROVIDER, authority_phase: "outgoing_ringing",
    extra: {
      callee_count: 1,
      media: video ? "video" : "audio",
      rollout_percent: decision.percent,
      rollout_bucket: decision.bucket,
      scope: decision.scope,
      user_prepare_ms: usersReadyAt - prepareStartedAt,
      provider_create_ms: Date.now() - usersReadyAt,
      stream_prepare_total_ms: Date.now() - prepareStartedAt,
    },
  }, ctx);
  return json(result);
}

/**
 * POST /api/stream-video/prepare
 * Body: { callee_uid: string, call_id?: string, stream_capable: true }
 *
 * This endpoint owns call creation and ringing. It never accepts the caller
 * identity from JSON; that identity comes from the verified Clerk JWT.
 */
export async function streamVideoPrepare(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const config = await readConfig(env);
  const auth = await requireUser(req, env);
  if (isFail(auth)) return json({ error: auth.error }, auth.status);
  let body: { callee_uid?: unknown; video?: unknown; call_id?: unknown; stream_capable?: unknown; scope?: unknown };
  try { body = await req.json() as { callee_uid?: unknown; video?: unknown; call_id?: unknown; stream_capable?: unknown; scope?: unknown }; } catch { return json({ error: "bad json" }, 400); }
  if (!validUid(body.callee_uid)) return json({ error: "invalid callee_uid" }, 400);
  if (body.callee_uid === auth.uid) return json({ error: "cannot call yourself" }, 400);
  if (body.call_id !== undefined && !validCallId(body.call_id)) return json({ error: "invalid call_id" }, 400);
  if (body.scope !== undefined && body.scope !== "one_to_one") return json({ error: "stream pilot is 1:1 only" }, 400);
  const idempotencyKey = req.headers.get("idempotency-key")?.trim();
  if (idempotencyKey && (idempotencyKey.length < 8 || idempotencyKey.length > 128)) return json({ error: "invalid idempotency-key" }, 400);
  return prepareStreamCall({
    env,
    config,
    callerUid: auth.uid,
    calleeUid: body.callee_uid,
    callId: validCallId(body.call_id) ? body.call_id : crypto.randomUUID(),
    clientSupportsStream: body.stream_capable === true,
    scope: "one_to_one",
    media: body.video === true ? "video" : "audio",
    idempotencyKey,
    traceId: req.headers.get("x-trace-id") ?? undefined,
    ctx,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// [STREAM-AUTH-1 2026-08-21] POST /api/stream-calls/place
//
// THE PROBLEM THIS FIXES (plan §8.1, owner's words):
//   "Stream should transport the sound and video, but your server must first
//    approve every call."
//
// `app/lib/streamlane/stream_call_service.dart` used to mint its own call id
// and go straight to `client.makeCall(...)` + `getOrCreate(ringing:true)`. That
// skipped EVERYTHING `POST /api/call` enforces before a phone can ring: the
// blocklist, the unknown-caller contact policy, the build floor, and the
// authoritative record of who was allowed to call whom. A blocked person could
// ring you; nothing on the server even knew the call existed.
//
// WHAT THIS ENDPOINT DOES.
//   DOES: authenticate the caller from the Clerk JWT (never from JSON), run the
//         same `admitCall` gate the legacy dial runs, apply the same
//         `callMinBuild` floor via the same `x-app-build` header contract,
//         apply the same unknown-caller contact policy, MINT the call id
//         server-side, record the authoritative provider decision, create and
//         ring through Stream with server credentials, and emit telemetry
//         tagged with BOTH parties' emails. The phone only joins the approved
//         call; it never creates or rings one itself.
//
// This is the authorisation half of the split. `prepareStreamCall` above is the
// OTHER, older lane (the `streamCallPilotEnabled` percentage rollout invoked
// from `/api/call`), which both authorises AND rings. The two are independent
// on purpose and `remote_config.dart:167-169` forbids both flags being on.
// ─────────────────────────────────────────────────────────────────────────────

/** Machine-readable refusal codes. The client keys on these, not on the copy. */
export type StreamPlaceRefusalCode =
  | "invalid_request"
  | "self_call"
  | "stream_calls_disabled"
  | "update_required"
  | "recipient_unavailable"
  | "receptionist"
  // [STREAM-ENFORCE-2 2026-08-21] additions below.
  | "authority_unavailable"
  | "stream_create_failed"
  | "call_cancelled";

type StreamPlaceBody = {
  callee_uid?: unknown;
  video?: unknown;
  app_build?: unknown;
  trace_id?: unknown;
  /** [STREAM-ENFORCE-2 2026-08-21] Client-generated UUID, one per user tap on
   *  "call". Same (caller_uid, attempt_id) within PLACE_ATTEMPT_TTL_SECONDS
   *  replays the SAME approval/call_id instead of minting a second call —
   *  covers double-tap and client retry-on-timeout. Contract agreed with
   *  STREAM-CALLFLOW-1, who adds this on the client side. Optional: a client
   *  that omits it gets no dedup protection from this layer (the pre-existing
   *  `admitCall`/build-gate checks still run).
   */
  attempt_id?: unknown;
};

function validAttemptId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 8 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value);
}

/**
 * POST /api/stream-calls/place
 *
 * Request  — Authorization: Bearer <clerk jwt> (required)
 *            x-app-build: <versionCode>        (optional; body `app_build` is
 *                                               the fallback — see call_build_gate.ts)
 *            x-trace-id:  <trace>              (optional)
 *            body { callee_uid: string, video?: boolean, app_build?: number,
 *                   trace_id?: string, attempt_id?: string }
 *
 * Approved — 200 { approved: true, provider: "stream", call_type: "default",
 *                  call_id, callee_uid, video, trace_id, created }
 *            `call_id` is SERVER-MINTED and is the id the client must use.
 *            [STREAM-ENFORCE-2 2026-08-21] `created` tells the client whether
 *            IT still needs to create the Stream call:
 *              created: true  → the Worker already called Stream's
 *                                `getOrCreate(ring:true)` server-side. The
 *                                client's ONLY job is to JOIN `call_id`. Do
 *                                NOT call `client.makeCall` / `getOrCreate`
 *                                again — that would re-ring or 409.
 *              created: false → an older/degraded path where the client must
 *                                create the call itself. Glare responses use
 *                                created:true (the counter-call exists — join
 *                                only; see the review-fix note at the glare
 *                                return site).
 *            This is the agreed contract with STREAM-CALLFLOW-1's client-side
 *            change — do not add fields without updating both sides.
 *
 * Refused  — { approved: false, code, message, ... }
 *            update_required        → 426, plus min_build / client_build
 *            stream_calls_disabled  → 503
 *            invalid_request        → 400
 *            self_call              → 400
 *            recipient_unavailable  → 200 (uniform denial, see below)
 *            receptionist           → 200, plus routing_reason
 *            authority_unavailable  → 503 (D1 authority record couldn't be
 *                                      written — see the AUTHORITATIVE RECORD
 *                                      section below; retryable)
 *            stream_create_failed   → 502/400 (Stream itself refused/errored
 *                                      creating the call; plus `stage`)
 *
 * Idempotency — an `attempt_id` (client UUID, one per user tap) replays the
 * exact same terminal response — approval OR refusal — for
 * PLACE_ATTEMPT_TTL_SECONDS instead of evaluating twice or minting a second
 * call id. Keyed by (caller_uid, attempt_id) in KV (`env.TOKENS`); best-effort,
 * never blocks the request if KV is unavailable.
 *
 * Glare — if the CALLEE already has a live Stream call ringing/connected TO
 * this caller (i.e. they dialled each other within GLARE_LIVE_WINDOW_MS of
 * one another), this returns that EXISTING call_id with
 * `code: "glare_join_existing"` / `created: false` instead of minting and
 * ringing a second call for the same conversation.
 *
 * WHY `recipient_unavailable` IS A 200 WITH THE SAME COPY FOR EVERY CAUSE.
 * lib/call_admission.ts, owner ruling B: blocked / offline / privacy_mode /
 * rate_limited / no_callable_device must be indistinguishable to the caller,
 * because a uniquely fast or uniquely worded failure is a perfect blocked-status
 * oracle. Do not "improve" this copy to be more specific; specificity is the
 * leak. The internal reason is emitted server-side only.
 */
export async function streamCallPlace(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const requestStartedAt = Date.now();
  const auth = await requireUser(req, env);
  if (isFail(auth)) return json({ error: auth.error }, auth.status);

  let body: StreamPlaceBody;
  try { body = await req.json() as StreamPlaceBody; } catch { body = {}; }

  const traceId = (req.headers.get("x-trace-id") ?? String(body.trace_id ?? "")).trim().slice(0, 128);
  const video = body.video === true;
  const callerUid = auth.uid;
  const calleeUid = validUid(body.callee_uid) ? body.callee_uid : "";
  // Minted HERE, not by the phone. This is the whole point of the endpoint: the
  // call identity is the server's, and the `sl-` prefix is kept so the existing
  // `stream_lane_*` PostHog series stays continuous with the client-minted ids.
  const callId = `sl-${crypto.randomUUID()}`;

  // ── ATTEMPT-ID DEDUP (job 3) ────────────────────────────────────────────
  // Same caller retrying the same tap (double-tap, client timeout-and-retry)
  // must not mint a second call id or re-run admission twice. Keyed on the
  // CALLER only — attempt ids are client-generated per tap, not shared across
  // users, so no cross-user key collision is possible.
  const attemptId = validAttemptId(body.attempt_id) ? body.attempt_id : null;
  const attemptKey = attemptId ? `stream-place:attempt:${callerUid}:${attemptId}` : null;
  const activeKey = attemptId ? `stream-place:active:${callerUid}:${attemptId}` : null;
  const cancelKey = attemptId ? `stream-place:cancel:${callerUid}:${attemptId}` : null;
  const cancelled = async (): Promise<boolean> => cancelKey
    ? (await env.TOKENS.get(cancelKey).catch(() => null)) === "1"
    : false;
  if (attemptKey) {
    const cached = await env.TOKENS.get(attemptKey, "json").catch(() => null) as
      { status: number; payload: Record<string, unknown> } | null;
    if (cached) {
      track(env, callerUid, "stream_call_dedup_hit", "avatok", {
        call_id: (cached.payload as { call_id?: unknown }).call_id ?? null,
        attempt_id: attemptId, trace_id: traceId || null, lane: "streamlane",
        app_name: "avatok", service_name: "avatok-api", worker: true,
      }, traceId || undefined);
      return json({ ...cached.payload, idempotent_replay: true }, cached.status);
    }
  }

  /** Single exit point: writes the attempt-id replay cache (if any), then responds. */
  const finish = async (status: number, payload: Record<string, unknown>): Promise<Response> => {
    if (attemptKey) {
      await env.TOKENS.put(attemptKey, JSON.stringify({ status, payload }), {
        expirationTtl: PLACE_ATTEMPT_TTL_SECONDS,
      }).catch(() => undefined);
    }
    return json(payload, status);
  };

  /** One refusal shape, one telemetry event, tagged to BOTH parties. */
  const refuse = async (
    code: StreamPlaceRefusalCode,
    message: string,
    status: number,
    extra: Record<string, unknown> = {},
    internalReason?: string,
  ): Promise<Response> => {
    try {
      const [callerEmail, calleeEmail] = await Promise.all([
        emailFor(env, callerUid).catch(() => null),
        calleeUid ? emailFor(env, calleeUid).catch(() => null) : Promise.resolve(null),
      ]);
      const props = {
        call_id: callId,
        code,
        // NEVER serialised to the caller — server-side abuse investigation only.
        internal_reason: internalReason ?? null,
        from_uid: callerUid, to_uid: calleeUid || null,
        from_email: callerEmail, to_email: calleeEmail,
        media_mode: video ? "video" : "audio",
        trace_id: traceId || null,
        lane: "streamlane",
        app_name: "avatok", service_name: "avatok-api", worker: true,
        ...extra,
      };
      // Both emails, so either party's telemetry retrieves the interaction
      // (CLAUDE.md: a call is a conversation between two people).
      await trackUser(env, callerUid, callerEmail, "stream_call_refused", "avatok", props, traceId || undefined);
      if (calleeUid) {
        await trackUser(env, calleeUid, calleeEmail, "stream_call_refused", "avatok", props, traceId || undefined);
      }
    } catch { /* telemetry must never change a refusal */ }
    return await finish(status, { approved: false, code, message, ...extra });
  };

  if (!calleeUid) return await refuse("invalid_request", "Missing or invalid callee.", 400);
  if (calleeUid === callerUid) return await refuse("self_call", "You can't call yourself.", 400);

  // A read failure is "unknown", not "off": failing closed on a KV hiccup would
  // turn a transient blip into a total call outage, which is exactly the
  // fail-open reasoning lib/call_admission.ts documents for the blocklist.
  const config = await readConfig(env).catch(() => null);
  if (config && config.streamCallsEnabled !== true) {
    return await refuse("stream_calls_disabled", "Calling is temporarily unavailable. Please try again later.", 503);
  }

  // ── BUILD FLOOR (plan §2.1 option C; closes blocker §8.6 on this lane) ──────
  // Same flag, same header, same arithmetic as the legacy dial — shared in
  // lib/call_build_gate.ts. One deliberate difference: the legacy gate exempts
  // `stream_capable` clients so it cannot lock out the very lane it exists to
  // migrate people ONTO. Here there is no such exemption, because every request
  // to this endpoint is by construction a Stream client — exempting them would
  // make the gate permanently unreachable and therefore meaningless.
  const callMinBuild = callMinBuildFrom(config as { callMinBuild?: number } | null);
  if (callMinBuild > 0) {
    const clientBuild = clientBuildFrom(req.headers.get(APP_BUILD_HEADER), body.app_build);
    if (clientBuild < callMinBuild) {
      return await refuse("update_required", UPDATE_REQUIRED_MESSAGE, 426, {
        min_build: callMinBuild,
        client_build: clientBuild,
        // 0 means the request carried no build at all — the population to watch
        // fall as the fleet updates.
        build_reported: clientBuild > 0,
      });
    }
  }

  // ── PRE-RING ADMISSION GATE ────────────────────────────────────────────────
  // The identical call the legacy dial makes (routes/api.ts `call()`), at the
  // identical position: before ANY side effect and before Stream is told
  // anything. A suppressed call costs the callee nothing.
  const admission = await admitCall(env, callerUid, calleeUid);
  if (admission.degraded === true) {
    // The authoritative blocklist could not be read and this verdict came from
    // cache or the documented fail-open. Alerting on it (tagged to the CALLEE,
    // whose policy degraded) is what stops blocking silently ceasing to work.
    try {
      await trackUser(env, calleeUid, await emailFor(env, calleeUid).catch(() => null),
        "call_admission_degraded", "avatok", {
          call_id: callId, from_uid: callerUid, to_uid: calleeUid,
          policy: admission.policy ?? "unknown", admitted: admission.admit,
          internal_reason: admission.admit ? null : admission.internal_reason,
          lane: "streamlane",
          app_name: "avatok", service_name: "avatok-api", worker: true,
        });
    } catch { /* alerting must never change an admission decision */ }
  }
  if (!admission.admit) {
    return await refuse(
      "recipient_unavailable",
      CALLER_VISIBLE_COPY,
      200,
      { outcome_code: CALLER_VISIBLE_OUTCOME, ...unavailableBody() },
      admission.internal_reason,
    );
  }
  const admissionCompletedAt = Date.now();

  // ── UNKNOWN-CALLER CONTACT POLICY ──────────────────────────────────────────
  // The legacy dial diverts an unsaved caller to the callee's AI receptionist
  // when `unknownAvatokCallerReceptionistEnabled` is on. That policy is OFF in
  // production and has never been enabled, so this branch is dark today.
  //
  // TODO(STREAM-RECEPTIONIST-1): there is no Stream receptionist. Ava is a
  // Cloudflare ReceptionRoom DO fed by the CallRoom, and the Stream lane never
  // creates a CallRoom. Until a Stream→Ava bridge exists, the honest thing is to
  // REFUSE with a named code rather than ring a person the policy says must not
  // be rung, or silently drop the policy. The same gap applies to the
  // no-answer/offline receptionist handoffs — see the report.
  const unknownPolicyOn = config?.unknownAvatokCallerReceptionistEnabled === true;
  if (unknownPolicyOn) {
    const contactPolicy = await callerContactPolicy(env, calleeUid, callerUid).catch(() => null);
    if (contactPolicy && shouldRouteUnknownAvatokCaller(contactPolicy, true)) {
      return await refuse(
        "receptionist",
        "This person screens calls from people who aren't in their contacts. Send them a message instead.",
        200,
        { routing_reason: "unknown_caller" },
      );
    }
  }

  const [callerEmail, calleeEmail] = await Promise.all([
    emailFor(env, callerUid).catch(() => null),
    emailFor(env, calleeUid).catch(() => null),
  ]);

  // ── GLARE CHECK (job 3) ────────────────────────────────────────────────
  // Alice→Bob is already approved-and-live; Bob→Alice arrives before either
  // side has hung up or answered. Ringing a second Stream call would give
  // both phones two ringing screens for the same conversation, and the
  // client contract (STREAM-CALLFLOW-1) expects at most one `call_id` per
  // pair at a time. Join Alice's existing call instead of minting Bob's own.
  const counterCall = await readLiveCounterCall(env, callerUid, calleeUid);
  if (counterCall) {
    const glareProps = {
      call_id: counterCall.call_id,
      from_uid: callerUid, to_uid: calleeUid,
      from_email: callerEmail, to_email: calleeEmail,
      media_mode: video ? "video" : "audio",
      trace_id: traceId || null,
      lane: "streamlane",
      original_caller_uid: counterCall.caller_uid,
      original_chosen_at: counterCall.chosen_at,
      app_name: "avatok", service_name: "avatok-api", worker: true,
    };
    const glareTelemetry = (async () => {
      try {
        await trackUser(env, callerUid, callerEmail, "stream_call_glare_hit", "avatok", glareProps, traceId || undefined);
        await trackUser(env, calleeUid, calleeEmail, "stream_call_glare_hit", "avatok", glareProps, traceId || undefined);
      } catch { /* telemetry must never change an approval */ }
    })();
    if (ctx) ctx.waitUntil(glareTelemetry); else await glareTelemetry;
    return await finish(200, {
      approved: true,
      provider: PROVIDER,
      call_type: CALL_TYPE,
      call_id: counterCall.call_id,
      callee_uid: calleeUid,
      video,
      trace_id: traceId || counterCall.call_id,
      code: "glare_join_existing",
      // [REVIEW FIX 2026-08-21] Was `created: false` — but the client's
      // documented fallback for created:false is `getOrCreate(ringing:true)`,
      // which the comment above this contract explicitly forbids on an
      // existing call (re-ring / 409). The client cannot branch on `code`
      // (its approved-decision type does not carry one), so `created` is the
      // only signal it acts on. Semantically the glare call IS created — it
      // exists server-side and the client's only job is to join — so
      // created:true is both truthful and produces exactly the join-only
      // behaviour this path needs.
      created: true,
    });
  }

  // ── AUTHORITATIVE RECORD ───────────────────────────────────────────────────
  // The server-side row that says THIS call id belongs to THIS pair on Stream.
  // `INSERT OR IGNORE` + read-back is the same concurrency gate `prepareStreamCall`
  // uses, so a replay can never re-point a call id at a different pair.
  //
  // [STREAM-ENFORCE-2 2026-08-21] FAILS CLOSED. `stream_video_provider_decisions`
  // is confirmed to EXIST in prod D1 (verified 2026-08-21 via a read-only remote
  // query — see the task brief this change was made under). The prior best-effort
  // posture existed only because the table's existence in prod was unconfirmed at
  // the time; now that it's confirmed, a write failure is a real D1 problem, not
  // an unapplied migration, and ringing a phone with no authoritative record of
  // who approved the call is exactly the gap this endpoint exists to close.
  const recorded = await persistStickyProvider(env, callId, {
    provider: PROVIDER,
    caller_uid: callerUid,
    callee_uid: calleeUid,
    scope: "one_to_one",
    chosen_at: Date.now(),
    bucket: 0,
    percent: 100,
  });
  if (!recorded) {
    try {
      await trackUser(env, callerUid, callerEmail, "stream_call_authority_write_failed", "avatok", {
        call_id: callId, from_uid: callerUid, to_uid: calleeUid,
        trace_id: traceId || null, lane: "streamlane",
        app_name: "avatok", service_name: "avatok-api", worker: true,
      }, traceId || undefined);
    } catch { /* alerting must never mask the underlying failure */ }
    return await refuse(
      "authority_unavailable",
      "Calling is temporarily unavailable. Please try again in a moment.",
      503,
      {},
      "authority_write_failed",
    );
  }

  // Publish the server-minted id before contacting Stream. A concurrent
  // /cancel request can now end this exact call even though /place has not yet
  // returned the id to the phone. The tombstone check closes the inverse race
  // where cancellation arrived just before this mapping was visible.
  if (activeKey) {
    await env.TOKENS.put(activeKey, JSON.stringify({ call_id: callId, callee_uid: calleeUid }), {
      expirationTtl: PLACE_ATTEMPT_TTL_SECONDS,
    }).catch(() => undefined);
  }
  if (await cancelled()) {
    await markProviderDecisionEnded(env, callId);
    return await refuse("call_cancelled", "Call cancelled.", 409, { stage: "before_stream" }, "caller_cancelled");
  }

  // ── SERVER-SIDE CALL CREATION (job 1a) ──────────────────────────────────
  // This is the fix for plan §8 blocker #1: the Worker — not the phone — is
  // now the thing that calls Stream's `getOrCreate(ring:true)`. A modified
  // client holding a valid Stream user token can still call Stream directly,
  // but it can no longer get server APPROVAL plus a Stream ring from a single
  // trusted path merely by skipping this endpoint — see the token-capability
  // findings in the report for the client-token half of this defense.
  const created = await createRingingStreamCall(env, {
    callerUid, calleeUid, callId, video, traceId: traceId || callId,
    // The phone stops waiting after 8 seconds. Anchor this deadline to the
    // beginning of the whole request—not to the later Stream step—so auth and
    // admission can never consume time and leave a provider request running
    // after the caller has already seen a terminal timeout.
    deadlineAt: requestStartedAt + STREAM_PLACE_TOTAL_DEADLINE_MS,
    cancelled,
  });
  if (!created.ok) {
    // The authority row is written before Stream creation so an unrecorded
    // call can never ring. If Stream then refuses creation, close that row
    // immediately: otherwise the reverse-direction glare lookup can return a
    // call id that never existed and strand both callers for 45 seconds.
    await markProviderDecisionEnded(env, callId);
    // An aborted create can race with Stream accepting the request. Ending the
    // deterministic call id is the compensating action that prevents a phone
    // ringing after AvaTOK has already returned a terminal failure.
    if (created.stage === "provider_timeout" || created.stage === "cancelled") {
      await endStreamCall(env, callId);
    }
    try {
      await trackUser(env, callerUid, callerEmail, "stream_call_create_failed", "avatok", {
        call_id: callId, from_uid: callerUid, to_uid: calleeUid,
        stage: created.stage, provider_status: created.status,
        provider_elapsed_ms: created.elapsedMs,
        admission_ms: admissionCompletedAt - requestStartedAt,
        trace_id: traceId || null, lane: "streamlane",
        app_name: "avatok", service_name: "avatok-api", worker: true,
      }, traceId || undefined);
    } catch { /* alerting must never mask the underlying failure */ }
    emitCallEvent(env, CallEvent.call_ended, {
      call_trace_id: traceId || callId, call_id: callId, account_id: callerUid,
      rtc_provider: PROVIDER, ended_reason: "provider_failure",
      extra: { stage: created.stage, lane: "streamlane", provider_elapsed_ms: created.elapsedMs },
    }, ctx);
    return await refuse(
      created.stage === "cancelled" ? "call_cancelled" : "stream_create_failed",
      created.stage === "cancelled" ? "Call cancelled." : "Couldn't start the call. Please try again.",
      created.status,
      { stage: created.stage },
      created.stage === "cancelled" ? "caller_cancelled" : `stream_create_failed:${created.stage}`,
    );
  }

  // Cancellation may land while Stream is processing the create request.
  // Never acknowledge ringing in that case: end it first, close authority,
  // and return one terminal cancelled result.
  if (await cancelled()) {
    await endStreamCall(env, callId);
    await markProviderDecisionEnded(env, callId);
    return await refuse("call_cancelled", "Call cancelled.", 409, {
      stage: "after_stream_create",
      provider_total_ms: created.totalMs,
    }, "caller_cancelled");
  }

  const approvalProps = {
    call_id: callId,
    from_uid: callerUid, to_uid: calleeUid,
    from_email: callerEmail, to_email: calleeEmail,
    media_mode: video ? "video" : "audio",
    trace_id: traceId || null,
    lane: "streamlane",
    authority_recorded: true,
    created_server_side: true,
    admission_policy: admission.policy ?? "unknown",
    auth_and_admission_ms: admissionCompletedAt - requestStartedAt,
    stream_users_ms: created.usersMs,
    stream_create_ms: created.createMs,
    stream_provider_total_ms: created.totalMs,
    place_total_ms: Date.now() - requestStartedAt,
    app_name: "avatok", service_name: "avatok-api", worker: true,
  };
  const approvalTelemetry = (async () => {
    try {
      await trackUser(env, callerUid, callerEmail, "stream_call_authorized", "avatok", approvalProps, traceId || undefined);
      await trackUser(env, calleeUid, calleeEmail, "stream_call_authorized", "avatok", approvalProps, traceId || undefined);
    } catch { /* telemetry must never change an approval */ }
    emitCallEvent(env, CallEvent.call_dial_started, {
      call_trace_id: traceId || callId,
      call_id: callId,
      account_id: callerUid,
      rtc_provider: PROVIDER,
      media_mode: video ? "video" : "audio",
      role: "caller",
      extra: {
        scope: "one_to_one", lane: "streamlane", authority_recorded: true, created_server_side: true,
        auth_and_admission_ms: admissionCompletedAt - requestStartedAt,
        stream_users_ms: created.usersMs,
        stream_create_ms: created.createMs,
        stream_provider_total_ms: created.totalMs,
        place_total_ms: Date.now() - requestStartedAt,
      },
    }, ctx);
  })();
  if (ctx) ctx.waitUntil(approvalTelemetry); else await approvalTelemetry;

  return await finish(200, {
    approved: true,
    provider: PROVIDER,
    call_type: CALL_TYPE,
    call_id: callId,
    callee_uid: calleeUid,
    video,
    trace_id: traceId || callId,
    created: true,
  });
}

/**
 * POST /api/stream-calls/cancel
 * Body { attempt_id: string, call_id?: string }
 *
 * Safe before /place completes: the attempt tombstone is written first, then
 * any already-published server call id is ended. A caller may only cancel its
 * own attempt mapping; an optional call_id must match that mapping.
 */
export async function streamCallCancel(req: Request, env: Env): Promise<Response> {
  const auth = await requireUser(req, env);
  if (isFail(auth)) return json({ error: auth.error }, auth.status);
  let body: { attempt_id?: unknown; call_id?: unknown };
  try { body = await req.json() as typeof body; } catch { return json({ error: "bad json" }, 400); }
  if (!validAttemptId(body.attempt_id)) return json({ error: "invalid attempt_id" }, 400);
  if (body.call_id !== undefined && !validCallId(body.call_id)) return json({ error: "invalid call_id" }, 400);

  const activeKey = `stream-place:active:${auth.uid}:${body.attempt_id}`;
  const cancelKey = `stream-place:cancel:${auth.uid}:${body.attempt_id}`;
  await env.TOKENS.put(cancelKey, "1", { expirationTtl: PLACE_ATTEMPT_TTL_SECONDS });
  const active = await env.TOKENS.get(activeKey, "json").catch(() => null) as
    { call_id?: unknown; callee_uid?: unknown } | null;
  const callId = active && validCallId(active.call_id) ? active.call_id : null;
  if (body.call_id !== undefined && callId !== body.call_id) {
    return json({ error: "call_id does not belong to this attempt" }, 409);
  }
  if (callId) {
    const cancelStartedAt = Date.now();
    const [providerEnded] = await Promise.all([endStreamCall(env, callId), markProviderDecisionEnded(env, callId)]);
    track(env, auth.uid, "stream_call_cancel_requested", "avatok", {
      call_id: callId,
      attempt_id: body.attempt_id,
      provider_ended: providerEnded,
      cancel_total_ms: Date.now() - cancelStartedAt,
      lane: "streamlane",
      app_name: "avatok", service_name: "avatok-api", worker: true,
    });
  }
  return json({ cancelled: true, call_id: callId });
}

async function unzipIfNeeded(raw: ArrayBuffer): Promise<ArrayBuffer> {
  const bytes = new Uint8Array(raw);
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return raw;
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).arrayBuffer();
}

async function verifyWebhook(raw: ArrayBuffer, signature: string, secret: string): Promise<{ body: ArrayBuffer; ok: boolean }> {
  try {
    const body = await unzipIfNeeded(raw);
    if (body.byteLength > 2_000_000) return { body, ok: false };
    const expected = [...await hmac(secret, body)].map((v) => v.toString(16).padStart(2, "0")).join("");
    return { body, ok: fixedTimeEqual(expected, signature.trim().toLowerCase()) };
  } catch {
    return { body: raw, ok: false };
  }
}

function eventCallId(event: StreamCallEvent): string {
  const custom = event.call?.custom ?? event.data?.call?.custom;
  return String(custom?.avatok_call_id ?? event.call_cid ?? event.data?.call_cid ?? event.call?.cid ?? event.data?.call?.cid ?? event.call?.id ?? event.data?.call?.id ?? "").slice(0, 256);
}

function eventTraceId(event: StreamCallEvent, fallback: string): string {
  const custom = event.call?.custom ?? event.data?.call?.custom;
  return String(custom?.avatok_trace_id ?? fallback).slice(0, 256);
}

function eventActor(event: StreamCallEvent): string | undefined {
  return validUid(event.user?.id) ? event.user?.id : undefined;
}

function telemetryForEvent(type: string): { event: typeof CallEvent[keyof typeof CallEvent]; endedReason?: string } | null {
  switch (type) {
    case "call.ring": return { event: CallEvent.call_ring_started };
    case "call.accepted": return { event: CallEvent.call_answered };
    case "call.rejected": return { event: CallEvent.call_declined };
    case "call.missed": return { event: CallEvent.call_ended, endedReason: "missed" };
    // A Stream session existing is not proof that either user can hear audio.
    // Device-side first-playout telemetry owns `call_connected` success.
    case "call.session_started": return { event: CallEvent.call_connect_started };
    case "call.session_ended": return { event: CallEvent.call_ended, endedReason: "completed" };
    case "call.ended": return { event: CallEvent.call_ended, endedReason: "completed" };
    default: return null;
  }
}

/**
 * [STREAM-ENFORCE-2 2026-08-21] Webhook idempotency (job 4), with a fallback.
 *
 * `stream_video_webhooks` ships in
 * worker/migrations/2026-08-19-stream-video-webhooks.sql. Whether that
 * migration has landed in prod D1 is UNCONFIRMED — the fact this change was
 * scoped under confirmed only `stream_video_provider_decisions` exists;
 * a distinctly-named `stream_video_webhook_events` table does not, and this
 * code has never referenced that name (it always used
 * `stream_video_webhooks`, so the two checks are not the same table — see
 * the report). Rather than assume either way, this degrades: D1 first, KV
 * second, "cannot dedup" third — but it never 500s and never drops the event
 * just because a table might be missing.
 */
async function recordWebhookIdempotency(
  env: Env,
  webhookId: string,
  eventType: string,
): Promise<{ duplicate: boolean; via: "d1" | "kv" | "none" }> {
  try {
    // Stream guarantees X-Webhook-Id is stable across retries. D1's primary
    // key makes concurrent retries a no-op instead of double-emitting
    // outcomes.
    const inserted = await env.DB_META.prepare(
      "INSERT OR IGNORE INTO stream_video_webhooks (webhook_id, event_type, received_at) VALUES (?1, ?2, ?3)",
    ).bind(webhookId, eventType.slice(0, 128), Date.now()).run();
    return { duplicate: (inserted.meta?.changes ?? 0) === 0, via: "d1" };
  } catch {
    // Table missing/unavailable. KV get-then-put is not atomic (two concurrent
    // retries could both "win"), but Stream retries are not concurrent by
    // design and a rare double-emit of best-effort telemetry is a far smaller
    // problem than every webhook 500ing and Stream exhausting its retries.
    try {
      const key = `stream-webhook:seen:${webhookId}`;
      const seen = await env.TOKENS.get(key);
      if (seen) return { duplicate: true, via: "kv" };
      await env.TOKENS.put(key, "1", { expirationTtl: 24 * 60 * 60 });
      return { duplicate: false, via: "kv" };
    } catch {
      return { duplicate: false, via: "none" };
    }
  }
}

/** POST /webhooks/stream-video — signed, retry-safe Stream Video events. */
export async function streamVideoWebhook(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  if (env.ENVIRONMENT_NAME !== "staging" && env.ENVIRONMENT_NAME !== "prod") {
    return json({ error: "stream webhook unavailable" }, 404);
  }
  if (!env.STREAM_VIDEO_API_KEY || !env.STREAM_VIDEO_API_SECRET) return json({ error: "stream webhook unavailable" }, 503);
  const apiKey = req.headers.get("x-api-key") ?? "";
  if (!fixedTimeEqual(apiKey, env.STREAM_VIDEO_API_KEY)) {
    track(env, "stream", "stream_webhook_rejected", "avatok", {
      reason: "bad_api_key", app_name: "avatok", service_name: "avatok-api", worker: true,
    });
    return json({ error: "unauthorized" }, 401);
  }
  const webhookId = (req.headers.get("x-webhook-id") ?? "").trim();
  if (!webhookId || webhookId.length > WEBHOOK_ID_MAX) {
    track(env, "stream", "stream_webhook_rejected", "avatok", {
      reason: "missing_webhook_id", app_name: "avatok", service_name: "avatok-api", worker: true,
    });
    return json({ error: "missing webhook id" }, 400);
  }

  const raw = await req.arrayBuffer();
  if (raw.byteLength > 2_000_000) {
    track(env, "stream", "stream_webhook_rejected", "avatok", {
      reason: "payload_too_large", webhook_id: webhookId, app_name: "avatok", service_name: "avatok-api", worker: true,
    });
    return json({ error: "webhook payload too large" }, 413);
  }
  const verified = await verifyWebhook(raw, req.headers.get("x-signature") ?? "", env.STREAM_VIDEO_API_SECRET);
  if (!verified.ok) {
    // Signature verification already existed here (`verifyWebhook` /
    // `fixedTimeEqual` HMAC-SHA256 over the raw, gzip-decompressed body) —
    // job 4 only added the telemetry around the existing check.
    track(env, "stream", "stream_webhook_rejected", "avatok", {
      reason: "bad_signature", webhook_id: webhookId, app_name: "avatok", service_name: "avatok-api", worker: true,
    });
    return json({ error: "bad signature" }, 401);
  }
  let event: StreamCallEvent;
  try { event = JSON.parse(new TextDecoder().decode(verified.body)) as StreamCallEvent; } catch {
    track(env, "stream", "stream_webhook_rejected", "avatok", {
      reason: "bad_json", webhook_id: webhookId, app_name: "avatok", service_name: "avatok-api", worker: true,
    });
    return json({ error: "bad json" }, 400);
  }

  const eventType = String(event.type ?? "unknown");
  const dedup = await recordWebhookIdempotency(env, webhookId, eventType);
  if (dedup.duplicate) {
    track(env, "stream", "stream_webhook_duplicate", "avatok", {
      webhook_id: webhookId, event_type: eventType, dedup_via: dedup.via,
      app_name: "avatok", service_name: "avatok-api", worker: true,
    });
    return json({ ok: true, duplicate: true });
  }
  track(env, "stream", "stream_webhook_received", "avatok", {
    webhook_id: webhookId, event_type: eventType, dedup_via: dedup.via,
    app_name: "avatok", service_name: "avatok-api", worker: true,
  });

  const mapped = telemetryForEvent(eventType);
  if (mapped) {
    const callId = eventCallId(event) || webhookId;
    const traceId = eventTraceId(event, callId);
    emitCallEvent(env, mapped.event, {
      call_trace_id: traceId, call_id: callId, account_id: eventActor(event) ?? "stream",
      rtc_provider: PROVIDER, authority_phase: mapped.endedReason ? "releasing" : undefined,
      ended_reason: mapped.endedReason,
      extra: { stream_event: eventType, webhook_attempt: req.headers.get("x-webhook-attempt") ?? "1" },
    }, ctx);
    // [STREAM-ENFORCE-2 2026-08-21] Feeds the glare check (job 3): once a call
    // is known ended, it stops matching `readLiveCounterCall`. Best-effort —
    // see `markProviderDecisionEnded`; requires the `ended_at` column from
    // worker/migrations/2026-08-21-stream-call-place-hardening.sql.
    if (mapped.endedReason) {
      const endedPromise = markProviderDecisionEnded(env, callId);
      if (ctx) ctx.waitUntil(endedPromise); else await endedPromise;
    }
  }
  return json({ ok: true, event_type: eventType });
}
