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
import { admitCall, unavailableBody } from "../lib/call_admission";
import { nameFor } from "../lib/identity";
import { readConfig } from "./config";
import { emitCallEvent, CallEvent } from "../lib/call_telemetry_events";

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

function streamConfigured(env: Env): boolean {
  return Boolean(env.STREAM_VIDEO_API_KEY && env.STREAM_VIDEO_API_SECRET);
}

function streamCallUrl(env: Env, callId: string): string {
  return `https://video.stream-io-api.com/api/v2/video/call/${CALL_TYPE}/${encodeURIComponent(callId)}?api_key=${encodeURIComponent(env.STREAM_VIDEO_API_KEY as string)}`;
}

function streamUsersUrl(env: Env): string {
  return `https://video.stream-io-api.com/api/v2/users?api_key=${encodeURIComponent(env.STREAM_VIDEO_API_KEY as string)}`;
}

async function ensureStreamUsers(
  env: Env,
  token: string,
  profiles: Array<{ id: string; name?: string }>,
): Promise<boolean> {
  const users = Object.fromEntries(profiles.map((profile) => [profile.id, {
    id: profile.id,
    role: "user",
    ...(profile.name ? { name: profile.name } : {}),
  }]));
  try {
    const response = await fetch(streamUsersUrl(env), {
      method: "POST",
      headers: { Authorization: token, "Content-Type": "application/json", "stream-auth-type": "jwt" },
      body: JSON.stringify({ users }),
    });
    return response.ok;
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
  if (!enabled(config) && !existingStreamCall) return json({ error: "stream video pilot disabled" }, 404);
  if (!existingStreamCall && !rolloutAllowed(env, auth.uid)) return json({ error: "stream audio unavailable" }, 404);
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

/** POST /webhooks/stream-video — signed, retry-safe Stream Video events. */
export async function streamVideoWebhook(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  if (env.ENVIRONMENT_NAME !== "staging" && env.ENVIRONMENT_NAME !== "prod") {
    return json({ error: "stream webhook unavailable" }, 404);
  }
  if (!env.STREAM_VIDEO_API_KEY || !env.STREAM_VIDEO_API_SECRET) return json({ error: "stream webhook unavailable" }, 503);
  const apiKey = req.headers.get("x-api-key") ?? "";
  if (!fixedTimeEqual(apiKey, env.STREAM_VIDEO_API_KEY)) return json({ error: "unauthorized" }, 401);
  const webhookId = (req.headers.get("x-webhook-id") ?? "").trim();
  if (!webhookId || webhookId.length > WEBHOOK_ID_MAX) return json({ error: "missing webhook id" }, 400);

  const raw = await req.arrayBuffer();
  if (raw.byteLength > 2_000_000) return json({ error: "webhook payload too large" }, 413);
  const verified = await verifyWebhook(raw, req.headers.get("x-signature") ?? "", env.STREAM_VIDEO_API_SECRET);
  if (!verified.ok) return json({ error: "bad signature" }, 401);
  let event: StreamCallEvent;
  try { event = JSON.parse(new TextDecoder().decode(verified.body)) as StreamCallEvent; } catch { return json({ error: "bad json" }, 400); }

  // Stream guarantees X-Webhook-Id is stable across retries. D1's primary key
  // makes concurrent retries a no-op instead of double-emitting outcomes.
  const inserted = await env.DB_META.prepare(
    "INSERT OR IGNORE INTO stream_video_webhooks (webhook_id, event_type, received_at) VALUES (?1, ?2, ?3)",
  ).bind(webhookId, String(event.type ?? "unknown").slice(0, 128), Date.now()).run();
  if ((inserted.meta?.changes ?? 0) === 0) return json({ ok: true, duplicate: true });

  const mapped = telemetryForEvent(String(event.type ?? ""));
  if (mapped) {
    const callId = eventCallId(event) || webhookId;
    const traceId = eventTraceId(event, callId);
    emitCallEvent(env, mapped.event, {
      call_trace_id: traceId, call_id: callId, account_id: eventActor(event) ?? "stream",
      rtc_provider: PROVIDER, authority_phase: mapped.endedReason ? "releasing" : undefined,
      ended_reason: mapped.endedReason,
      extra: { stream_event: String(event.type ?? "unknown"), webhook_attempt: req.headers.get("x-webhook-attempt") ?? "1" },
    }, ctx);
  }
  return json({ ok: true, event_type: event.type ?? "unknown" });
}
