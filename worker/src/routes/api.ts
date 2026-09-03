// Hardened API contract (Cloudflare-native; Nostr deprecated). Identity is the
// Clerk user id (uid), verified from the Clerk JWT at the edge via requireUser —
// the caller can only act as themselves. The directory lives in the `users`
// table (uid PK). Public reads (resolve / search / handle/check / communities)
// are unauthenticated and cached upstream.
//
// D1 reads use the Sessions API (one session per DB per request) → nearest
// replica with read-after-write consistency within the request.
import type { Env } from "../types";
import { json, sha256Hex, normalizePhone } from "../util";
import { metaSession } from "../db/shard";
import { requireUser, isFail } from "../authz";
import { verifyClerk, resolveCanonicalUid, linkClerkAlias } from "../auth";
import { emailFor, phoneFor, nameFor, primaryVerifiedEmailFor, publicIdentityFor } from "../lib/identity";
import { admitCall, unavailableBody, CALLER_VISIBLE_OUTCOME } from "../lib/call_admission";
// [STREAM-AUTH-1] Shared with routes/stream_video_calls.ts `streamCallPlace`.
import { APP_BUILD_HEADER, UPDATE_REQUIRED_MESSAGE, callMinBuildFrom, clientBuildFrom } from "../lib/call_build_gate";
import { track, trackUser, trackUserContact, trackException } from "../hooks";
// [CALL-PRESENCE-1] The real device heartbeat (Upstash-backed, no DO wake).
import { readPresenceRead, type PresenceReadResult, type PresenceState } from "../lib/presence";
import { brainIngest } from "../lib/brain_ingest";
import { avaReason } from "../lib/ava_reason"; // One Brain B1: unified reasoning gateway
import { generateContentVia } from "../lib/vertex"; // [VERTEX-1]
import { guardWrite } from "./moderate"; // save-time content validation (Nemotron)
import { moderate, namePlausible } from "../lib/moderation";
import { readConfig } from "./config"; // P11: profileCompletionGate
import { prepareStreamCall } from "./stream_video_calls";
import { CALL_RING_LIFETIME_MS, ringLifetimeMs } from "../lib/call_delivery_contract";
import { CALL_ROOM_TOKEN_LIFETIME_MS } from "../lib/call_room_auth";
import { receptionistNoAnswerEligibility } from "./receptionist";
import { callerContactPolicy, shouldRouteUnknownAvatokCaller, type ContactPolicy } from "../lib/call_contact_directory";
// [WP1] Event-sourced call stream (Specs/PLAN-2026-07-11-dialpad-business-calls-ava-voice-agent.md §13/§14)
import { emitCallEvent, emitRoutingDecision, newTraceId, EVENT_SCHEMA_VERSION } from "../lib/call_events";
import { buildCallSnapshot } from "../lib/call_snapshot";
// [WP3] Routing engine — decides where a DIALPAD (business-channel) call goes
// (blocked/offline/busy/business-hours/agent/voicemail/ring). Only invoked
// when the client marks the call `via:'dialpad'`; friend-channel calls never
// reach this engine.
import { decideRouting, decideNoAnswerRouting, type NoAnswerOutcome } from "../lib/call_routing";
import { authorityNotifyRegister } from "../lib/call_authority"; // [BUSY-CARD-1] "Notify me" waiter register
import { rateLimit } from "../money"; // abuse limits (Phase 3 hardening)
// R2-F2: avatar nudity moderation (AWS Rekognition DetectModerationLabels; SigV4
// signing reused from ../aws/sigv4 via ../aws/rekognition).
import { rekognitionConfigured, detectModerationLabels, avatarModerationRejected } from "../aws/rekognition";
// [WELCOME-100-1] 100-token welcome bonus on first account materialization.
import { grantWelcomeBonus } from "./welcome_bonus";
import { loadMessengerCallAuthorization } from "./messenger_call_billing";
import { initializeMessengerCallBilling, type MessengerCallBillingAuthorizationSnapshot } from "../do/messenger_call_billing";
import {
  deriveCallRecipient,
  deriveQuickReplyRecipient,
  QUICK_REPLY_CATALOG_V1,
  type PersistedCallParticipants,
} from "../lib/call_route_authority";

type CallParticipants = PersistedCallParticipants;

/** Persisted CallRoom participants are the only source of call recipients. */
async function readCallParticipants(env: Env, callId: string): Promise<CallParticipants | null> {
  if (!callId) return null;
  const stub = env.CALL_ROOMS.get(env.CALL_ROOMS.idFromName(callId));
  const response = await stub.fetch(`https://call-room/participants?callId=${encodeURIComponent(callId)}`);
  if (!response.ok) return null;
  const body = await response.json().catch(() => null) as { ok?: boolean; callerUid?: string; calleeUid?: string } | null;
  return body?.ok && body.callerUid && body.calleeUid
    ? { callerUid: body.callerUid, calleeUid: body.calleeUid }
    : null;
}

function otherCallParticipant(p: CallParticipants, uid: string): string | null {
  return deriveCallRecipient(p, uid);
}

// ---- push: /api/register /api/call /api/notify /api/call-status ----
export async function register(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as { token?: string; platform?: string; device_id?: string };
  if (!b.token) return json({ error: "token required" }, 400);
  const platform = b.platform === "apns" ? "apns" : "fcm";
  const now = Date.now();
  const db = metaSession(env);
  // Back-compat write (KEPT during rollout so nothing depending on push_tokens_v2
  // breaks). Resolution now PREFERS the device-mapped tokens below.
  await db.prepare(
    "INSERT OR REPLACE INTO push_tokens_v2 (uid, platform, token, updated_at) VALUES (?1,?2,?3,?4)",
  ).bind(ctx.uid, platform, b.token, now).run();
  // [MULTIACCT-2] Device-level token + account-level routing. The FCM token
  // belongs to the DEVICE; each account signed in on that device maps to it. A
  // token refresh UPDATES the single device row (no stale-row accumulation); an
  // account switch just UPSERTs its own (account_id, device_id, active=1) mapping.
  // Guarded so a device that hasn't been migrated yet (no device_id sent) still
  // works via push_tokens_v2. Best-effort: never fail /api/register on the new
  // tables (tables may not exist until the migration is applied).
  const deviceId = String(b.device_id ?? "").trim();
  if (deviceId) {
    try {
      await db.prepare(
        "INSERT OR REPLACE INTO device_tokens (device_id, platform, token, updated_at) VALUES (?1,?2,?3,?4)",
      ).bind(deviceId, platform, b.token, now).run();
      await db.prepare(
        "INSERT INTO account_devices (account_id, device_id, active, last_seen) VALUES (?1,?2,1,?3) " +
        "ON CONFLICT(account_id, device_id) DO UPDATE SET active=1, last_seen=excluded.last_seen",
      ).bind(ctx.uid, deviceId, now).run();
      // If the SAME token was previously bound to a DIFFERENT device_id row (rare —
      // e.g. a client that regenerated its device UUID), drop the orphan so we never
      // fan out to a duplicate. Keyed on token because that's the FCM-unique value.
      await db.prepare("DELETE FROM device_tokens WHERE token=?1 AND device_id<>?2").bind(b.token, deviceId).run();
    } catch { /* migration not applied yet → push_tokens_v2 path still serves */ }
  }
  const c = await tokenCountObj(db, ctx.uid);
  return json({ ok: true, devices: c });
}

// [MULTIACCT-2] Reachable-token count for a uid. Prefers the device-mapped join
// (device_tokens ⨝ account_devices where active=1) so a stale token orphaned by
// an account switch never inflates the count; falls back to the legacy
// push_tokens_v2 count when the new tables aren't populated/migrated yet.
async function tokenCountObj(db: D1Database | D1DatabaseSession, uid: string): Promise<number> {
  try {
    const c = await db.prepare(
      "SELECT count(*) AS n FROM account_devices ad JOIN device_tokens dt ON dt.device_id=ad.device_id " +
      "WHERE ad.account_id=?1 AND ad.active=1",
    ).bind(uid).first<{ n: number }>();
    if ((c?.n ?? 0) > 0) return c!.n;
  } catch { /* tables missing → fall through to legacy */ }
  const c = await db.prepare("SELECT count(*) AS n FROM push_tokens_v2 WHERE uid=?1").bind(uid).first<{ n: number }>();
  return c?.n ?? 0;
}

async function tokenCount(db: D1Database | D1DatabaseSession, uid: string): Promise<number> {
  return tokenCountObj(db, uid);
}

// [CALL-TELEMETRY-1 2026-07-14] Full callee device/token snapshot for the
// call_callee_reachability event. Mirrors the consumer's resolveTokens diagnostics
// (consumers/src/fcm.ts) so the dial-time snapshot and the send-time fan-out
// result use the same vocabulary: device_join_tokens (active mapping ⨝ token),
// legacy_tokens (push_tokens_v2), mapped_inactive (switched-out devices),
// mapped_active_no_token (active device whose FCM token rotated away).
async function calleeReachabilitySnapshot(
  db: D1Database | D1DatabaseSession, uid: string,
): Promise<Record<string, number | string>> {
  let deviceJoin = 0, mappedInactive = 0, mappedActiveNoToken = 0, legacy = 0;
  try {
    const d = await db.prepare(
      "SELECT sum(CASE WHEN ad.active=1 AND dt.token IS NOT NULL THEN 1 ELSE 0 END) AS joined, " +
      "sum(CASE WHEN ad.active=0 THEN 1 ELSE 0 END) AS inactive, " +
      "sum(CASE WHEN ad.active=1 AND dt.token IS NULL THEN 1 ELSE 0 END) AS active_no_token " +
      "FROM account_devices ad LEFT JOIN device_tokens dt ON dt.device_id=ad.device_id " +
      "WHERE ad.account_id=?1",
    ).bind(uid).first<{ joined: number | null; inactive: number | null; active_no_token: number | null }>();
    deviceJoin = d?.joined ?? 0;
    mappedInactive = d?.inactive ?? 0;
    mappedActiveNoToken = d?.active_no_token ?? 0;
  } catch { /* pre-migration */ }
  try {
    const l = await db.prepare("SELECT count(*) AS n FROM push_tokens_v2 WHERE uid=?1").bind(uid).first<{ n: number }>();
    legacy = l?.n ?? 0;
  } catch { /* pre-migration */ }
  return {
    device_join_tokens: deviceJoin,
    legacy_tokens: legacy,
    mapped_inactive: mappedInactive,
    mapped_active_no_token: mappedActiveNoToken,
    token_source: deviceJoin > 0 ? "device_join" : (legacy > 0 ? "legacy" : "none"),
  };
}

// [MULTIACCT-2] POST /api/account/device  { device_id, active?: boolean }
// Flip THIS account's mapping on the given device without touching the shared
// device token. Called by the client's AccountSwitcher: on switch-IN / login the
// target account sets active=1 (via /api/register which already does this, but
// this endpoint lets the client mark it without re-sending the token); on
// logout / switch-OUT the departing account sets active=0. The token row in
// device_tokens is DEVICE-owned and never deleted here — the next account (or a
// re-login of this one) reuses it, so a switch never orphans the token.
export async function accountDevice(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as { device_id?: string; active?: boolean };
  const deviceId = String(b.device_id ?? "").trim();
  if (!deviceId) return json({ error: "device_id required" }, 400);
  const active = b.active === false ? 0 : 1;
  const now = Date.now();
  try {
    await env.DB_META.prepare(
      "INSERT INTO account_devices (account_id, device_id, active, last_seen) VALUES (?1,?2,?3,?4) " +
      "ON CONFLICT(account_id, device_id) DO UPDATE SET active=excluded.active, last_seen=excluded.last_seen",
    ).bind(ctx.uid, deviceId, active, now).run();
  } catch {
    // Migration not applied yet — nothing to flip; the legacy push_tokens_v2 path
    // still governs reachability. Report ok so the client switch never blocks.
    return json({ ok: true, migrated: false });
  }
  return json({ ok: true, active: !!active });
}

// ── [CALL-RING-FASTPATH-1 2026-08-07] CALLER IDENTITY, MEMOISED PER ISOLATE ──
//
// `publicIdentityFor` is a D1 profile read and its answer changes only when the
// caller edits their own profile — yet it was awaited in front of every single
// ring. Same reasoning (and same shape) as the admission verdict cache in
// lib/call_admission.ts: per-isolate, in-memory, bounded, short TTL. A cold
// isolate still pays for it once; the second call from the same caller does not.
//
// ONLY successful lookups are cached. Caching a `null` would pin "we could not
// read your profile" and re-introduce the uid-as-caller-name bug that
// [CALL-IDENTITY-SNAPSHOT-1] fixed.
//
// The TTL is 60 s, not "as long as we can get away with", because
// [CALL-IDENTITY-SNAPSHOT-1] promises that a caller who renames their profile
// mid-ring keeps the old name for THAT call and "the next call picks up the new
// one". A long cache would quietly break that promise. 60 s still removes the
// read from redials and from the retry-after-no-answer pattern, which is where
// it actually costs anything.
type CallerIdentity = Awaited<ReturnType<typeof publicIdentityFor>>;
const identityCache = new Map<string, { v: CallerIdentity; at: number }>();
const IDENTITY_TTL_MS = 60_000;
/**
 * How long the RING will wait for a cold identity lookup before going out with
 * the client-supplied name. Generous on purpose: this is a tail-latency cap, not
 * a budget we expect to spend. If it does fire the WS ring carries the caller's
 * own `fromName` (their local ProfileStore display name — in practice the same
 * string) while the FCM copy still carries the authoritative profile, so the
 * worst case is the pre-existing WS-then-FCM refresh, not a wrong name.
 */
const IDENTITY_RING_BUDGET_MS = 600;

function cachedIdentity(uid: string): CallerIdentity | undefined {
  const e = identityCache.get(uid);
  if (!e) return undefined;
  if (Date.now() - e.at > IDENTITY_TTL_MS) { identityCache.delete(uid); return undefined; }
  return e.v;
}

function rememberIdentity(uid: string, v: CallerIdentity): void {
  if (!v) return;
  identityCache.set(uid, { v, at: Date.now() });
  if (identityCache.size > 512) {
    const cutoff = Date.now() - IDENTITY_TTL_MS;
    for (const [k, e] of identityCache) if (e.at < cutoff) identityCache.delete(k);
    if (identityCache.size > 512) {
      const oldest = identityCache.keys().next().value;
      if (oldest !== undefined) identityCache.delete(oldest);
    }
  }
}

/** Test seam — reset between cases so one test cannot leak into the next. */
export function __resetCallIdentityCache(): void { identityCache.clear(); }

export async function call(req: Request, env: Env, execCtx?: ExecutionContext): Promise<Response> {
  // [CALL-RING-FASTPATH-1] t0 for `call_ring_path_ms`. Started before ANY await
  // so the numbers include auth — the caller's stopwatch starts when they press
  // dial, not when we finish verifying their JWT.
  const ringPathT0 = Date.now();
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  // [STREAM-GATE-1] `app_build` is the body fallback for the header `x-app-build`;
  // both are OPTIONAL and only consulted when `callMinBuild` is armed.
  const b = (await req.json().catch(() => ({}))) as {
    to?: string; callId?: string; kind?: string; fromName?: string; via?: string;
    stream_capable?: unknown; app_build?: unknown; authorization_id?: string;
    attempt_id?: string; price_version?: unknown;
  };
  // [WP3] 'dialpad' = the AvaTOK-number business channel (plan §3). Friend-
  // channel (email/chat) calls never send this and are byte-for-byte unaffected.
  const isDialpad = b.via === "dialpad";
  if (!b.to || !b.callId) return json({ error: "to and callId required" }, 400);
  // [TRACE-ID-1] Correlation id minted client-side at the dial boundary; propagate
  // it into the push payload (→ callee) and PostHog captures on this path so the
  // caller, Worker, and callee all stitch under one trace_id. Additive/optional.
  // [CALL-RING-FASTPATH-1] Hoisted above the admission gate: it is a header read
  // with no await, and the ring-path timing events below want to stitch to it.
  const traceId = req.headers.get("x-trace-id") ?? "";
  // Captured as plain consts: both are validated truthy by the guard directly
  // above and never reassigned, but that narrowing does not survive into an async
  // closure — the same idiom as reachabilityTo / deferredTo further down.
  const callTo = b.to as string;
  const callIdStr = b.callId as string;

  // ── [CALL-RING-FASTPATH-1] RING-PATH STOPWATCH ─────────────────────────────
  //
  // One `call_ring_path_ms` event per RETAINED await, so the improvement is
  // provable in PostHog rather than asserted here. `ms` is cumulative from t0
  // (the caller's own stopwatch), not per-stage, because the number we care
  // about is "how long until their phone could ring".
  const ringPathStages: Array<{ stage: string; ms: number }> = [];
  const markRingStage = (stage: string): void => {
    ringPathStages.push({ stage, ms: Date.now() - ringPathT0 });
  };
  let fastPath = true; // real value lands with the config read below
  const flushRingPath = async (): Promise<void> => {
    const stages = ringPathStages.splice(0, ringPathStages.length);
    if (!stages.length) return;
    try {
      // Identity resolution is a D1 read; it belongs here, in the deferred
      // flush, and never on the ring path this event exists to measure.
      const [callerEmail, callerPhone] = await Promise.all([
        emailFor(env, ctx.uid).catch(() => null),
        phoneFor(env, ctx.uid).catch(() => null),
      ]);
      // Submit stage events concurrently. Sequential PostHog requests could
      // consume the whole waitUntil lifetime and silently lose the tail stages.
      await Promise.allSettled(stages.map((s, index) =>
        trackUserContact(env, ctx.uid, callerEmail, callerPhone, "call_ring_path_ms", "avatok", {
          call_id: b.callId, to: b.to, stage: s.stage, ms: s.ms, fastpath: fastPath,
          delta_ms: s.ms - (index === 0 ? 0 : stages[index - 1].ms),
          stage_index: index,
          trace_id: traceId, via: b.via ?? "chat",
          app_name: "avatok", service_name: "avatok-api", worker: true,
        }, traceId || undefined),
      ));
    } catch { /* timing telemetry must never change a call outcome */ }
  };
  // workerd DROPS unawaited work on an EARLY-RETURN path, so every `return` that
  // can happen after a stage was marked calls this — awaited when there is no
  // ExecutionContext, `waitUntil`-ed when there is. Skipping it is how a timing
  // event silently never arrives.
  const settleRingPath = async (): Promise<void> => {
    const p = flushRingPath();
    if (execCtx) execCtx.waitUntil(p); else await p;
  };

  // ── [CALL-RING-FASTPATH-1] THE CONCURRENT PRE-RING BATCH ───────────────────
  //
  // Every one of these is a PURE READ with no side effect, and none of them
  // depends on another's result. They were five serial awaits (blocklist D1,
  // KV config, caller profile D1, primary-D1 token count) stacked in front of
  // the ring; started together they cost max(), not sum().
  //
  // Starting them BEFORE the admission verdict lands is safe precisely because
  // they are reads: a suppressed call still costs the callee nothing — no push,
  // no device wake, no write. The first WRITE on this path (the stale-device
  // prune) still happens strictly after admission, as it always did.
  const admissionPromise = admitCall(env, ctx.uid, b.to);
  const configPromise = readConfig(env).catch(() => null);
  const identityPromise = (async (): Promise<CallerIdentity> => {
    const hit = cachedIdentity(ctx.uid);
    if (hit !== undefined) return hit;
    const v = await publicIdentityFor(env, ctx.uid).catch(() => null);
    rememberIdentity(ctx.uid, v);
    return v;
  })();
  // Read the callee's device count from the PRIMARY (plain prepare), not an
  // unconstrained replica — avoids a stale 0-token false-404 on a registered device.
  const tokenCountPromise = tokenCount(env.DB_META, b.to).catch(() => 0);
  // [CALL-PRESENCE-1] Fired unconditionally: it is one Upstash GET with no side
  // effect, and gating it behind the config read would put the config KV latency
  // in front of it for no benefit. The RESULT is only acted on when
  // `callPresenceRouting` is true (see the decision block below).
  // [CALL-PRESENCE-2 2026-08-08] The DETAILED read. The old `.catch(() => null)`
  // was the third and outermost layer of error swallowing on this lookup, and the
  // reason a failed Upstash read and a callee who has never beaten produced the
  // identical `presence:'unknown'` with nothing anywhere to tell them apart.
  const presenceReadPromise: Promise<PresenceReadResult> =
    readPresenceRead(env, b.to).catch(() => ({
      record: null, outcome: "error" as const, ms: -1, status: null,
    }));

  // ── PRE-RING ADMISSION GATE ────────────────────────────────────────────────
  // [CALL-ADMISSION-1 2026-08-01] Spec: Specs/CALL-OUTCOMES-FROZEN-2026-08-01.md
  // (owner ruling B, freeze decisions 8 + 9).
  //
  // This is the EARLIEST possible rejection point and that placement is the
  // whole feature: nothing below has run yet — no device/token lookup, no
  // stale-device prune, no telemetry, no CallRoom DO, no Q_PUSH, no InboxDO WS
  // ring. A suppressed call costs the callee nothing: their phone never wakes.
  //
  // Before this, the blocklist was consulted ONLY inside lib/call_routing.ts,
  // only on the dialpad lane, and only when `businessCallUx` was on — so a
  // blocked caller placing an ordinary friend-channel call rang straight
  // through. Blocking someone did not stop them phoning you.
  //
  // Every denial returns the identical uniform body, so "fast rejection" no
  // longer uniquely means "blocked" (see call_admission.ts for the reasoning).
  const admission = await admissionPromise;
  markRingStage("admit");
  // [CALL-ADMISSION-2 2026-08-01] ALERT ON A DEGRADED VERDICT.
  //
  // `degraded` means the authoritative blocklist could NOT be read and this
  // decision came from the 60s cache or from the documented fail-open. Silence
  // here was the reviewer's objection to the original fail-open: blocking could
  // stop working for everyone and nothing would say so.
  //
  // Emitted for ADMITTED calls too — a denial is self-evidently working, an
  // admission during an outage is the dangerous one. `policy` distinguishes
  // "cached, still enforcing" from "no cache, let it through": a rising
  // `unknown_failed_open` count is the alert condition, and any sustained
  // `degraded` volume means D1 is unhealthy on the call path.
  if (admission.degraded === true) {
    try {
      // Tagged to the CALLEE — this is their blocking policy that degraded, and
      // they are the person exposed by it.
      await track(env, b.to, "call_admission_degraded", "avatok", {
        call_id: b.callId,
        from_uid: ctx.uid,
        to_uid: b.to,
        policy: admission.policy ?? "unknown",
        admitted: admission.admit,
        // Present only on a denial; a cached block still enforcing is the good
        // outcome during an outage and should be visibly distinct.
        internal_reason: admission.admit ? null : admission.internal_reason,
        service_name: "avatok-api", worker: true,
      });
    } catch { /* alerting must never change an admission decision */ }
  }
  if (!admission.admit) {
    try {
      // The internal reason lives ONLY here, server-side. It must never reach
      // the caller in any form — body, push, error string or their analytics.
      const [callerEmail, calleeEmail] = await Promise.all([
        emailFor(env, ctx.uid).catch(() => null),
        emailFor(env, b.to).catch(() => null),
      ]);
      await trackUser(env, b.to, calleeEmail, "call_admission_denied", "avatok", {
        call_id: b.callId,
        from_uid: ctx.uid,
        to_uid: b.to,
        from_email: callerEmail,
        to_email: calleeEmail,
        internal_reason: admission.internal_reason,
        caller_visible_outcome: CALLER_VISIBLE_OUTCOME,
        via: b.via ?? "chat",
        app_name: "avatok", service_name: "avatok-api", worker: true,
      });
    } catch { /* telemetry must never change an admission decision */ }
    await settleRingPath();
    return json(unavailableBody());
  }
  // [CALL-UNKNOWN-ROUTE-1/CALL-UNKNOWN-GATE-1] The server, not a warm handset,
  // owns unknown-caller classification. Classification alone never diverts an
  // authenticated AvaTOK call: the separate policy switch must be explicitly
  // enabled. Missing/partial policy and a missing config both fail open to a
  // normal human ring.
  // [CALL-RING-FIRST-2] These two reads are independent (D1 contact lookup vs
  // KV config) and were previously serial awaits for no reason — nothing here
  // depends on the other's result until routeUnknownCaller() below.
  //
  // [CALL-RING-FASTPATH-1 2026-08-07] Both now START in the concurrent batch at
  // the top, and on the fast path the D1 contact lookup is removed from the
  // critical path ENTIRELY unless the policy that consumes it is switched on —
  // which in production it is not (`unknownAvatokCallerReceptionistEnabled`
  // defaults false, and prod KV has never enabled it). A D1 read whose only
  // consumer is a disabled policy is a pure tax on every ring. The
  // classification telemetry still fires; it just stopped being worth waiting
  // for, and carries `deferred:true` so the two populations stay distinguishable.
  const callPolicyConfig = await configPromise;
  markRingStage("config");

  // ── [AVATALK-CHAT-ONLY-2] MESSENGER CALLING KILL SWITCH ────────────────────
  //
  // Messenger is chat-only (PIVOT-2026-08-27). `messengerCallingEnabled`
  // (DEFAULTS false, routes/config.ts) was already enforced inside the Stream
  // prepare gate (stream_video_calls.ts:561), but that gate is only REACHED
  // from this route when the body opts into the Stream pilot explicitly
  // (see the [STREAM-CALL-PILOT-1] branch below). Every other caller — any
  // pre-pivot build, any client that omits the field, any direct HTTP POST —
  // fell straight through to admission, the CallRoom DO, and the push/WS ring.
  // The switch was therefore a client-side courtesy, not an enforcement point:
  // a stale handset could still ring a callee with Messenger calling "off".
  //
  // Placed here deliberately: after the admission gate (a read-only blocklist
  // verdict with no side effect on the callee) but BEFORE the billing
  // authorization block below, before the CallRoom DO, and before Q_PUSH /
  // InboxDO — so a refused call never rings and never bills, which is exactly
  // what the pivot spec requires.
  //
  // Fail-CLOSED on `!== true`, matching that same gate: a config read that
  // fails leaves the flag undefined, and the intended state of this feature is
  // OFF. Refusing during a KV outage costs nothing while calling is disabled;
  // failing open would resurrect the lane precisely when we are blind.
  //
  // This does NOT touch the commercial lanes. Paid live streaming
  // (`avatok_livestream`) and paid 1:1 consultations (`avatok_consult_1to1`)
  // are authorized in routes/commercial_stream_sessions.ts, never reach this
  // route, and read no flag defined here.
  if (callPolicyConfig?.messengerCallingEnabled !== true) {
    try {
      // Two-sided by design: either party's email must retrieve this refusal,
      // because "my calls stopped working" arrives from callers and callees
      // alike and the two timelines only make sense side by side.
      const [callerEmail, calleeEmail] = await Promise.all([
        emailFor(env, ctx.uid).catch(() => null),
        emailFor(env, b.to).catch(() => null),
      ]);
      await trackUser(env, ctx.uid, callerEmail, "messenger_call_refused_feature_off", "avatok", {
        call_id: b.callId,
        from_uid: ctx.uid,
        to_uid: callTo,
        from_email: callerEmail,
        to_email: calleeEmail,
        kind: b.kind ?? "audio",
        via: b.via ?? "chat",
        // Distinguishes "flag explicitly off" from "config unreadable, failed
        // closed" — the second is an infrastructure signal, not a product one.
        config_present: callPolicyConfig != null,
        stream_capable: b.stream_capable === true,
        trace_id: traceId,
        app_name: "avatok", service_name: "avatok-api", worker: true,
      });
    } catch { /* telemetry must never change a refusal */ }
    await settleRingPath();
    return json({
      error: "messenger_calling_disabled",
      code: "messenger_calling_disabled",
      reachable: false,
      sent: 0,
    }, 403);
  }

  // Free Messenger audio is the Cloudflare lane. Once its master gate is
  // armed, a free-audio ring is admitted only from the immutable D1
  // authorization created by /api/messenger-call/authorize. Paid audio starts
  // as a separate Stream authorization/call through stream-calls/place; this
  // route never migrates a Cloudflare room into paid media. Client-supplied
  // provider, payer, rate, day, and call terms are never accepted here.
  let messengerAudioSnapshot: MessengerCallBillingAuthorizationSnapshot | null = null;
  let billingAuthorization: MessengerCallBillingAuthorizationSnapshot | null = null;
  const effectiveCallId = (): string => billingAuthorization?.call_id ?? b.callId as string;
  // For billing-enabled audio the authoritative expression is
  // `callId: billingAuthorization.call_id`; the optional fallback below is
  // reachable only while the Messenger master is dark (legacy behavior).
  // The same server row is `authorization.authorization_id` / `authorization.call_id`;
  // no body provider, payer, rate, or client call id is trusted.
  if (callPolicyConfig?.messengerCallBillingEnabled === true && (b.kind ?? "audio") !== "video") {
    // Any uncertain teardown remains reconciliation_pending with reservation_ref
    // retained; the caller is never released merely because this request ended.
    const authorizationId = typeof b.authorization_id === "string" ? b.authorization_id.trim() : "";
    const attemptId = typeof b.attempt_id === "string" ? b.attempt_id.trim() : "";
    const clientPriceVersion = Number(b.price_version);
    if (!authorizationId || !attemptId || !Number.isInteger(clientPriceVersion) || !b.callId) {
      await settleRingPath();
      return json({ error: "messenger_audio_authorization_required", code: "authorization_required", reachable: false, sent: 0 }, 402);
    }
    const authRow = await loadMessengerCallAuthorization(env, authorizationId, ctx.uid, attemptId).catch(() => null);
    const now = Date.now();
    // caller + callee_uid are both server-checked against the immutable row.
    const callerCalleeMatch = !!authRow && authRow.payer_uid === ctx.uid && authRow.callee_uid === callTo;
    if (!authRow || !callerCalleeMatch || authRow.media !== "audio" || authRow.quality_sku !== "audio" ||
        authRow.provider !== "cloudflare" || authRow.payer_uid !== ctx.uid || authRow.attempt_id !== attemptId ||
        authRow.call_id !== callIdStr || authRow.price_version !== clientPriceVersion || authRow.status !== "authorized" ||
        (authRow.expires_at > 0 && authRow.expires_at <= now)) {
      await settleRingPath();
      return json({ error: "messenger_audio_authorization_invalid", code: "authorization_invalid", reachable: false, sent: 0 }, 409);
    }
    billingAuthorization = {
      authorization_id: authRow.authorization_id, call_id: authRow.call_id, attempt_id: authRow.attempt_id,
      payer_uid: authRow.payer_uid, callee_uid: authRow.callee_uid,
      media: "audio", quality_sku: "audio", provider: "cloudflare",
      rate_centitokens_per_participant_minute: authRow.rate_centitokens_per_participant_minute,
      price_version: authRow.price_version,
      daily_audio_allowance_participant_seconds: Number(callPolicyConfig.messengerAudioFreeParticipantSecondsDaily ?? 0),
      allowance_day: authRow.allowance_day, reservation_ref: authRow.reservation_ref, expires_at: authRow.expires_at,
    };
    messengerAudioSnapshot = {
      authorization_id: authRow.authorization_id,
      call_id: authRow.call_id,
      attempt_id: authRow.attempt_id,
      payer_uid: authRow.payer_uid,
      callee_uid: authRow.callee_uid,
      media: "audio",
      quality_sku: "audio",
      provider: "cloudflare",
      rate_centitokens_per_participant_minute: authRow.rate_centitokens_per_participant_minute,
      price_version: authRow.price_version,
      daily_audio_allowance_participant_seconds: Number(callPolicyConfig.messengerAudioFreeParticipantSecondsDaily ?? 0),
      allowance_day: authRow.allowance_day,
      reservation_ref: authRow.reservation_ref,
      expires_at: authRow.expires_at,
    };
    const initialized = await initializeMessengerCallBilling(env, messengerAudioSnapshot).catch(() => ({ ok: false, status: 503, body: {} }));
    if (!initialized.ok) {
      await settleRingPath();
      return json({ error: "messenger_audio_billing_unavailable", code: "billing_unavailable", reachable: false, sent: 0 }, 503);
    }
  }
  // The callee has no authenticated HTTP round-trip before it joins the
  // CallRoom. Carry only server-frozen billing identifiers in every ring
  // transport so its CallSession can attest the same authorization/call.
  const messengerBillingRingFields = billingAuthorization ? {
    authorization_id: billingAuthorization.authorization_id,
    attempt_id: b.attempt_id as string,
    price_version: billingAuthorization.price_version,
    call_id: billingAuthorization.call_id,
  } : {};

  // ── [STREAM-GATE-1 2026-08-21] LEGACY-DIAL BUILD FLOOR ("update required") ──
  //
  // Specs/PLAN-STREAM-ONLY-CALLS-2026-08-21.md §2.1 option C, owner decision 4b.2.
  // Calling is moving to Stream-only in a HARD CUTOVER. A pre-cutover build and a
  // cutover build cannot connect to each other — different engines, different
  // signalling — so a legacy dial after the cutover is a call that can only end
  // in silence. Refuse it here and say why.
  //
  // PLACEMENT: immediately after the config read and BEFORE the first side
  // effect (the stale-device prune, the glare pair-DO hop, participants, the
  // ring). A refused dial must cost the callee nothing — their phone never
  // wakes — exactly like the admission gate above.
  //
  // INERT BY DEFAULT: `callMinBuild` is 0 in DEFAULTS, which disables the gate
  // completely. Nothing changes until the owner arms it in KV.
  // [STREAM-AUTH-1 2026-08-21] The arithmetic moved to lib/call_build_gate.ts —
  // unchanged, but now SHARED with the Stream authorisation endpoint
  // (routes/stream_video_calls.ts `streamCallPlace`) so the two lanes cannot
  // read the same flag differently. Telemetry and the refusal body below are
  // deliberately NOT shared: they are lane-specific.
  const callMinBuild = callMinBuildFrom(callPolicyConfig as { callMinBuild?: number } | null);
  if (callMinBuild > 0) {
    // The build the client claims. `x-app-build` is the header the cutover build
    // sends; `app_build` in the body is accepted as a fallback so a client that
    // cannot easily set a header still has a way to identify itself. Absent or
    // unparseable → 0, i.e. "did not tell us", which is what every pre-cutover
    // build does, since the header is introduced BY the cutover build.
    const clientBuild = clientBuildFrom(req.headers.get(APP_BUILD_HEADER), b.app_build);
    // A client that opted into Stream (`stream_capable`) is post-cutover BY
    // CONSTRUCTION and never uses the Cloudflare media path below, so it is
    // never refused here even if it forgot the header. This is a deliberate
    // belt-and-braces: the gate must not be able to lock out the very lane it
    // exists to migrate everyone onto.
    const streamCapable = b.stream_capable === true;
    if (!streamCapable && clientBuild < callMinBuild) {
      try {
        const [callerEmail, callerPhone] = await Promise.all([
          emailFor(env, ctx.uid).catch(() => null),
          phoneFor(env, ctx.uid).catch(() => null),
        ]);
        await trackUserContact(env, ctx.uid, callerEmail, callerPhone,
          "call_refused_update_required", "avatok", {
            call_id: b.callId, to_uid: b.to,
            client_build: clientBuild, min_build: callMinBuild,
            // 0 means the request carried no build at all — the population that
            // will dominate immediately after the cutover, and the number to
            // watch fall as the fleet updates.
            build_reported: clientBuild > 0,
            kind: b.kind ?? "audio", via: b.via ?? "chat",
            trace_id: traceId,
            app_name: "avatok", service_name: "avatok-api", worker: true,
          }, traceId || undefined);
      } catch { /* telemetry must never change a refusal */ }
      await settleRingPath();
      // 426 Upgrade Required — the one status that means exactly this.
      //
      // The body carries BOTH contracts on purpose:
      //  • `error`/`code` = "update_required" + `message` — the machine-readable
      //    refusal a cutover client keys on to show "Update required".
      //  • `sent:0` + `reachable:false` — the EXISTING legacy shape. Unmodified
      //    pre-cutover clients already read `reachable === false` (see
      //    app/lib/features/avatok/chat_thread/calls.dart:216 and :436) and
      //    abort the dial instead of playing ringback into a call that will
      //    never connect. So even a client that has never heard of this refusal
      //    degrades to an honest "unreachable" rather than a hung ring.
      return json({
        error: "update_required",
        code: "update_required",
        sent: 0,
        reachable: false,
        routed: "update_required",
        min_build: callMinBuild,
        client_build: clientBuild,
        message: UPDATE_REQUIRED_MESSAGE,
      }, 426);
    }
  }

  // Kill switches, read once. `!== false` is deliberate: a KV blob written before
  // these keys existed has neither, and the correct reading of "absent" is the
  // DEFAULTS value (true), not false. Setting either to false in KV restores the
  // previous behaviour exactly, with no rebuild.
  fastPath = (callPolicyConfig as { callRingFastPath?: boolean } | null)?.callRingFastPath !== false;
  const presenceRouting =
    (callPolicyConfig as { callPresenceRouting?: boolean } | null)?.callPresenceRouting !== false;
  const presenceFreshSec = Number(
    (callPolicyConfig as { presenceFreshSec?: number } | null)?.presenceFreshSec ?? 90,
  );
  // [CALL-PRESENCE-2 2026-08-08] The OFFLINE threshold — the owner's rule stated
  // plainly: "if a callee's phone has not checked in for X, it is off, and the
  // caller goes straight to Ava." Set to 0 (or any non-positive value) in KV to
  // disable age-based offline routing entirely and fall back to [CALL-PRESENCE-1]
  // behaviour (stale + zero tokens only), with no rebuild.
  const presenceOfflineSec = Number(
    (callPolicyConfig as { presenceOfflineSec?: number } | null)?.presenceOfflineSec ?? 300,
  );
  const unknownPolicyOn = callPolicyConfig?.unknownAvatokCallerReceptionistEnabled === true;
  // [CALL-4RINGS-1 2026-08-08] The ring policy is resolved HERE, from the config
  // read that is already in flight, and handed to the CallRoom in the
  // /participants body. It is deliberately NOT read inside the DO: setParticipants
  // sits on the dial critical path that [CALL-RING-FASTPATH-1] just cleared, and a
  // cold DO doing its own KV round-trip there would put config latency straight
  // back in front of the ring. `!== false` for the same reason as the flags above.
  const ringPolicy = {
    enabled: (callPolicyConfig as { callRealRingCount?: boolean } | null)?.callRealRingCount !== false,
    rings: Number((callPolicyConfig as { receptionistRings?: number } | null)?.receptionistRings ?? 4),
    cycleMs: Number((callPolicyConfig as { ringCycleMs?: number } | null)?.ringCycleMs ?? 6000),
  };
  // [CALL-RING-NODELAY-1 2026-08-21] The prewarm wait is only worth arming when
  // the SFU it prewarms is actually on. The lease's ONLY early exit is
  // /prewarm-ready, and that requires an SFU seat (`transport_prepared` is
  // written by /sfu-seat-prepare, which sits behind call_sfu.ts guard() — a
  // hard 503 while callSfuV1 is false). With callSfuV1 off, every callee with
  // a live Inbox socket and fresh presence — precisely the ones who would ring
  // in under a second on the WS fast lane — sat in PREWARMING for the full
  // callSilentPrewarmDeadlineMs (12 s in prod) while the caller stared at
  // "Waking their phone…". Measured on every call in the 2026-08-20 session:
  // placed 18:21:29.65, ring shown 18:21:40.86. The spec's §9 invariant
  // ("server flag rollback restores the existing ring path without a client
  // release") was asserted but never encoded; this line encodes it.
  const silentTransportPrewarmConfigured =
    (callPolicyConfig as { callSilentTransportPrewarmV1?: boolean } | null)?.callSilentTransportPrewarmV1 === true &&
    (callPolicyConfig as { callSfuV1?: boolean } | null)?.callSfuV1 === true;
  const silentPrewarmDeadlineMs = Math.max(2_000, Math.min(30_000,
    Number((callPolicyConfig as { callSilentPrewarmDeadlineMs?: number } | null)?.callSilentPrewarmDeadlineMs ?? 12_000)));
  // The ring lifetime this call will actually be given. Used for the ring-receipt
  // token TTL as well as the DO deadline — a token that expired at 20 s while the
  // ring ran to 28 s would 403 exactly the late cycles this feature counts.
  const ringLifetime = ringLifetimeMs(ringPolicy);

  let contactPolicy: ContactPolicy | null = null;
  if (!fastPath || unknownPolicyOn) {
    contactPolicy = await callerContactPolicy(env, b.to, ctx.uid);
    markRingStage("contact_policy");
  }
  const routeUnknownCaller = contactPolicy
    ? shouldRouteUnknownAvatokCaller(contactPolicy, unknownPolicyOn)
    : false;
  const contactPolicyTelemetry = (async () => {
    const cp = contactPolicy ?? await callerContactPolicy(env, callTo, ctx.uid).catch(() => null);
    if (!cp) return;
    await track(env, callTo, "call_contact_policy_decision", "avatok", {
      call_id: b.callId,
      caller_uid: ctx.uid,
      known: cp.known,
      saved: cp.saved,
      reason: cp.known ? cp.matched_by : cp.reason,
      policy_enabled: unknownPolicyOn,
      routed: routeUnknownCaller ? "receptionist" : "ring",
      // true = the lookup ran AFTER the response, so it could not have influenced
      // routing on this call (and by construction did not need to).
      deferred: contactPolicy === null,
      app_name: "avatok", service_name: "avatok-api", worker: true,
    });
  })().catch(() => { /* policy telemetry never changes routing */ });
  if (execCtx) execCtx.waitUntil(contactPolicyTelemetry);
  else await contactPolicyTelemetry;
  if (routeUnknownCaller) {
    try {
      const callStub = env.CALL_ROOMS.get(env.CALL_ROOMS.idFromName(effectiveCallId()));
      const participantResponse = await callStub.fetch("https://call-room/participants", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ callId: billingAuthorization?.call_id ?? b.callId, callerUid: ctx.uid, calleeUid: b.to, ...(messengerAudioSnapshot ? { messengerBillingSnapshot: messengerAudioSnapshot, mediaKind: "audio" } : {}) }),
      });
      if (!participantResponse.ok) { await settleRingPath(); return json({ error: "call_authority_unavailable" }, 503); }
    } catch {
      await settleRingPath();
      return json({ error: "call_authority_unavailable" }, 503);
    }
    await settleRingPath();
    return json({
      sent: 0,
      reachable: true,
      routed: "receptionist",
      routing_reason: "unknown_caller",
      start: { to: b.to, call_id: b.callId, trace_id: traceId, activation_mode: "unknown_caller" },
    });
  }
  // [CALL-RING-FASTPATH-1] The callee's device count is a PRIMARY-D1 read (never
  // a replica — a stale 0 would be a false "no device"). It used to be awaited in
  // front of every ring to produce `sent:` in a response the caller only reads
  // AFTER the ring, plus a `devices` property on a telemetry event. It is now a
  // promise resolved on demand:
  //   • presence routing resolves it PRE-ring (a stale heartbeat AND zero tokens
  //     is the offline verdict) — but concurrently with the presence read, not
  //     serially after it;
  //   • the dialpad routing engine resolves it pre-ring, as before;
  //   • everything else resolves it after the phone is already ringing.
  let n = 0;
  let tokenCountLanded = false;
  const resolveTokenCount = async (): Promise<number> => {
    if (!tokenCountLanded) { n = await tokenCountPromise; tokenCountLanded = true; }
    return n;
  };
  if (!fastPath) {
    await resolveTokenCount();
    markRingStage("token_count");
  }

  // ── [CALL-PRESENCE-1 2026-08-07] PRESENCE-FIRST ROUTING ────────────────────
  //
  // Read BEFORE the DO round-trips, from the batch started at the top, so it
  // costs nothing serial. What it replaces: on 2026-08-07 the InboxDO told us
  // `live:false` at +3.6 s — the server KNEW the callee was offline — and the
  // caller was still made to wait until +28 s for Ava. Presence turns that into
  // an immediate, honest answer.
  //
  // THREE-VALUED, and the third value is the important one. `unknown` (no
  // record, no Upstash credentials, a read error, or a client too old to beat)
  // is NOT `stale`; it rings exactly as it always did. Only positive evidence —
  // a record that exists and has gone quiet — can shorten a call.
  //
  // ── [CALL-PRESENCE-2 2026-08-08] AND THE OWNER'S ACTUAL RULE ────────────────
  //
  // [CALL-PRESENCE-1] shipped one offline trigger: stale heartbeat AND zero FCM
  // tokens. In production almost nobody has zero tokens — a token survives the
  // phone being switched off, flight mode, a dead battery and a week in a drawer —
  // so the trigger essentially never fired. Measured on 2026-08-08: call
  // avatok-d679c96a read `presence:'stale' presence_age_ms:657033` (the callee's
  // phone had not checked in for ELEVEN MINUTES), the server had that fact before
  // it rang, and the caller was still given ~18 s of ringing.
  //
  // The owner's rule is about TIME, not tokens: past `presenceOfflineSec` the
  // phone is off and the caller goes straight to Ava. A live FCM token is not
  // evidence to the contrary — it is evidence that we could TRY to wake it, which
  // is exactly the 20-second gamble the caller is being made to sit through.
  let presenceState: PresenceState = "unknown";
  let presenceAgeMs: number | null = null;
  let presenceDecision = "ring";
  // [CALL-PRESENCE-2] Why the read went the way it did — reported on every single
  // call so a rise in `error`/`timeout` is visible as itself instead of hiding
  // inside `presence:'unknown'`.
  let presenceRead = "not_read";
  let presenceReadMs: number | null = null;
  let presenceReadStatus: number | null = null;
  // Which arm of the offline test fired: 'age' (the new, owner-stated rule),
  // 'no_tokens' ([CALL-PRESENCE-1]'s original), or null.
  let offlineBy: string | null = null;
  const emitPresenceDecision = async (decision: string, routingReason: string | null): Promise<void> => {
    try {
      const [callerEmail, calleeEmail] = await Promise.all([
        emailFor(env, ctx.uid).catch(() => null),
        emailFor(env, callTo).catch(() => null),
      ]);
      const props = {
        call_id: callIdStr,
        presence: presenceState,
        presence_age_ms: presenceAgeMs,
        token_count: n,
        decision,
        routing_reason: routingReason,
        from_uid: ctx.uid, to_uid: callTo,
        from_email: callerEmail, to_email: calleeEmail,
        fresh_sec: presenceFreshSec,
        // [CALL-PRESENCE-2] The offline contract, on every event: the threshold in
        // force, which arm of the test fired, and — the fix for the 2026-08-08
        // unexplained `unknown` — how the Upstash read itself actually went.
        offline_sec: presenceOfflineSec,
        offline_by: offlineBy,
        presence_read: presenceRead,
        presence_read_ms: presenceReadMs,
        presence_read_status: presenceReadStatus,
        via: b.via ?? "chat", trace_id: traceId,
        app_name: "avatok", service_name: "avatok-api", worker: true,
      };
      // BOTH parties. A call is a conversation between two people (CLAUDE.md), so
      // either email must be able to retrieve this decision.
      await trackUser(env, ctx.uid, callerEmail, "call_presence_decision", "avatok", props);
      await trackUser(env, callTo, calleeEmail, "call_presence_decision", "avatok", props);
    } catch { /* presence telemetry must never change routing */ }
  };
  if (presenceRouting) {
    const [read] = await Promise.all([presenceReadPromise, resolveTokenCount()]);
    markRingStage("presence");
    const rec = read.record;
    presenceRead = read.outcome;
    presenceReadMs = read.ms;
    presenceReadStatus = read.status;
    if (rec) {
      presenceAgeMs = Math.max(0, Date.now() - rec.lastSeenMs);
      presenceState = presenceAgeMs <= presenceFreshSec * 1000 ? "fresh" : "stale";
    }
    // [CALL-PRESENCE-2] THE OWNER'S RULE. `stale` is a spectrum: 91 seconds is a
    // radio nap, eleven minutes is a phone that is off. `presenceOfflineSec` is
    // where one becomes the other. A non-positive value disables the age arm and
    // leaves [CALL-PRESENCE-1]'s zero-token arm alone.
    const offlineMs = presenceOfflineSec > 0 ? presenceOfflineSec * 1000 : 0;
    const heartbeatLapsed = presenceState === "stale"
      && offlineMs > 0
      && presenceAgeMs !== null
      && presenceAgeMs >= offlineMs;
    // [CALL-PRESENCE-3] NO RECORD IS ALSO OFFLINE. The presence key lives under a
    // TTL of at least presenceOfflineSec*6, so a clean `miss` (the read SUCCEEDED
    // and found nothing) means the account has not checked in for AT LEAST the
    // TTL — far past the offline threshold — or has never checked in at all.
    // Owner's rule 2026-08-09 (the Arti call, avatok-6e17cdc2): same phone, two
    // accounts; the inactive account has no record, and the caller sat through
    // seven beeps that could not possibly be answered. Either way the phone that
    // would ring is not checking in AS THIS ACCOUNT, so the caller goes straight
    // to Ava. `error`/`timeout` reads stay fail-open below — a Redis hiccup must
    // never divert a call. presenceOfflineSec <= 0 disables this arm with the
    // same kill switch as the age arm.
    const noRecord = presenceRead === "miss" && offlineMs > 0;
    if ((presenceState === "stale" && (n === 0 || heartbeatLapsed)) || noRecord) {
      // PROVABLY OFFLINE, by either of two independent proofs:
      //   • `no_tokens` — the phone stopped checking in AND there is no FCM token
      //     left to wake it with ([CALL-PRESENCE-1]);
      //   • `age` — the phone has not checked in for `presenceOfflineSec`
      //     ([CALL-PRESENCE-2], the owner's rule). A token may still exist; it just
      //     is not worth twenty seconds of the caller's time to gamble on.
      // Either way, ringing this is the caller listening to a phone that will not
      // ring.
      //
      // But it goes through the SAME gate the no-answer handoff uses — wallet
      // spendable + the owner's scenario toggle + the receptionist master switch
      // (routes/receptionist.ts). Bypassing it would start a metered AI session
      // the owner never authorised, on a call they never heard. If the owner is
      // not eligible we fall through to the ordinary ring, which produces the
      // ordinary unreachable outcome — the pre-existing behaviour, not a new one.
      const eligibility = b.kind === "video"
        ? { eligible: false, reason: "video" }
        : await receptionistNoAnswerEligibility(env, b.to)
            .catch(() => ({ eligible: false, reason: "wallet_unavailable" }));
      // Attribution BEFORE the emits below, so every event on this path (including
      // the two authority_unavailable early returns) carries it.
      offlineBy = noRecord && presenceState === "unknown"
        ? "no_record"
        : heartbeatLapsed && n > 0 ? "age" : (n === 0 ? "no_tokens" : "age");
      if (eligibility.eligible) {
        // A DISTINCT decision value when the AGE arm is what made this call skip
        // the ring and nothing else would have. `receptionist_offline` already
        // exists in PostHog for the zero-token population, so reusing it would make
        // the new behaviour unprovable — a nonzero count of
        // `receptionist_offline_immediate` is the assertion that the owner's rule
        // is live (ship gate rule 3).
        presenceDecision = (heartbeatLapsed && n > 0) || noRecord
          ? "receptionist_offline_immediate"
          : "receptionist_offline";
        try {
          const callStub = env.CALL_ROOMS.get(env.CALL_ROOMS.idFromName(effectiveCallId()));
          const participantResponse = await callStub.fetch("https://call-room/participants", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ callId: billingAuthorization?.call_id ?? b.callId, callerUid: ctx.uid, calleeUid: b.to, ...(messengerAudioSnapshot ? { messengerBillingSnapshot: messengerAudioSnapshot, mediaKind: "audio" } : {}) }),
          });
          if (!participantResponse.ok) {
            await emitPresenceDecision("authority_unavailable", "offline");
            await settleRingPath();
            return json({ error: "call_authority_unavailable" }, 503);
          }
        } catch {
          await emitPresenceDecision("authority_unavailable", "offline");
          await settleRingPath();
          return json({ error: "call_authority_unavailable" }, 503);
        }
        markRingStage("participants_offline");
        // AWAITED, not fired-and-forgotten: this is an early return, and workerd
        // drops unawaited work on early-return paths.
        await emitPresenceDecision(presenceDecision, "offline");
        await settleRingPath();
        // [CALL-PRESENCE-2] THE WIRE VALUES ARE DELIBERATELY UNCHANGED.
        // `routed:'receptionist'` + `routing_reason:'offline'` is what SHIPPED
        // clients already understand — `_kRoutingReasons['offline']` in
        // app/lib/core/ui/call_failure_copy.dart carries the honest "their phone is
        // off" copy, and CallSession.noteServerReceptionistRoute('offline') cancels
        // the ring timers and hands to Ava. A new reason string here would fall
        // through to the generic default on every phone in the field, so the new
        // trigger is reported in TELEMETRY (`decision` / `offline_by`) and nowhere
        // else. `presence` stays the three shipped values for the same reason: no
        // fourth value the client has never seen.
        return json({
          sent: 0,
          reachable: true,
          routed: "receptionist",
          routing_reason: "offline",
          presence: presenceState,
          presence_age_ms: presenceAgeMs,
          callee_live: false,
          start: { to: b.to, call_id: b.callId, trace_id: traceId, activation_mode: "offline" },
        });
      }
      presenceDecision = "ring_offline_ineligible";
    } else if (presenceState === "stale") {
      // STALE BUT NOT OFFLINE — age is between `presenceFreshSec` and
      // `presenceOfflineSec`. A phone that missed a few beats to a radio nap is not
      // an off phone, and it still holds a live FCM token, so this keeps the
      // pre-[CALL-PRESENCE-2] behaviour EXACTLY: ring it. The caller is told
      // `presence:'stale'` so their app can say something true ("Waking their
      // phone…") instead of inventing progress.
      presenceDecision = "ring_stale";
    } else if (presenceState === "fresh") {
      presenceDecision = "ring_fresh";
    } else {
      // [CALL-PRESENCE-2] FAIL-OPEN, STILL — but no longer SILENT.
      //
      // A call must never be diverted because Upstash hiccuped, so every
      // non-answer rings exactly as it always did. What changes is that the two
      // populations are now separable: `ring_unknown` means the callee has
      // genuinely never beaten (an old client, or a brand-new account), while
      // `ring_unknown_read_failed` means WE could not read and the caller's
      // routing was decided on missing information. The second one used to be
      // indistinguishable from the first, which is why the 2026-08-08
      // `presence=unknown` on call avatok-33e7f239 — 43 s before the very next
      // call read that same callee's record successfully — had no explanation.
      // A nonzero rate of `ring_unknown_read_failed` is a REDIS alarm, not a
      // property of the callee.
      presenceDecision = presenceRead === "miss" || presenceRead === "not_read"
        ? "ring_unknown"
        : "ring_unknown_read_failed";
    }
  }
  // [DEVMAP-PRUNE-1 2026-07-22] Stale "active" account_devices mappings whose FCM
  // token has rotated away (device_tokens row gone, e.g. reinstall / OS token
  // rotation) were never cleaned, so they inflated the reachability snapshot and
  // the send-time fan-out (real case 2026-07-22: a callee with 1 live token but 4
  // stale active-no-token mappings). Dial time is the moment reachability truth
  // matters, so we prune the CALLEE's stale mappings opportunistically right here,
  // before the snapshot below reads them. A 7-day last_seen grace avoids racing a
  // device mid-token-rotation (token briefly absent but the device is still real).
  // Best-effort and self-contained: it must NEVER block or fail the call, and
  // pre-migration D1s lacking these tables are caught just like the snapshot.
  // Captured as a plain const: `b.to` is validated truthy at the top of this
  // handler (line ~197) and never reassigned, but that narrowing does not survive
  // into an async closure (same reason ringDeliveredCallId/deferredTo exist below).
  const reachabilityTo = b.to as string;
  const reachabilityTelemetry = (async () => {
    // [CALL-RING-FASTPATH-1] The device count is resolved HERE, inside the
    // deferred closure, instead of being awaited in front of the ring. On the
    // presence and dialpad paths it has already landed and this is free.
    const tokens = await resolveTokenCount();
    try {
      const cutoff = Date.now() - 7 * 86400000; // 7 days unseen
      const pr = await env.DB_META.prepare(
        "UPDATE account_devices SET active=0 WHERE account_id=?1 AND active=1 AND last_seen < ?2 " +
        "AND device_id NOT IN (SELECT device_id FROM device_tokens WHERE token IS NOT NULL)",
      ).bind(b.to, cutoff).run();
      const pruned = pr?.meta?.changes ?? 0;
      if (pruned > 0) {
        await env.Q_ANALYTICS.send({
          event: "device_mappings_pruned", uid: ctx.uid, ts: Date.now(),
          props: {
            to: b.to, pruned, trace_id: traceId,
            app_name: "avatok", service_name: "avatok-api", worker: true, account_id: ctx.uid,
          },
        });
      }
    } catch { /* pre-migration or transient: prune must never block the call */ }
  // [CALL-TELEMETRY-1 2026-07-14] Always-on callee reachability snapshot at dial
  // time — one event per call attempt that says exactly what the callee's device/
  // token state looked like WHEN the caller dialed. Motivation: the 2026-07-11
  // "user is not available" incident (caller hdavy2005@gmail.com) — the ring died
  // in the consumer with all_tokens_pruned, and nothing recorded whether the
  // callee had an active device mapping, a switched-out mapping, or only stale
  // legacy tokens at dial time. Best-effort; never blocks the call.
    try {
      const snap = await calleeReachabilitySnapshot(env.DB_META, reachabilityTo);
      await env.Q_ANALYTICS.send({
        event: "call_callee_reachability", uid: ctx.uid, ts: Date.now(),
        props: {
          to: b.to, call_id: b.callId, call_type: b.kind ?? "audio", trace_id: traceId,
          token_count: tokens, ...snap,
          app_name: "avatok", service_name: "avatok-api", worker: true, account_id: ctx.uid,
        },
      });
    } catch { /* telemetry must never block the call */ }
    if (tokens === 0) {
      // Visibility: the caller reached someone with 0 registered devices — the
      // exact "no device registered" failure. Emit telemetry keyed on the callee
      // uid so reachability gaps are queryable per-user. This path was once a
      // silent 404 with no analytics.
      //
      // [CALL-RING-FASTPATH-1] Moved INSIDE this deferred closure and AWAITED.
      // It used to be two `void env.Q_ANALYTICS.send(...)` calls on the response
      // path, which is exactly the pattern workerd drops (see the worker
      // error-path telemetry note in CLAUDE.md) — awaiting them inside a closure
      // the runtime is already keeping alive is strictly more reliable, and it is
      // no longer in front of the ring.
      try {
        await env.Q_ANALYTICS.send({
          event: "call_no_device", uid: ctx.uid, ts: Date.now(),
          props: {
            to: b.to, call_id: b.callId, call_type: b.kind ?? "audio", trace_id: traceId,
            app_name: "avatok", service_name: "avatok-api", worker: true, account_id: ctx.uid,
          },
        });
        // [MULTIACCT-1] Also emit push_no_device from the PRODUCER side so the
        // zero-token case is symmetrical with the consumer's all-tokens-pruned case
        // (both now surface push_no_device). Reachability queries catch either.
        await env.Q_ANALYTICS.send({
          event: "push_no_device", uid: ctx.uid, ts: Date.now(),
          props: {
            kind: "call", to: b.to, call_id: b.callId, reason: "zero_tokens",
            app_name: "avatok", service_name: "avatok-api", worker: true, account_id: ctx.uid,
          },
        });
      } catch { /* best-effort: telemetry must never block the response */ }
    }
  })();
  // These writes describe reachability; they must never delay reachability.
  if (execCtx) execCtx.waitUntil(reachabilityTelemetry);
  else await reachabilityTelemetry;
  // CALL-NODEVICE-AVA-1 (2026-07-08): a 0-device callee is NOT dead-ended here.
  // Zero registered devices is the STRONGEST form of "unreachable" (phone off /
  // logged out / tokens pruned) — exactly the case the Ava receptionist exists
  // for. Returning 404/reachable:false made the caller's client abort BEFORE
  // mounting the call screen (chat_thread.dart ~L2187), so Ava never got a turn
  // and the user just saw "X is unreachable — ask them to open AvaTOK" (PostHog
  // call_no_device / http_404, e.g. callee "Sat"). So we fall through to the
  // normal ring path below: the push fan-out finds 0 tokens and the consumer
  // emits ring-ack ok=false (and the client's device-ringing timer is the
  // backstop), which drives the caller into the unreachable → Ava handoff.
  // [CALL-PRESENCE-1] The one case that now SHORT-CIRCUITS this twenty-second
  // wait is handled above: zero tokens AND a stale heartbeat — positive evidence
  // of offline, not merely an absence of tokens. Zero tokens with fresh or
  // unknown presence still takes this slow, honest path.
  // ── CALLER IDENTITY SNAPSHOT ───────────────────────────────────────────────
  // [CALL-IDENTITY-SNAPSHOT-1 2026-08-01] Resolve the caller's PUBLIC AvaTOK
  // PROFILE identity — the card they actually edit (first + last name, avatar) —
  // and stamp it onto the call. Spec: Specs/CALL-OUTCOMES-FROZEN-2026-08-01.md.
  //
  // WHAT WAS WRONG. This used `nameFor()`, which asked Clerk FIRST. A caller
  // whose AvaTOK profile reads "Arti Singh" was announced to the callee as
  // "Davy" — her Google account's first name. nameFor now reads the profile
  // only, and this call site takes the FULL display name rather than the
  // greeting first-name, because a call screen should say "Arti Singh" while a
  // spoken greeting says "Hi Arti".
  //
  // The snapshot is IMMUTABLE for the life of the call: if the caller renames
  // their profile mid-ring, this call keeps the name the callee first saw. The
  // next call picks up the new one.
  //
  // The client-sent `fromName` is a LAST-resort fallback only — it is
  // unauthenticated and was the source of raw "user_xxx" uids appearing as
  // caller names. It must never outrank the server-resolved profile.
  //
  // [CALL-RING-FASTPATH-1 2026-08-07] The lookup now STARTS in the concurrent
  // batch at the top of this handler and is memoised per isolate for 60 s, so
  // for any caller who has dialled recently it costs nothing at all. On the
  // fast path a COLD lookup is additionally bounded by IDENTITY_RING_BUDGET_MS:
  // a profile read is not permitted to hold a phone silent indefinitely.
  //
  // If that budget ever fires, the WS ring carries the caller's own `fromName`
  // (the string their local ProfileStore holds — in practice the same name) and
  // `nameSource` records `client`, which is the existing alarm for "the profile
  // lookup is failing". The FCM copy below still waits for the authoritative
  // profile, so a COLD phone always paints the real name and photo.
  let ident: CallerIdentity = cachedIdentity(ctx.uid) ?? null;
  if (!ident) {
    ident = fastPath
      ? await Promise.race<CallerIdentity>([
          identityPromise,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), IDENTITY_RING_BUDGET_MS)),
        ])
      : await identityPromise;
  }
  markRingStage("identity");
  const clientName = (b.fromName ?? "").trim();
  const resolvedName = ident?.display_name || clientName || "AvaTOK";
  const nameSource = ident?.display_name ? "profile" : (clientName ? "client" : "fallback");
  // Avatar travels as URL + version, never bytes (FCM payloads are size-capped).
  // `avatar_version` lets the device cache under a key that survives CDN
  // transforms and query-string churn: avatar:{uid}:{avatar_version}.
  const callerAvatarUrl = ident?.avatar_url ?? null;
  const callerAvatarVersion = ident?.avatar_version ?? null;
  const identitySnapshotVersion = ident?.profile_version ?? 0;
  // Mint before glare arbitration so the pair DO can atomically hand the
  // losing placer the already-proceeding call's callee credential.
  const callerRoomToken = crypto.randomUUID();
  const calleeRoomToken = crypto.randomUUID();
  // ── LIVE TAKEOVER ──────────────────────────────────────────────────────────
  // If the caller (ctx.uid) is dialing the EXACT person (b.to) who is, RIGHT NOW,
  // leaving them a message via their AI Receptionist, this isn't a cold call — the
  // owner has reached the person being screened. Signal the active CF receptionist
  // session to bow out ("here's <owner> now, connecting you") and CANCEL the
  // voicemail; the call below then rings through so they connect live. Best-effort:
  // a takeover hiccup must never block placing the call.
  //
  // [CALL-RING-FIRST-1 2026-08-03] MOVED OFF THE CRITICAL PATH.
  //
  // This ran a D1 SELECT plus, when it matched, a Durable Object round-trip
  // BEFORE the phone was rung — on EVERY call, for a case that is almost never
  // true (the callee must be mid-conversation with this exact caller's Ava right
  // now). The takeover only has to beat the callee ANSWERING, which is seconds
  // away; it never had to beat the ring. Paying for it up front made every call
  // slower so that a rare one could be marginally tidier.
  //
  // `waitUntil` keeps it running to completion after the response — it is not
  // dropped, just no longer in front of the ring.
  const runLiveTakeover = async () => {
    try {
      const sess = await env.DB_META.prepare(
        "SELECT id FROM receptionist_sessions WHERE owner_uid=?1 AND caller_uid=?2 AND status='active' ORDER BY created_at DESC LIMIT 1",
      ).bind(ctx.uid, b.to).first<{ id: string }>();
      if (sess?.id) {
        const stub = env.RECEPTION_ROOM_CF.get(env.RECEPTION_ROOM_CF.idFromName(sess.id));
        await stub.fetch("https://do/takeover", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ owner_name: resolvedName, call_id: b.callId }),
        }).catch(() => {});
      }
    } catch { /* best-effort — takeover is an enhancement, never block the call */ }
  };
  // [CALL-GLARE-2] Deterministic mutual-dial (glare) resolution — server side.
  // Before we push the ring, check a PAIR-keyed CallRoom DO instance (addressed by
  // sorted-uid pair, so both dial directions hit the SAME instance) for a reciprocal
  // pending invite from the callee within the 30s glare window. If the callee is
  // ALREADY dialing us, we don't open a second room and ring them — we fold both
  // dials into the already-registered reciprocal call and tell this caller to auto-accept
  // it. The client's CALL-GLARE-1 heuristic stays as the fallback for old servers.
  // Best-effort: any DO hiccup falls through to the normal ring below.
  //
  // [CALL-RING-FASTPATH-1 2026-08-07] THIS STAYS SERIAL, DELIBERATELY, and it is
  // the one hop the fast path does not remove. It was considered:
  //   • merging it into the /participants round-trip — impossible, they are two
  //     DIFFERENT DO instances (`glare:<lo>__<hi>` vs `<callId>`), which is the
  //     entire mechanism: both dial directions must land on one pair-keyed
  //     instance for arbitration to be deterministic;
  //   • issuing it CONCURRENTLY with /participants — rejected. If glare wins we
  //     return without ringing, so a speculative participants registration would
  //     leave a CallRoom with a live ring-deadline alarm for a call that never
  //     happened, and that alarm drives the no-answer/receptionist verdict.
  //     Trading a phantom Ava session for ~80 ms is a bad trade.
  try {
    const lo = ctx.uid < b.to ? ctx.uid : b.to;
    const hi = ctx.uid < b.to ? b.to : ctx.uid;
    const pairStub = env.CALL_ROOMS.get(env.CALL_ROOMS.idFromName(`glare:${lo}__${hi}`));
    const gr = await pairStub.fetch("https://call/glare-place", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        placer: ctx.uid, peer: b.to, callId: effectiveCallId(),
        callerRoomToken, calleeRoomToken,
      }),
    });
    const gj = (await gr.json().catch(() => ({}))) as {
      glare?: boolean; join_call_id?: string; roomToken?: string;
    };
    markRingStage("glare");
    if (gj.glare === true && gj.join_call_id) {
      // Mutual dial: this caller auto-accepts the winning call instead of placing a
      // new one. No push is enqueued for this leg — the peer's leg already rang (or
      // will resolve identically), and both devices join the one winning room.
      await settleRingPath();
      return json({
        glare: true, join_call_id: gj.join_call_id,
        roomToken: gj.roomToken ?? "", reachable: true, sent: 0,
      });
    }
  } catch { /* best-effort — glare detection never blocks placing a call */ }
  // [WP1] Event-sourced call stream (plan §13/§14) — emit `call_created` (with
  // the §15.3 rate/routing snapshot) and `routing_decision` (reason:
  // 'rang_owner', since this path always rings the owner first). Gated behind
  // `businessCallUx` so current prod/staging behavior is byte-identical while
  // the flag is off — this is purely additive telemetry; nothing here can
  // change what the caller/callee experience. Uses sensible nulls for
  // per-number/Agent-Profile settings that don't exist yet (WP3/WP4 wire the
  // real lookups). Best-effort — a telemetry hiccup must never block the call.
  // [WP3] routing_decision — computed for real on the dialpad/business channel
  // (blocked/offline/busy/business-hours/agent/voicemail/ring, §3/§15.1/§15.2);
  // every other 'via' keeps the WP1 'rang_owner' placeholder byte-for-byte.
  let routingResult: Awaited<ReturnType<typeof decideRouting>> | null = null;
  if (isDialpad) {
    try {
      // [CALL-RING-FASTPATH-1] Reuse the config already read at the top of this
      // handler rather than paying a second (memoised, but not free) read.
      const cfg = callPolicyConfig ?? await readConfig(env);
      if (cfg.businessCallUx) {
        const callTraceId = traceId || newTraceId();
        // [CALL-RING-FASTPATH-1] The dialpad engine CAN decide not to ring, so
        // the device count is genuinely load-bearing here and is resolved before
        // it runs. Everywhere else it stays deferred.
        await resolveTokenCount();
        // decideRouting() ALSO emits routing_decision internally when
        // businessCallUx is on (lib/call_routing.ts finalize()) — so we do NOT
        // call emitRoutingDecision a second time here for the dialpad path.
        routingResult = await decideRouting(env, {
          call_id: b.callId, trace_id: callTraceId, caller_id: ctx.uid, callee_id: b.to,
          number_dialed: null, via: "dialpad", callee_reachable: n > 0 ? true : undefined,
        }, {
          config: cfg,
          defer: execCtx ? (work) => execCtx.waitUntil(work) : undefined,
        });
        markRingStage("dialpad_routing");
        const callCreatedEvent = emitCallEvent(env, {
          event: "call_created",
          call_id: b.callId,
          trace_id: callTraceId,
          caller_id: ctx.uid,
          callee_id: b.to,
          call_mode: "business",
          ts: Date.now(),
          event_schema_version: EVENT_SCHEMA_VERSION,
          props: { snapshot: routingResult.snapshot, call_type: b.kind ?? "audio", via: "dialpad" },
        }).catch(() => { /* event-stream emission must never change the call */ });
        if (execCtx) execCtx.waitUntil(callCreatedEvent); else await callCreatedEvent;
      }
    } catch { /* dialpad routing failure fails open to the normal human ring */ }
  } else {
    // Friend-call event snapshots are observability only. In production they
    // previously consumed seconds before Q_PUSH was reached, which made the
    // client's reachability guard expire on a healthy sleeping phone. Keep the
    // events, but let Cloudflare finish them after the response/ring is underway.
    // Captured as plain consts: both are validated truthy at the top of this
    // handler (line ~197) and never reassigned, but that narrowing does not
    // survive into an async closure (same idiom as reachabilityTo above).
    const eventCallId = b.callId as string;
    const eventTo = b.to as string;
    const eventTelemetry = (async () => {
      try {
        const cfg = await readConfig(env);
        if (!cfg.businessCallUx) return;
      const callTraceId = traceId || newTraceId();
        const snapshot = await buildCallSnapshot(env);
        await emitCallEvent(env, {
          event: "call_created",
          call_id: eventCallId,
          trace_id: callTraceId,
          caller_id: ctx.uid,
          callee_id: eventTo,
          call_mode: "business",
          ts: Date.now(),
          event_schema_version: EVENT_SCHEMA_VERSION,
          props: { snapshot, call_type: b.kind ?? "audio" },
        });
        await emitRoutingDecision(env, {
          call_id: eventCallId,
          trace_id: callTraceId,
          caller_id: ctx.uid,
          callee_id: eventTo,
          // @ts-expect-error pre-existing: runtime reason code 'rang_owner' vs ReasonCode type casing — changing either is a behaviour change, needs domain review
          reason: "rang_owner",
          snapshot: {
            routing_mode: snapshot.routing_mode,
            business_hours_version: snapshot.business_hours_version,
            blocked: snapshot.blocked,
            agent_enabled: snapshot.agent_enabled,
            voicemail_enabled: snapshot.voicemail_enabled,
            booking_authority: snapshot.booking_authority,
            concurrency_in_use: 0,
          },
        });
      } catch { /* event-stream emission must never change the call */ }
    })();
    if (execCtx) execCtx.waitUntil(eventTelemetry);
    else await eventTelemetry;
  }
  // [WP3-ACT-1] ACT on the routing decision (plan §3/§15.1/§15.2) instead of
  // always ringing regardless of what decideRouting() said. Only reachable when
  // businessCallUx is on AND via:'dialpad' (routingResult is null otherwise, or
  // on any decideRouting hiccup — fail OPEN to the normal ring below, exactly
  // the prior byte-identical behavior). action:'ring' falls through unchanged.
  if (routingResult && routingResult.action !== "ring") {
    if (routingResult.action === "silent_noanswer") {
      // Blocked (or a retired number): the caller must experience a NORMAL
      // ring-then-no-answer — never learn why (§15.2 silent semantics) — so we
      // deliberately do NOT enqueue Q_PUSH or the WS ring. The client's own
      // ring-timeout already drives it into the NoAnswerCard from here.
      await settleRingPath();
      return json({ sent: 0, reachable: true, routed: "no_answer", voicemail_available: false });
    }
    if (routingResult.action === "busy") {
      // Paid line (Mode B) busy overflow (plan §11/§15.1, owner decision
      // 2026-07-11): never ring, never take/keep a hold. If the caller had
      // already confirmed the price prompt for THIS call_id, /api/call/paid/
      // confirm already armed the CallRoom DO's billing ticker with an escrow
      // hold in place before this /api/call round-trip — disarm it now via
      // the DO's existing /billing-disarm route (internally calls
      // lib/call_billing.ts refundUnused, reason BUSY). Best-effort + a no-op
      // when nothing was ever armed (refundUnused no-ops at escrow_balance=0).
      try {
        const stub = env.CALL_ROOMS.get(env.CALL_ROOMS.idFromName(b.callId));
        await stub.fetch("https://call/billing-disarm", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: "BUSY" }),
        });
      } catch { /* best-effort — a disarm hiccup must never block the busy response */ }
      const busyKind = routingResult.busy_kind;
      const message = busyKind === "agents_full"
        ? "All agents are busy right now — please try again in a while."
        : "This line is busy. Please try again later.";
      await settleRingPath();
      return json({ sent: 0, reachable: true, routed: "busy", busy_kind: busyKind, message });
    }
    // 'voicemail' or 'agent' with the ring skipped (offline/busy/business-hours,
    // §15.1): hand the client just enough to call the matching /start route
    // itself (POST /api/voicemail/start or /api/agent/call/start) — no ring is
    // sent for either branch.
    await settleRingPath();
    return json({
      sent: 0, reachable: true, routed: routingResult.action,
      start: { to: b.to, call_id: b.callId, trace_id: traceId },
    });
  }
  // [STREAM-CALL-PILOT-1] The legacy UI does not send `stream_capable`, so it
  // remains byte-for-byte on the Cloudflare path. A future isolated Stream
  // client opts in explicitly; this branch runs after admission, glare, and
  // dialpad routing, but before the first true ring side effect below.
  // A 409 that explicitly names `provider:cloudflare` is a control-plane
  // fallback, not an error: continue through the existing ring below. Any
  // other response is returned and the same call is never dual-rung.
  if (b.stream_capable === true) {
    const streamResponse = await prepareStreamCall({
      env,
      // [WORKER-TSC-RED-1] callPolicyConfig is PlatformConfig | null (config
      // fetch can fail); prepareStreamCall's inline type is non-null. `?? {}`
      // keeps the existing behavior — with no config the pilot flags read as
      // undefined → provider selection falls back exactly as before.
      config: callPolicyConfig ?? {},
      callerUid: ctx.uid,
      calleeUid: callTo,
      callId: callIdStr,
      clientSupportsStream: true,
      scope: "one_to_one",
      media: b.kind === "video" ? "video" : "audio",
      idempotencyKey: req.headers.get("idempotency-key")?.trim() || null,
      traceId,
      ctx: execCtx,
      admissionAlreadyGranted: true,
    });
    if (streamResponse.status !== 409) {
      await settleRingPath();
      return streamResponse;
    }
    const streamBody = await streamResponse.clone().json().catch(() => null) as { provider?: unknown } | null;
    if (streamBody?.provider !== "cloudflare") {
      await settleRingPath();
      return streamResponse;
    }
    // Provider authority deliberately selected legacy. Continue below; no
    // Stream ring was started and the current Cloudflare code remains owner.
  }
  // Generate a cryptographically secure token + expiration for the true ringing receipt
  const ringReceiptToken = crypto.randomUUID();
  // [CALL-NATIVE-DECLINE-1] A distinct capability for the Android notification
  // action. The native button can run with no Clerk/Dart process, so it needs a
  // narrowly scoped proof that cannot authorize any account-level operation.
  const nativeActionToken = crypto.randomUUID();
  // [CALL-WS-AUTH-1 2026-08-03] (audit A1) Per-SIDE CallRoom join credentials.
  //
  // The signalling relay (`/room/<id>`) is matched in index.ts BEFORE any auth
  // and had no identity check of its own, so a leaked call id was enough to join
  // a stranger's call, occupy a seat and read/inject SDP. These are the proof of
  // membership that admission was missing.
  //
  // TWO tokens, one per seat, minted here where both identities are already
  // known and authenticated: `ctx.uid` placed the call, `b.to` is being dialled.
  // A single shared call token would prove membership but not WHICH side, so one
  // party could present it twice and take both seats — the same class of bug
  // [CALL-AUTHZ-1] fixed on the command endpoint, where a client-claimed `role`
  // was trusted instead of derived.
  //
  // They are call-scoped JOIN credentials. Unlike ring receipts they must cover
  // fresh reconnect admissions; terminal CallRoom state revokes them immediately.
  // [CALL-4RINGS-1] `ringLifetime`, not CALL_RING_LIFETIME_MS. This is the TTL of
  // the ring-receipt token, and the callee now presents it once per ring cycle —
  // cycle 4 lands around +18 s plus wake latency. Pinned at 20 s it would 403
  // `expired` on precisely the receipts that decide the handoff. With the flag
  // off `ringLifetimeMs()` returns CALL_RING_LIFETIME_MS, so this line is
  // unchanged in that configuration.
  // [CALL-SILENT-PREWARM-1] The action/ring capabilities must cover the silent
  // preparation lease *plus* the full server-owned ringing window. Reusing the
  // legacy ring-only lifetime would make Accept/Decline and ring receipts
  // expire part-way through an otherwise valid post-prewarm ring.
  // Never insert a silent delay for a killed/background-only app. A live
  // Inbox socket proves the main Flutter isolate is available to own WebRTC;
  // otherwise the call uses the unchanged immediate ring path.
  let silentTransportPrewarm = false;
  if (silentTransportPrewarmConfigured && b.kind !== "video" && presenceState === "fresh") {
    try {
      const liveProbe = await env.INBOX.get(env.INBOX.idFromName(b.to))
        .fetch("https://inbox/live", { method: "GET" });
      const live = (await liveProbe.json().catch(() => ({}))) as { live?: boolean; count?: number };
      silentTransportPrewarm = liveProbe.ok && (live.live === true || (live.count ?? 0) > 0);
    } catch { /* fail open to the ordinary immediate ring */ }
  }
  const expiresAt = Date.now() + ringLifetime +
    (silentTransportPrewarm ? silentPrewarmDeadlineMs : 0);
  // Reconnects are new WebSocket admissions, so this must outlive ringing.
  // Terminal CallRoom state remains the authoritative revocation boundary.
  const roomTokenExpiresAt = Date.now() + CALL_ROOM_TOKEN_LIFETIME_MS;

  // Register participants before the phone is rung. This is fail-closed: a
  // call without a durable participant record cannot authorize later commands.
  //
  // [CALL-RING-FIRST-1 2026-08-03] This is now the ONLY thing between the caller
  // pressing dial and the phone ringing, and it is one round-trip rather than
  // two — the ring credentials ride along in the same request.
  //
  // What used to be here as well: a wallet/KV/settings check for the no-answer
  // receptionist verdict, and a D1+DO live-takeover probe. Both are consumed
  // seconds later, neither had to precede the ring, and together with the rest
  // of the pre-ring chain they are why `call_started` → `call_ws_ring_sent` was
  // measured at 5.3–8.0 SECONDS. The caller stared at invented progress text
  // ("Checking if their phone is on…", "Trying to wake their phone up…") for the
  // duration. The honest fix is to ring sooner, not to narrate the wait better.
  let ringSeq: number | null = null;
  let ringDeadlineMs: number | null = null;
  let calleeLive = false;
  const prewarmNonce = silentTransportPrewarm ? crypto.randomUUID() : "";
  const prewarmGeneration = 1;
  try {
    const callStub = env.CALL_ROOMS.get(env.CALL_ROOMS.idFromName(effectiveCallId()));
    const participantResponse = await callStub.fetch("https://call-room/participants", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        callId: billingAuthorization?.call_id ?? b.callId, callerUid: ctx.uid, calleeUid: b.to,
        mediaKind: b.kind === "video" ? "video" : "audio",
        ...(messengerAudioSnapshot ? { messengerBillingSnapshot: messengerAudioSnapshot } : {}),
        // Ring credentials, merged in from the old second /control hop.
        token: ringReceiptToken, nativeActionToken, expiresAt,
        // [CALL-WS-AUTH-1] The DO is the only place these are ever compared.
        callerRoomToken, calleeRoomToken, roomTokenExpiresAt,
        // [CALL-4RINGS-1] Ring policy resolved from the config read already in
        // flight above, so the DO never pays a KV round-trip on the dial path.
        ringPolicy,
        // [CALL-4RINGS-1] What [CALL-PRESENCE-1] concluded about this callee at
        // dial time. The DO uses it for ONE thing: if the ring backstop is ever
        // reached with zero audible receipts on a callee presence called stale,
        // the presence lane should have short-circuited to Ava long before and
        // did not — that is a defect, and the DO asserts it rather than letting
        // it look like an ordinary quiet call.
        presenceAtDial: presenceState,
        ...(silentTransportPrewarm ? {
          silentPrewarm: {
            enabled: true, nonce: prewarmNonce, generation: prewarmGeneration,
            deadlineMs: Date.now() + silentPrewarmDeadlineMs,
            invite: { callId: effectiveCallId(), from: ctx.uid, to: b.to,
              fromName: resolvedName, callType: b.kind ?? "audio", traceId,
              ringReceiptToken, nativeActionToken, tokenExpiresAt: expiresAt,
              roomToken: calleeRoomToken,
              ...(callerAvatarUrl ? { callerAvatarUrl } : {}),
              ...(callerAvatarVersion ? { callerAvatarVersion } : {}),
              identitySnapshotVersion,
              ...(isDialpad ? { via: "dialpad" } : {}),
              ...messengerBillingRingFields,
            },
          },
        } : {}),
      }),
    });
    const participantResult = await participantResponse.json().catch(() => null) as
      { ok?: boolean; seq?: number; ringDeadlineMs?: number; prewarming?: boolean; prewarm_deadline_ms?: number } | null;
    if (!participantResponse.ok || participantResult?.ok !== true) {
      markRingStage("participants_failed");
      await settleRingPath();
      return json({ error: "call_authority_unavailable" }, 503);
    }
    markRingStage("participants");
    // [CALL-CALLEE-SEQ-1] The ring's authoritative sequence, carried on both
    // ring transports below so the callee can order what it receives.
    ringSeq = typeof participantResult.seq === "number" ? participantResult.seq : null;
    // [CALL-ONE-DEADLINE-1] The absolute deadline the CallRoom alarm will
    // enforce — the single ring timeout, stated once by its owner.
    ringDeadlineMs = typeof participantResult.ringDeadlineMs === "number"
      ? participantResult.ringDeadlineMs : null;
    if (participantResult.prewarming === true) {
      // The callee's silent wake is delivered by the existing durable push lane;
      // no caller ringback starts until CallRoom reports call-ringing.
      // Mirror it over the already-probed live Inbox lane so the main isolate
      // can begin immediately instead of waiting on foreground FCM delivery.
      try {
        await env.INBOX.get(env.INBOX.idFromName(b.to)).fetch("https://inbox/event", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "call_prewarm", callId: effectiveCallId(),
            prewarmNonce, prewarmGeneration,
            prewarmDeadlineMs: participantResult.prewarm_deadline_ms ?? Date.now() + silentPrewarmDeadlineMs,
            trace_id: traceId, ts: Date.now() }),
        });
      } catch { /* FCM plus the server deadline remain the fallback */ }
      await env.Q_PUSH.send({
        kind: "call-prewarm", to: b.to, from: ctx.uid, fromName: resolvedName,
        callId: effectiveCallId(), callType: b.kind ?? "audio", traceId, ts: Date.now(),
        ringReceiptToken, nativeActionToken, tokenExpiresAt: expiresAt,
        roomToken: calleeRoomToken, prewarmNonce,
        prewarmGeneration, prewarmDeadlineMs: participantResult.prewarm_deadline_ms ?? Date.now() + silentPrewarmDeadlineMs,
      } as any);
      const prewarmPolicy = (async () => {
        try {
          const noAnswer = b.kind === "video" ? { eligible: false, reason: "video" }
            : await receptionistNoAnswerEligibility(env, b.to as string);
          await callStub.fetch("https://call-room/no-answer-policy", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ autoReceptionistEligible: noAnswer.eligible, noAnswerReason: noAnswer.reason }),
          });
        } catch { /* fallback remains a no-answer outcome */ }
      })();
      if (execCtx) execCtx.waitUntil(prewarmPolicy); else await prewarmPolicy;
      markRingStage("prewarm_started");
      await settleRingPath();
      return json({ sent: 1, reachable: true, prewarming: true,
        prewarmNonce, prewarmGeneration,
        prewarmDeadlineMs: participantResult.prewarm_deadline_ms ?? null,
        ringbackUrl: "", roomToken: callerRoomToken, presence: presenceState });
    }
  } catch (e) {
    console.error("Failed to register ring receipt token / participants in CallRoom:", String(e));
    markRingStage("participants_threw");
    await settleRingPath();
    return json({ error: "call_authority_unavailable" }, 503);
  }

  // [WS-RING-1] (2026-07-08): PARALLEL ring over the callee's live InboxDO
  // WebSocket. FCM delivery routinely takes 8-15s (the "everyone gets Ava"
  // incident), but an ONLINE callee already holds an open hibernatable WS —
  // broadcast the same ring payload there so their phone rings in <1s and the
  // device-ringing receipt (same ringReceiptToken) comes back before the
  // caller's guard window even matters. Transient /event route: nothing is
  // persisted, offline devices simply miss it and rely on FCM as before.
  // Field names mirror the FCM data payload (fromPub, not from — client
  // contract). Best-effort: a DO hiccup must never block placing the call.
  // [CALL-RING-FIRST-1 2026-08-03] The FAST lane now runs FIRST.
  //
  // This block used to sit BEHIND `await env.Q_PUSH.send(...)` — the fast path
  // queued up behind the slow one. For a callee who has the app open the WS
  // ring reaches them in well under a second, while FCM is routinely 8-15s, so
  // ordering these the wrong way round delayed the only ring that was ever
  // going to be quick.
  try {
    const inboxStub = env.INBOX.get(env.INBOX.idFromName(b.to));
    const wr = await inboxStub.fetch("https://inbox/event", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "call_ring", callId: effectiveCallId(), fromPub: ctx.uid,
        fromName: resolvedName, kind: b.kind ?? "audio",
        ringReceiptToken, nativeActionToken, tokenExpiresAt: expiresAt,
        // [CALL-CALLEE-SEQ-1] Same sequence as the FCM copy. The WS ring and the
        // FCM ring are the SAME transition arriving twice by different routes;
        // sharing the sequence is what lets the client's reducer collapse them
        // instead of racing them.
        ...(ringSeq != null ? { seq: ringSeq } : {}),
    // [CALL-ONE-DEADLINE-1] The absolute ms at which this ring expires, as
    // decided by the DO that will enforce it. The client can stop guessing.
    ...(ringDeadlineMs != null ? { ringDeadlineMs } : {}),
        // [CALL-WS-AUTH-1] Same credential as the FCM payload. The WS ring beats
        // FCM by seconds for an online callee, so it MUST carry it too — a fast
        // path that arrives without the join credential would answer a call the
        // client then cannot join once enforcement is on.
        roomToken: calleeRoomToken,
        trace_id: traceId, ts: Date.now(),
        // [CALL-IDENTITY-SNAPSHOT-1] The WS ring beats FCM by seconds for an
        // online callee, so it MUST carry the same identity fields — otherwise
        // the fast path paints a nameless, photoless screen and the slow path
        // "fixes" it a few seconds later, which looks like a flicker bug.
        ...(callerAvatarUrl ? { callerAvatarUrl } : {}),
        ...(callerAvatarVersion ? { callerAvatarVersion } : {}),
        identitySnapshotVersion,
        // [WP3] mirrors the Q_PUSH payload's via:'dialpad' marker above.
        ...(isDialpad ? { via: "dialpad" } : {}),
        ...messengerBillingRingFields,
      }),
    });
    const wj = (await wr.json().catch(() => ({}))) as { live?: number | boolean };
    // THE RING HAS LEFT. This is the number `call_ring_path_ms` exists to shrink.
    markRingStage("ws_ring");
    // [CALL-PRESENCE-1 2026-08-03] The InboxDO just told us whether the callee
    // holds a live WebSocket RIGHT NOW. That fact was computed on every call and
    // used only for this telemetry row; the caller was never told, so their app
    // narrated "Finding them on our network…" about someone demonstrably online.
    // Returned to the caller below. NOTE: presence is NOT evidence the phone is
    // ringing — see FAKE-RING-HONEST-1. It may suppress filler text; it may never
    // start a ringback or claim the ring.
    calleeLive = wj.live === true || (typeof wj.live === "number" && wj.live > 0);
    void env.Q_ANALYTICS.send({
      event: "call_ws_ring_sent", uid: ctx.uid, ts: Date.now(),
      props: {
        to: b.to, call_id: b.callId, ok: wr.ok, live: wj.live ?? null, trace_id: traceId,
        app_name: "avatok", service_name: "avatok-api", worker: true, account_id: ctx.uid,
      },
    });
    // [CALL-RING-DELIVERED-1] The InboxDO just confirmed the ring frame landed
    // on a LIVE websocket — that is NOT the same fact as "the phone is
    // ringing" (see FAKE-RING-HONEST-1: only the callee's own device-ringing
    // receipt may claim that). It IS enough to tell the caller's dial-stage
    // copy "delivered to their phone" a couple of seconds sooner than waiting
    // on FCM/device confirmation, without starting ringback or flipping phase.
    // Best-effort + fire-and-forget: a hiccup here must never affect the ring.
    if (calleeLive) {
      // Captured as a plain const: b.callId is validated truthy at the top of
      // this handler, but that narrowing does not survive into an async
      // closure (same reason deferredCallId/deferredTo exist further below).
      const ringDeliveredCallId = effectiveCallId();
      const ringDeliveredNotify = (async () => {
        try {
          const callStub = env.CALL_ROOMS.get(env.CALL_ROOMS.idFromName(ringDeliveredCallId));
          await callStub.fetch("https://call-room/control", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ type: "ring-delivered", callId: ringDeliveredCallId }),
          });
          void env.Q_ANALYTICS.send({
            event: "call_ring_delivered_live", uid: ctx.uid, ts: Date.now(),
            props: {
              to: b.to, call_id: b.callId, trace_id: traceId,
              app_name: "avatok", service_name: "avatok-api", worker: true, account_id: ctx.uid,
            },
          });
        } catch { /* best-effort — this is a copy hint, never authoritative */ }
      })();
      if (execCtx) execCtx.waitUntil(ringDeliveredNotify); else await ringDeliveredNotify;
    }
  } catch { /* best-effort — WS ring is an accelerator, FCM stays authoritative */ }
  // [CALL-RING-FIRST-3] FCM stays ALWAYS-SENT (belt and braces — the WS ring is
  // an accelerator, not a replacement), but when the callee already holds a
  // live socket (calleeLive) the phone is already ringing via the fast lane,
  // so the FCM enqueue no longer needs to sit in front of the response. When
  // the callee is NOT live, FCM is the only ring in flight and must stay
  // awaited exactly as before.
  // [CALL-RING-FASTPATH-1] IDENTITY REPAIR FOR THE SLOW LANE.
  //
  // The WS ring may have gone out carrying the client-supplied name, if a COLD
  // isolate's profile read blew IDENTITY_RING_BUDGET_MS (see the identity
  // snapshot section above). The FCM copy is no longer on the critical path, so
  // it always waits for the authoritative profile — which means a COLD phone,
  // the one that has nothing else to paint from, never shows a degraded card.
  // When `ident` already resolved (the overwhelmingly common case, and always
  // the case on a warm isolate) this awaits nothing.
  const fcmIdent: CallerIdentity = ident ?? await identityPromise;
  const fcmName = fcmIdent?.display_name || clientName || "AvaTOK";
  const fcmAvatarUrl = fcmIdent?.avatar_url ?? null;
  const fcmAvatarVersion = fcmIdent?.avatar_version ?? null;
  const fcmSnapshotVersion = fcmIdent?.profile_version ?? 0;
  const fcmNameSource = fcmIdent?.display_name ? "profile" : (clientName ? "client" : "fallback");
  const pushSend = env.Q_PUSH.send({
    kind: "call", to: b.to, from: ctx.uid, fromName: fcmName,
    callId: effectiveCallId(), callType: b.kind ?? "audio", traceId, ts: Date.now(),
    ringReceiptToken, nativeActionToken, tokenExpiresAt: expiresAt,
    // [CALL-CALLEE-SEQ-1] The ring push carried NO sequence, on an at-least-once
    // queue with max_retries:5 and no dedupe key — so a redelivered or reordered
    // ring was indistinguishable from a new one.
    ...(ringSeq != null ? { seq: ringSeq } : {}),
    // [CALL-ONE-DEADLINE-1] The absolute ms at which this ring expires, as
    // decided by the DO that will enforce it. The client can stop guessing.
    ...(ringDeadlineMs != null ? { ringDeadlineMs } : {}),
    // [CALL-WS-AUTH-1] The CALLEE's half of the room credential. It travels with
    // the ring because the callee has no other authenticated round-trip before it
    // needs to join — accepting a call goes straight to the WebSocket.
    roomToken: calleeRoomToken,
    // [CALL-IDENTITY-SNAPSHOT-1] Transport copy of the identity snapshot, so a
    // COLD phone can paint the caller's photo + real name on the first frame.
    // This is a copy, NOT an authority — if it ever disagrees with the call
    // state, the DO wins and the mismatch is a pipeline bug worth logging.
    ...(fcmAvatarUrl ? { callerAvatarUrl: fcmAvatarUrl } : {}),
    ...(fcmAvatarVersion ? { callerAvatarVersion: fcmAvatarVersion } : {}),
    identitySnapshotVersion: fcmSnapshotVersion,
    // [WP3] 'dialpad' marks this as a business-channel call so the callee's
    // incoming-call screen shows the named business UI (client already checks d['via']).
    ...(isDialpad ? { via: "dialpad" } : {}),
    ...messengerBillingRingFields,
  });
  // calleeLive: the ring already reached a live device over the fast lane, so
  // FCM enqueue can finish after the response (still always sent — belt and
  // braces for a socket that drops between the WS ring and the app opening
  // it). Not live: FCM is the ONLY ring in flight, so it must stay awaited —
  // byte-identical to prior behavior for a cold/offline callee.
  if (calleeLive && execCtx) execCtx.waitUntil(pushSend); else await pushSend;
  // Observability: which path produced the caller name (resolved server-side vs
  // the legacy client value vs the generic fallback), plus the call attempt — so
  // the "incoming call shows uid/uid" fix is measurable and call volume/route is
  // visible. Best-effort; telemetry must never block placing a call.
  // [CALL-RING-FASTPATH-1] The device count is finally needed here (and for
  // `sent:` in the response). The phone is already ringing, so this D1 read costs
  // the callee nothing — which is the whole point of having moved it.
  await resolveTokenCount();
  try {
    void env.Q_ANALYTICS.send({
      event: "call_push_sent", uid: ctx.uid, ts: Date.now(),
      props: {
        // stage:'enqueue' — the push was handed to Q_PUSH here; the true FCM
        // hand-off (fcm_message_id/ok/error) is emitted by the consumer with
        // stage:'fcm_send' (P1). Same event name, disambiguated by `stage`.
        stage: "enqueue",
        to: b.to, call_id: b.callId, call_type: b.kind ?? "audio", trace_id: traceId,
        name_source: fcmNameSource, devices: n,
        // [CALL-IDENTITY-SNAPSHOT-1] name_source=='profile' is the healthy state.
        // 'client' or 'fallback' at any volume means the profile lookup is
        // failing and callees are about to see uids or the wrong name again.
        // [CALL-RING-FASTPATH-1] `ring_name_source` is the same question asked of
        // the WS ring specifically: it differs from name_source ONLY when a cold
        // isolate's profile read blew the ring budget, which is the signal that
        // IDENTITY_RING_BUDGET_MS is set too low.
        ring_name_source: nameSource,
        has_avatar: !!fcmAvatarUrl,
        identity_snapshot_version: fcmSnapshotVersion,
        app_name: "avatok", service_name: "avatok-api", worker: true, account_id: ctx.uid,
      },
    });
  } catch { /* best-effort */ }
  // AI Ringback (Specs/proposals/PROPOSAL-AI-RINGBACK-TONES.md): hand the CALLER
  // the callee's CURRENT default ringtone so it plays locally during the ring
  // phase. Resolved at dial time so changing the default takes effect next call.
  // Best-effort — a lookup failure must never block placing the call.
  let ringbackUrl = "";
  try {
    const r = await env.DB_META
      .prepare("SELECT url FROM ringtones WHERE account_id=?1 AND is_default=1 LIMIT 1")
      .bind(b.to).first<{ url: string }>();
    ringbackUrl = r?.url ?? "";
  } catch { /* table missing / no default → caller uses the bundled fallback */ }
  // [MULTIACCT-1] `reachable:true` here means only "the callee had ≥1 registered
  // token at dial time" — the AUTHORITATIVE ring outcome is async and arrives via
  // the CallRoom ring-ack (the consumer emits ok=false + push_no_device when every
  // token turns out stale/pruned after a re-login). The client shows ringback on
  // this optimistic result but MUST fall back to "unreachable" when ring-ack ok=false.
  // [CALL-WS-AUTH-1] The CALLER's half of the room credential, handed back on the
  // authenticated response to their own dial. An older client simply ignores the
  // extra field; a newer one appends it as `?t=` when it opens the room socket.
  // [CALL-ONE-DEADLINE-1] The CALLER needs the deadline too — it is their
  // no-answer window that decides when the leg goes to Ava, and it was being
  // guessed locally as 22 s from the moment the client armed its timer, while
  // the server's clock started when the ring was PLACED. On failing calls the
  // gap between those two instants has been measured at 5–8 s.
  // [CALL-RING-FIRST-1 2026-08-03] Everything the ring did not have to wait for,
  // now that the phone is already ringing. Both were previously serial awaits in
  // front of the ring; both are consumed seconds later. `waitUntil` keeps them
  // running to completion after the response is sent — deferred, not dropped.
  // Captured before the closure: TypeScript's narrowing of `b.to`/`b.callId`
  // from the guard at the top of this function does not survive into an async
  // callback, and re-asserting inside it would be a lie about where the check
  // happened.
  const deferredTo = b.to;
  const deferredCallId = b.callId;
  const deferredKind = b.kind;
  const afterRing = (async () => {
    await runLiveTakeover();
    // [RECEPT-SERVER-TIMEOUT-1] The CallRoom owns the one four-ring deadline and
    // reads this verdict only when that deadline expires — 20 seconds from now.
    // Computing it cost a KV read, a settings load and a WalletDO round-trip, all
    // in front of the ring, to decide something nothing would ask about for
    // twenty seconds.
    try {
      const noAnswer = deferredKind === "video"
        ? { eligible: false, reason: "video" }
        : await receptionistNoAnswerEligibility(env, deferredTo);
      const stub = env.CALL_ROOMS.get(env.CALL_ROOMS.idFromName(deferredCallId));
      await stub.fetch("https://call-room/no-answer-policy", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          autoReceptionistEligible: noAnswer.eligible,
          noAnswerReason: noAnswer.reason,
        }),
      });
    } catch { /* the alarm falls back to eligible:false — a no-answer, not a wrong charge */ }
  })();
  if (execCtx) execCtx.waitUntil(afterRing); else await afterRing;
  // [CALL-PRESENCE-1] The routing decision, tagged to BOTH parties. Deferred —
  // the ring has already gone out and nothing below depends on it.
  if (presenceRouting) {
    const presenceTelemetry = emitPresenceDecision(
      presenceDecision,
      presenceDecision === "ring_offline_ineligible" ? "offline_ineligible"
        // [CALL-PRESENCE-2] The ring happened on missing information. Named so the
        // reason field alone identifies it without a second breakdown.
        : presenceDecision === "ring_unknown_read_failed" ? `presence_read_${presenceRead}`
        : null,
    );
    if (execCtx) execCtx.waitUntil(presenceTelemetry); else await presenceTelemetry;
  }
  // [CALL-RING-FASTPATH-1] Flush the ring-path stopwatch. Last thing before the
  // response, so `ws_ring` is included and the whole series lands together.
  markRingStage("response_ready");
  await settleRingPath();

  return json({
    sent: n, reachable: true, call_id: effectiveCallId(), ringbackUrl, roomToken: callerRoomToken,
    ...(ringDeadlineMs != null ? { ringDeadlineMs } : {}),
    // [CALL-PRESENCE-1] Is the callee holding a live WebSocket right now? The
    // caller's app uses this to stop inventing progress text about someone who
    // is demonstrably online. Presence only — never a claim that the phone rang.
    callee_live: calleeLive,
    // [CALL-PRESENCE-1 2026-08-07] The HEARTBEAT verdict, which is a different
    // and stronger fact than `callee_live` (that one is only ever true when the
    // WS ring happened to land). 'fresh' | 'stale' | 'unknown', plus the age so
    // the client can say something honest instead of inventing progress:
    //   fresh   → they're on AvaTOK right now
    //   stale   → their phone is being woken (FCM), which takes seconds
    //   unknown → say nothing; we genuinely do not know
    presence: presenceState,
    presence_age_ms: presenceAgeMs,
  });
}

export async function notify(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as { to?: string[]; fromName?: string; preview?: string; conv?: string };
  if (!Array.isArray(b.to) || !b.to.length) return json({ error: "to[] required" }, 400);
  // Optional short message PREVIEW so the recipient's banner is readable straight
  // from the shade (WhatsApp-style). The sender's client holds the plaintext and
  // chooses what to reveal; we collapse whitespace and cap length. Omitted → the
  // privacy-safe content-less banner (just the sender name).
  const preview = String(b.preview ?? "").replace(/\s+/g, " ").trim().slice(0, 140);
  // [PUSH-FG-BANNER-1 2026-07-14] Optional conversation key, forwarded to the
  // recipient's device so its FOREGROUND handler can suppress the banner for the
  // ONE thread they're actually reading — instead of suppressing every
  // foreground message, which is what silenced a phone with the screen off.
  //
  // Privacy note: `conv` is the sender-derived thread key the recipient's device
  // already knows ('1:<peerHex>' / 'g:<gid>'); it reveals nothing beyond who is
  // messaging whom, which the push already implies via `to` + `fromName`.
  // Capped defensively — it is echoed into an FCM data field.
  const conv = String(b.conv ?? "").trim().slice(0, 80);
  let queued = 0;
  for (const uid of b.to.slice(0, 64)) {
    await env.Q_PUSH.send({ kind: "notify", to: uid, fromName: (b.fromName || "AvaTOK").slice(0, 60), preview: preview || undefined, conv: conv || undefined, ts: Date.now() });
    queued++;
  }
  return json({ sent: queued });
}

/**
 * [CALL-NATIVE-DECLINE-1] Report an Android notification Decline when the app
 * process (and therefore Clerk + Dart) is absent.
 *
 * This route deliberately accepts no uid, recipient or status from the device.
 * The CallRoom validates the unguessable ring-lifetime capability, derives the
 * callee from its persisted participants, and applies the fixed `decline_call`
 * command through the one authoritative FSM. The route only handles delivery
 * of that already-authorized result to the caller.
 */
export async function callNativeDecline(req: Request, env: Env): Promise<Response> {
  const b = (await req.json().catch(() => ({}))) as { callId?: string; token?: string };
  const callId = String(b.callId ?? "").trim().slice(0, 128);
  const token = String(b.token ?? "").trim().slice(0, 128);
  if (!callId || !token) return json({ error: "callId and token required" }, 400);
  if (!env.CALL_ROOMS) return json({ error: "CALL_ROOMS binding missing" }, 500);

  let out: Record<string, unknown> | null = null;
  let status = 503;
  try {
    const stub = env.CALL_ROOMS.get(env.CALL_ROOMS.idFromName(callId));
    const response = await stub.fetch("https://call-room/control", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "native-decline", callId, token }),
    });
    status = response.status;
    out = await response.json().catch(() => null) as Record<string, unknown> | null;
  } catch {
    return json({ error: "call_authority_unavailable" }, 503);
  }
  if (status === 403) return json({ error: "invalid_or_expired_token" }, 403);
  if (!out) return json({ error: "call_authority_unavailable" }, 503);
  // A 409 means a race already ended or advanced the call. That is a successful
  // notification action from the user's perspective: never resurrect/overwrite
  // the authoritative outcome, and never invent a second decline delivery.
  if (status === 409) return json({ ok: true, already_terminal: true }, 200);
  if (status < 200 || status >= 300 || out.ok !== true) {
    return json({ error: "call_authority_unavailable" }, 503);
  }

  // Defense in depth for clients already in the field: a delayed native
  // ACTION_CALL_DECLINE must never overwrite a human accept, receptionist
  // handoff, or any other callee-leg winner. The FSM returns a successful
  // no-op for those races; stop here instead of manufacturing a decline push
  // from unchanged authoritative state.
  const declineNoop = out.changed !== true;
  if (declineNoop) {
    const ignoreReason = out.session_state === "connected" || out.callee_leg_state === "accepted"
      ? "callee_already_accepted"
      : "call_already_advanced";
    try {
      const participants = await readCallParticipants(env, callId);
      const [calleeEmail, callerEmail] = participants ? await Promise.all([
        emailFor(env, participants.calleeUid).catch(() => null),
        emailFor(env, participants.callerUid).catch(() => null),
      ]) : [null, null];
      const props = {
        call_id: callId,
        path: "android_killed_app_native",
        reason: ignoreReason,
        session_state: out.session_state ?? null,
        callee_leg_state: out.callee_leg_state ?? null,
        seq: out.seq ?? null,
      };
      if (participants?.calleeUid) {
        await trackUser(env, participants.calleeUid, calleeEmail,
          "call_native_decline_ignored", "avatok", props);
      }
      if (participants?.callerUid) {
        await trackUser(env, participants.callerUid, callerEmail,
          "call_native_decline_ignored", "avatok", props);
      }
    } catch { /* telemetry must never change the call outcome */ }
    return json({ ok: true, ignored: ignoreReason, seq: out.seq ?? null });
  }

  const recipient = typeof out.peer_uid === "string" ? out.peer_uid : "";
  if (!recipient) return json({ error: "call_authority_unavailable" }, 503);
  await env.Q_PUSH.send({
    kind: "call-status", to: recipient, callId, status: "decline", ts: Date.now(),
    ...(typeof out.seq === "number" ? { seq: out.seq } : {}),
  });

  // Rich evidence for the exact path that was invisible in the 2026-08-02
  // incident. Both identities are server-derived; the native request supplies
  // neither one and therefore cannot forge telemetry attribution.
  try {
    const participants = await readCallParticipants(env, callId);
    const callee = participants?.calleeUid ?? "";
    const [calleeEmail, callerEmail] = participants ? await Promise.all([
      emailFor(env, participants.calleeUid).catch(() => null),
      emailFor(env, participants.callerUid).catch(() => null),
    ]) : [null, null];
    const props = {
      call_id: callId,
      path: "android_killed_app_native",
      status: "decline",
      from_uid: callee,
      to_uid: recipient,
      from_email: calleeEmail,
      to_email: callerEmail,
      changed: out.changed === true,
      replayed: out.replayed === true,
      seq: out.seq ?? null,
      sockets_seen: out.sockets_seen ?? null,
      sockets_sent: out.sockets_sent ?? null,
      queued: true,
    };
    if (callee) await trackUser(env, callee, calleeEmail, "call_native_decline_relayed", "avatok", props);
    await trackUser(env, recipient, callerEmail, "call_native_decline_relayed", "avatok", props);
  } catch { /* telemetry must never change the call outcome */ }

  return json({ ok: true, seq: out.seq ?? null });
}

/** [CALL-SILENT-PREWARM-1] Callee transport-ready acknowledgement. The DO
 * validates membership plus the nonce/generation/device and stamps the single
 * server ring anchor; the client never supplies ring_started_at. */
export async function callPrewarmReady(req: Request, env: Env): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return json({ error: u.error }, u.status);
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const callId = String(b.callId ?? "").slice(0, 128);
  const nonce = String(b.nonce ?? "").slice(0, 128);
  const deviceId = String(b.deviceId ?? "").slice(0, 128);
  const generation = Number(b.generation);
  if (!callId || !nonce || !deviceId || !Number.isFinite(generation)) return json({ error: "callId, nonce, generation and deviceId required" }, 400);
  const stub = env.CALL_ROOMS.get(env.CALL_ROOMS.idFromName(callId));
  const r = await stub.fetch("https://call/prewarm-ready", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ callId, nonce, generation, deviceId, sessionId: b.sessionId, authenticatedUid: u.uid }),
  });
  return json(await r.json().catch(() => ({ ok: false, error: "call_authority_unavailable" })), r.status);
}

export async function callStatus(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as {
    to?: string; callId?: string; status?: string;
    // [BUSY-CARD-1] Optional busy metadata the busy CALLEE attaches to a 'busy'
    // status so the CALLER's device can render the personalized busy card. Purely
    // additive: absent → the caller shows the legacy "User is busy" line.
    busy_reason?: string; receptionist_enabled?: boolean | string | number; pronoun?: string;
    // [CALL-CMD-IDEMPOTENT-1 2026-08-01] Minted once per user action on the
    // device. A retry, an FCM action replay or a double-tap all carry the SAME
    // id, so the DO collapses them into one transition instead of each one
    // bumping the sequence and re-broadcasting. Optional: an older client that
    // omits it behaves exactly as before.
    commandId?: string;
  };
  if (!b.to || !b.callId || !b.status) return json({ error: "to, callId, status required" }, 400);
  let participants: CallParticipants | null;
  try { participants = await readCallParticipants(env, b.callId); } catch { participants = null; }
  const recipient = participants ? otherCallParticipant(participants, ctx.uid) : null;
  if (!participants || !recipient) return json({ error: "call_authority_unavailable" }, 503);
  // [AVACALL-RING-CANCEL-1] Persist a DURABLE terminal marker on the CallRoom DO
  // BEFORE the (eventually-consistent) FCM fan-out, so a callee who accepts around
  // the same instant — or whose ring push is still in flight — learns the caller
  // is gone from strongly-consistent DO state (GET /api/call-state) and never sits
  // on "connecting". The 2026-07-20 incident: the ring push reached the callee 2s
  // AFTER this cancel. Best-effort: a DO hiccup must never block the status relay.
  //
  // [CALL-TERMINAL-BCAST-1 2026-08-01] The DO is now also the FAST path, not just
  // a durable marker: /mark-terminal fans the status out over the peer's live
  // WebSocket. Prod incident avatok-f0c0ef5c — the callee declined and the caller
  // kept hearing ringback for 5.4s because the ONLY delivery path was
  // Q_PUSH -> 2s queue batch window -> serial consumer -> FCM. The caller was
  // attached to this exact DO the entire time.
  //
  // HANDOFF_CALL_STATUS are relayed with terminal:false — the callee is done, but
  // the CALLER's session must stay alive to hand the leg to Ava/the agent. If
  // these were marked terminal the receptionist handoff would be killed before it
  // started (see call_session.dart _handoffToAva).
  const TERMINAL_CALL_STATUS = new Set(["cancel", "bye", "hangup", "ended", "decline", "declined", "missed", "no-answer"]);
  // [CALL-VOICEMAIL-1] `decline_vm` joins the handoff set: the callee's ring is
  // over but the CALLER's leg must stay alive so they can record a voicemail.
  // Marking it terminal would tear their session down before the recorder opens.
  const HANDOFF_CALL_STATUS = new Set(["decline_ava", "decline_agent", "decline_vm"]);
  const isTerminal = TERMINAL_CALL_STATUS.has(b.status);
  const isHandoff = HANDOFF_CALL_STATUS.has(b.status);
  let doResult: Record<string, unknown> | null = null;
  if (isTerminal || isHandoff) {
    try {
      const stub = env.CALL_ROOMS.get(env.CALL_ROOMS.idFromName(b.callId));
      const r = await stub.fetch("https://call/mark-terminal", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status: b.status, callId: b.callId, terminal: isTerminal,
          authenticatedUid: ctx.uid,
          ...(b.commandId ? { commandId: String(b.commandId).slice(0, 64) } : {}),
        }),
      });
      doResult = (await r.json().catch(() => null)) as Record<string, unknown> | null;
      if (!r.ok) return json({ error: "call_authority_unavailable" }, r.status === 403 ? 403 : 503);
    } catch { return json({ error: "call_authority_unavailable" }, 503); }
  }
  // [CALL-STATUS-WSLANE-1 2026-08-14] FAST LANE FIRST, mirroring [WS-RING-1] /
  // [CALL-RING-FIRST-1]. The DO fan-out above only reaches peers attached to
  // the CallRoom socket — and a RINGING callee has never joined it (he joins on
  // accept), so a caller's cancel had NO live path to the one phone that most
  // needs it and rode FCM alone, which Android throttles after call bursts
  // (prod avatok-9f407abf: cancel at :21, callee rang until his window expired
  // at :31). Push the same status frame through the peer's live InboxDO WS —
  // the exact pipe the ring itself arrived on — carrying the DO's monotonic
  // seq so the client reducer collapses WS/FCM duplicates. Best-effort:
  // offline devices miss it and rely on FCM exactly as before.
  if (isTerminal || isHandoff) {
    try {
      const inboxStub = env.INBOX.get(env.INBOX.idFromName(recipient));
      await inboxStub.fetch("https://inbox/event", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "call_status", callId: b.callId, status: b.status, ts: Date.now(),
          ...(typeof doResult?.seq === "number" ? { seq: doResult.seq } : {}),
        }),
      });
    } catch { /* best-effort — FCM below stays authoritative */ }
  }
  const re = b.receptionist_enabled;
  // The FCM queue stays as the DURABLE backstop, always — the socket fan-out only
  // reaches peers that are currently attached, and a backgrounded/killed app is not.
  await env.Q_PUSH.send({
    kind: "call-status", to: recipient, callId: b.callId, status: b.status, ts: Date.now(),
    ...(b.busy_reason ? { busy_reason: String(b.busy_reason) } : {}),
    ...(re != null ? { receptionist_enabled: re === true || re === "1" || re === 1 } : {}),
    ...(b.pronoun ? { pronoun: String(b.pronoun) } : {}),
    // [CALL-REDUCER-1 2026-08-01] Carry the DO's monotonic transition sequence
    // onto the FCM backstop so BOTH paths describe the SAME transition with the
    // SAME number. The client reducer drops any seq it has already applied, so
    // whichever path arrives second is a harmless no-op instead of a second
    // teardown — and a late redelivery can never undo a newer transition.
    ...(typeof doResult?.seq === "number" ? { seq: doResult.seq } : {}),
  });
  // Telemetry: separate the four legs of delivery so a future regression is
  // diagnosable without guessing — DO persistence, socket fan-out, queue enqueue.
  // Tagged with BOTH parties (actor = whoever POSTed, to_uid = the peer) so either
  // tester's email retrieves the interaction. [CALL-TERMINAL-BCAST-1]
  if (isTerminal || isHandoff) {
    try {
      // Both parties' emails are attached so EITHER tester's email retrieves this
      // interaction — a call bug only makes sense from both ends (CLAUDE.md).
      const [actorEmail, peerEmail] = await Promise.all([
        emailFor(env, ctx.uid).catch(() => null),
        emailFor(env, recipient).catch(() => null),
      ]);
      const props = {
        call_id: b.callId,
        status: b.status,
        from_uid: ctx.uid,
        to_uid: recipient,
        from_email: actorEmail,
        to_email: peerEmail,
        terminal: isTerminal,
        handoff: isHandoff,
        do_ok: doResult != null,
        terminal_persisted: doResult?.terminal_persisted ?? null,
        already_terminal: doResult?.already_terminal ?? null,
        terminal_status: doResult?.terminal_status ?? null,
        sockets_seen: doResult?.sockets_seen ?? null,
        sockets_sent: doResult?.sockets_sent ?? null,
        queued: true,
      };
      await Promise.all([
        trackUser(env, ctx.uid, actorEmail, "call_status_relayed", "avatok", props),
        trackUser(env, recipient, peerEmail, "call_status_relayed", "avatok", props),
      ]);
    } catch { /* telemetry must never break signaling */ }
  }
  // NOTE: `sent: 1` means QUEUED, not "the caller processed it". The fields below
  // are attempt/result metrics, deliberately NOT a delivery guarantee.
  return json({
    sent: 1,
    queued: true,
    terminal_persisted: doResult?.terminal_persisted ?? false,
    already_terminal: doResult?.already_terminal ?? false,
    sockets_seen: doResult?.sockets_seen ?? 0,
    sockets_sent: doResult?.sockets_sent ?? 0,
  });
}

/**
 * [CALL-QUICK-REPLY-1 2026-08-01] POST /api/call/quick-reply
 *
 * The callee dismissed a ringing call with a canned reply ("Message" on the
 * incoming-call screen). The call itself is already being terminated via
 * /api/call-status; this delivers the courtesy text to the CALLER.
 *
 * THE SERVER OWNS THE TEXT. The client sends `quickReplyId` + `catalogVersion`,
 * never authoritative free text. If the client were trusted with the string, a
 * modified client could put arbitrary words into a message attributed to the
 * callee. Unknown ids are rejected; catalog version skew must be fixed by
 * deploying the catalog, never by accepting client-authored text.
 *
 * Delivery is deliberately decoupled from call termination — see
 * push_service.quickReplyIncomingCall. A messenger hiccup must not leave the
 * caller ringing.
 */
export async function callQuickReply(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as {
    to?: string; callId?: string; quickReplyId?: string;
    catalogVersion?: number; fallbackText?: string;
  };
  if (!b.to || !b.callId || !b.quickReplyId) {
    return json({ error: "to, callId, quickReplyId required" }, 400);
  }
  let participants: CallParticipants | null;
  try { participants = await readCallParticipants(env, b.callId); } catch { participants = null; }
  const callerUid = participants ? deriveQuickReplyRecipient(participants, ctx.uid) : null;
  if (!callerUid) return json({ error: "call_authority_unavailable" }, 503);
  const id = String(b.quickReplyId).slice(0, 40);
  const known = QUICK_REPLY_CATALOG_V1[id];
  if (!known) return json({ error: "unknown quickReplyId" }, 400);
  const text = known;

  // The callee is the SENDER of this message — they are replying to the caller.
  const identity = await publicIdentityFor(env, ctx.uid).catch(() => null);
  const senderName = identity?.display_name || "AvaTOK";
  const conv = `1:${ctx.uid}`;

  await env.Q_PUSH.send({
    kind: "notify",
    to: callerUid,
    fromName: senderName,
    from: ctx.uid,
    preview: text,
    conv,
    ts: Date.now(),
    data: {
      type: "quick_reply",
      caller_uid: ctx.uid,
      caller_name: senderName,
      call_id: b.callId,
    },
  });

  try {
    const [actorEmail, peerEmail] = await Promise.all([
      emailFor(env, ctx.uid).catch(() => null),
      emailFor(env, callerUid).catch(() => null),
    ]);
    const props = {
      call_id: b.callId, to_uid: callerUid, from_uid: ctx.uid,
      from_email: actorEmail, to_email: peerEmail,
      quick_reply_id: id,
      catalog_version: Number(b.catalogVersion ?? 1),
      // known=false means this Worker did not recognise the id and fell back to
      // client text — a version-skew signal worth alerting on.
      known_id: !!known,
      app_name: "avatok", service_name: "avatok-api", worker: true,
    };
    await Promise.all([
      trackUser(env, ctx.uid, actorEmail, "call_quick_reply_delivered", "avatok", props),
      trackUser(env, callerUid, peerEmail, "call_quick_reply_delivered", "avatok", props),
    ]);
  } catch { /* telemetry must never break delivery */ }

  return json({ ok: true, queued: true, text });
}

/**
 * [CALL-FSM-1 2026-08-01] POST /api/call/command — THE SINGLE COMMAND ENDPOINT.
 *
 * Every call outcome the client can cause goes through here: accept, decline,
 * quick reply, receptionist handoff, voicemail offer, spam report, block,
 * cancel. The Worker authenticates, decides whether the actor is the CALLER or
 * the CALLEE, and forwards to the CallRoom DO, which runs the pure state
 * machine in lib/call_state.ts.
 *
 * WHY ACTOR IS DERIVED SERVER-SIDE AND NEVER TRUSTED FROM THE BODY.
 * The whole authorization model rests on it: only a callee may decline, only a
 * caller may cancel or record a voicemail. If the client could name its own
 * role, a hostile or simply buggy build could accept a call on someone else's
 * behalf, or cancel a call it is not part of. The DO cross-checks with
 * `authorizeCommand`, so even an internal caller cannot bypass the rule.
 *
 * Response codes are meaningful:
 *   200 → the command applied
 *   409 → rejected as stale/illegal, WITH the current authoritative state so a
 *         losing device can reconcile ("answered on another device") instead of
 *         inventing an outcome. A race loser is a normal event, not an error.
 *   403 → the actor was not permitted to issue that command.
 */
export async function callCommand(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as {
    callId?: string; command?: string; peerUid?: string;
    commandId?: string; expectedEpoch?: number; data?: Record<string, unknown>;
    role?: string;
  };
  if (!b.callId || !b.command) return json({ error: "callId and command required" }, 400);
  if (b.command === "prewarm_ready") {
    const d = b.data ?? {};
    const stub = env.CALL_ROOMS.get(env.CALL_ROOMS.idFromName(b.callId));
    const r = await stub.fetch("https://call/prewarm-ready", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ callId: b.callId, nonce: d.nonce, generation: d.generation,
        deviceId: d.deviceId, sessionId: d.sessionId,
        mediaReadyRequired: d.mediaReadyRequired === true,
        authenticatedUid: ctx.uid }),
    });
    return json(await r.json().catch(() => ({ ok: false, error: "authority_unreachable" })), r.status);
  }

  // [CALL-AUTHZ-1 2026-08-01] The client-sent `role` is IGNORED.
  //
  // It used to be accepted as a "hint" that defaulted to callee, on the
  // reasoning that the capability table still gated each action. That reasoning
  // was wrong, and it was a live security hole: the capability table answers
  // "may a callee decline?" — it never answered "is this person the callee?".
  // Any authenticated user who learned a call id could send role:"callee" and
  // decline, block, report or accept a stranger's call.
  //
  // The DO now derives the side from the PERSISTED participants plus the
  // authenticated uid, and there is no longer any way to pass an actor through
  // this route at all — so even a bug here cannot reintroduce the hole.
  let out: Record<string, unknown> = {};
  let status = 200;
  try {
    const stub = env.CALL_ROOMS.get(env.CALL_ROOMS.idFromName(b.callId));
    const r = await stub.fetch("https://call/command", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        command: b.command, authenticatedUid: ctx.uid, callId: b.callId,
        commandId: b.commandId, expectedEpoch: b.expectedEpoch, data: b.data,
      }),
    });
    status = r.status;
    out = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  } catch (e) {
    try {
      await trackException(env, e, {
        route: "callCommand", uid: ctx.uid, app_name: "avatok",
        extra: { call_id: b.callId, command: b.command },
      });
    } catch { /* ignore */ }
    return json({ ok: false, error: "authority_unreachable" }, 503);
  }

  // Durable backstop. The DO broadcast only reaches sockets that are attached
  // right now; a backgrounded or killed peer is not. Only fan out on a real
  // state change, and only for outcomes the peer needs to see.
  //
  // [CALL-ACCEPT-STATUS-KILL-1 2026-08-09] "Outcomes the peer needs to see"
  // was not being enforced: this pushed EVERY changed command's wire status,
  // including `accept` after `accept_call`. On the caller's client the
  // call-status FCM lane funnels into CallSession's `_statusSub`, whose
  // catch-all ends a not-yet-connected session with whatever status arrived —
  // so when the FCM backstop beat WebRTC connect, the push that said "your
  // call was answered" KILLED the call at the moment of accept, the caller
  // auto-cancelled, and the callee's freshly-accepted call died (prod calls
  // avatok-b3e2da5c / the 2026-08-08 18:10 IST davy↔Tiger "ghost calling"
  // cascade: kill → instant redial → busy → retry storm). Shipped clients
  // cannot be patched, so the fix is HERE: only fan out statuses that are a
  // terminal outcome or a handoff — the two families the caller's reducer and
  // status listener are built to consume. `accept` needs no FCM: the accept
  // handshake proceeds over the CallRoom DO socket (SDP answer), which is the
  // only lane that can connect the call anyway.
  const backstopStatus = String(out.wire_status ?? out.callee_leg_state ?? out.disposition ?? "");
  const BACKSTOP_STATUSES = new Set([
    "cancel", "bye", "hangup", "ended", "decline", "declined", "missed",
    "no-answer", "busy", "decline_ava", "decline_agent", "decline_vm",
  ]);
  if (out.ok === true && out.changed === true && typeof out.peer_uid === "string" && out.peer_uid &&
      BACKSTOP_STATUSES.has(backstopStatus)) {
    // [CALL-STATUS-WSLANE-1 2026-08-14] FAST LANE FIRST — same asymmetry fix as
    // in callStatus above. `cancel_call` arrives HERE (client
    // _notifyCalleeCanceled → /api/call/command), and its only path to a
    // RINGING callee — who is not attached to the CallRoom socket until he
    // accepts — was the throttled FCM backstop below. Push the frame through
    // the peer's live InboxDO WS (the ring's own pipe), seq-tagged so the
    // client reducer dedupes against the FCM copy.
    try {
      const inboxStub = env.INBOX.get(env.INBOX.idFromName(out.peer_uid));
      await inboxStub.fetch("https://inbox/event", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "call_status", callId: b.callId, status: backstopStatus, ts: Date.now(),
          ...(typeof out.seq === "number" ? { seq: out.seq } : {}),
        }),
      });
    } catch { /* best-effort — FCM below stays authoritative */ }
    try {
      await env.Q_PUSH.send({
        kind: "call-status", to: out.peer_uid, callId: b.callId,
        status: backstopStatus,
        ts: Date.now(),
        ...(typeof out.seq === "number" ? { seq: out.seq } : {}),
      });
    } catch { /* the socket path already delivered; the push is the backstop */ }
  }

  // [CALL-SILENT-PREWARM-1] First answer wins across every handset logged in
  // as the callee. `accept` must never be sent to the caller (see the guard
  // above), but the callee's OTHER devices do need an authoritative teardown.
  // Address this status back to the authenticated actor and tag the winning
  // device so that handset can ignore its own cleanup frame.
  if (b.command === "accept_call" && out.ok === true && out.changed === true &&
      out.replayed !== true && out.actor === "callee") {
    const rawWinner = b.data?.winnerDeviceId;
    const winnerDeviceId = typeof rawWinner === "string" ? rawWinner.trim().slice(0, 128) : "";
    if (winnerDeviceId) try {
      const inboxStub = env.INBOX.get(env.INBOX.idFromName(ctx.uid));
      await inboxStub.fetch("https://inbox/event", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "call_status", callId: b.callId, status: "answered_elsewhere",
          winner_device_id: winnerDeviceId, ts: Date.now(),
          ...(typeof out.seq === "number" ? { seq: out.seq } : {}),
        }),
      });
    } catch { /* best-effort fast lane; the durable push remains */ }
    if (winnerDeviceId) try {
      await env.Q_PUSH.send({
        kind: "call-status", to: ctx.uid, callId: b.callId,
        status: "answered_elsewhere", winner_device_id: winnerDeviceId,
        ts: Date.now(),
        ...(typeof out.seq === "number" ? { seq: out.seq } : {}),
      });
    } catch { /* the live self-lane already delivered where available */ }
  }

  try {
    const [actorEmail, peerEmail] = await Promise.all([
      emailFor(env, ctx.uid).catch(() => null),
      typeof out.peer_uid === "string" ? emailFor(env, out.peer_uid).catch(() => null) : Promise.resolve(null),
    ]);
    await trackUser(env, ctx.uid, actorEmail, "call_command", "avatok", {
      call_id: b.callId, command: b.command,
      // Server-derived, not claimed. `not_a_participant` in rejected_reason is
      // a security signal, not a UX one — it means someone tried to act on a
      // call they are not on. Any volume of it deserves investigation.
      actor: out.actor ?? null,
      from_uid: ctx.uid, to_uid: out.peer_uid ?? null,
      from_email: actorEmail, to_email: peerEmail,
      ok: out.ok === true, changed: out.changed === true,
      // `rejected` with a reason is the signal that a race actually happened —
      // it should be rare, and a spike means the epoch/CAS model is wrong.
      rejected_reason: out.ok === false ? out.error ?? null : null,
      replayed: out.replayed === true,
      disposition: out.disposition ?? null,
      seq: out.seq ?? null,
      // A successful send() is not a delivery acknowledgement, but exposing
      // these legs lets PostHog distinguish a detached caller (0 sockets) from
      // a ghost/stale socket that accepted send() yet never applied the frame.
      sockets_seen: out.sockets_seen ?? null,
      sockets_sent: out.sockets_sent ?? null,
      app_name: "avatok", service_name: "avatok-api", worker: true,
    });
  } catch { /* telemetry must never change an outcome */ }

  return json(out, status);
}

/**
 * [CALL-SPAM-REPORT-1 2026-08-01] POST /api/calls/report
 *
 * The callee reported an incoming CALLER as spam. Phase 2 of
 * Specs/CALL-OUTCOMES-FROZEN-2026-08-01.md.
 *
 * WHY A NEW ROUTE rather than reusing an existing one. Neither existing spam
 * surface fits an AvaTOK-to-AvaTOK caller:
 *   - /api/spam/report is E.164-keyed (normalizePhone + hash, rejects <6
 *     digits) — an AvaTOK caller is a uid, not a number — and 403s while the
 *     `spamShield` flag is off.
 *   - /api/safety/report is conv-keyed, requires message envelopes out of the
 *     reporter's InboxDO, and ALWAYS blocks the sender.
 *
 * REPORT AND BLOCK ARE DIFFERENT ACTIONS. This route does not block by default.
 * A user may want to flag a suspicious caller while still allowing future calls
 * through to screening, and silently blocking on report would be a surprise the
 * UI never promised. The client asks separately and sets `alsoBlock`.
 *
 * Idempotent per (reporter, call) via a UNIQUE index — a double-tap or a
 * replayed FCM action must not inflate a caller's report count, which would be
 * trivially weaponisable.
 */
export async function callReportSpam(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as {
    reportedUid?: string; callId?: string; category?: string;
    callStartedAt?: number; ringDurationMs?: number;
    contactsMatch?: boolean; priorRelationship?: string;
    alsoBlock?: boolean; deviceId?: string;
  };
  if (!b.reportedUid || !b.callId) {
    return json({ error: "reportedUid and callId required" }, 400);
  }
  if (b.reportedUid === ctx.uid) return json({ error: "cannot report yourself" }, 400);

  const ALLOWED = new Set(["spam", "scam", "harassment", "other"]);
  const category = ALLOWED.has(String(b.category)) ? String(b.category) : "spam";
  const now = Date.now();
  // Snapshot what the reporter actually SAW, so a later profile rename by the
  // reported caller cannot rewrite the evidence.
  const seen = await publicIdentityFor(env, b.reportedUid).catch(() => null);

  // ── [CALL-ATOMIC-1 2026-08-03] COMMIT THE CALL DISPOSITION FIRST ──────────
  //
  // `report_spam` and `block_caller` were DEFINED in call_state.ts, reduced,
  // and authorized to the callee — and issued by nobody. This route wrote D1
  // and never told the CallRoom anything, which had three consequences:
  //
  //   * Reporting spam mid-ring did not end the call. The client sent a
  //     separate `decline` first, so the outcome depended on which of the two
  //     landed — and if the decline lost a race to an accept, the report and
  //     the block landed anyway while the two parties were still talking.
  //   * The report had NO participant check against the call record. Only
  //     `reportedUid !== ctx.uid` was enforced, so anyone holding a call id
  //     could file a report against a call they were not on.
  //   * `reported_spam` / `blocked_by_callee` were unreachable dispositions.
  //
  // The FSM decides the CALL; D1 records the EVIDENCE. Ordering matters: the
  // disposition is committed before the evidence so a report can never end up
  // attached to a call that is simultaneously being answered.
  //
  // Only one terminal transition can win, so an explicit block — the stronger
  // statement, and the one with an ongoing consequence — takes precedence over
  // the report when the user asked for both.
  //
  // DELIBERATELY NON-FATAL. Reports are also filed from call history, minutes
  // or days later, where the aggregate is legitimately `already_terminal`, and
  // for calls that predate the FSM it is `not_a_participant` because the DO has
  // no participant record at all. Refusing those would delete a safety feature
  // to satisfy a state machine. The rejection is recorded, not enforced.
  let callDisposition: string | null = null;
  let fsmRejected: string | null = null;
  try {
    const stub = env.CALL_ROOMS.get(env.CALL_ROOMS.idFromName(b.callId));
    const r = await stub.fetch("https://call/command", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        command: b.alsoBlock === true ? "block_caller" : "report_spam",
        callId: b.callId,
        authenticatedUid: ctx.uid,
        // Keyed by call + action so a double-tap, a retry, or an FCM action
        // replay collapse into one transition instead of each re-broadcasting.
        commandId: `spam:${b.callId}:${b.alsoBlock === true ? "block" : "report"}`,
      }),
    });
    const out = (await r.json().catch(() => null)) as Record<string, unknown> | null;
    if (out?.ok === false) fsmRejected = String(out.error ?? "rejected");
    else if (typeof out?.disposition === "string") callDisposition = out.disposition;
  } catch (e) {
    fsmRejected = "call_authority_unavailable";
    try {
      await trackException(env, e, {
        route: "callReportSpam.fsm", uid: ctx.uid, app_name: "avatok",
        extra: { call_id: b.callId },
      });
    } catch { /* ignore */ }
  }

  let stored = false;
  try {
    const r = await env.DB_META.prepare(
      `INSERT OR IGNORE INTO call_spam_reports
       (id, reporter_uid, reported_uid, call_id, report_category, call_started_at,
        report_created_at, ring_duration_ms, identity_snapshot_version,
        reported_display_name, prior_relationship, contacts_match, also_blocked,
        client_device_id)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)`,
    ).bind(
      crypto.randomUUID(), ctx.uid, b.reportedUid, b.callId, category,
      b.callStartedAt ?? null, now, b.ringDurationMs ?? null,
      seen?.profile_version ?? null, seen?.display_name ?? null,
      String(b.priorRelationship ?? "none").slice(0, 24),
      b.contactsMatch === true ? 1 : 0,
      b.alsoBlock === true ? 1 : 0,
      String(b.deviceId ?? "").slice(0, 64) || null,
    ).run();
    stored = (r.meta?.changes ?? 0) > 0;
  } catch (e) {
    // A missing table (migration not yet applied) must not make the UI look
    // broken — the user's intent is recorded in telemetry either way.
    try {
      await trackException(env, e, {
        route: "callReportSpam", uid: ctx.uid, app_name: "avatok",
        extra: { call_id: b.callId },
      });
    } catch { /* ignore */ }
  }

  // Blocking is a SEPARATE, explicit choice — never implied by reporting.
  let blocked = false;
  if (b.alsoBlock === true) {
    try {
      await env.DB_META.prepare(
        "INSERT OR IGNORE INTO blocks (uid, blocked_uid, created_at) VALUES (?1,?2,?3)",
      ).bind(ctx.uid, b.reportedUid, now).run();
      blocked = true;
    } catch { /* reported successfully; the block can be retried by the user */ }
  }

  try {
    const [reporterEmail, reportedEmail] = await Promise.all([
      emailFor(env, ctx.uid).catch(() => null),
      emailFor(env, b.reportedUid).catch(() => null),
    ]);
    await trackUser(env, ctx.uid, reporterEmail, "call_spam_reported", "avatok", {
      call_id: b.callId, reported_uid: b.reportedUid, reporter_uid: ctx.uid,
      reported_email: reportedEmail, category,
      // stored=false with no exception means the UNIQUE index rejected a
      // duplicate — i.e. a double-tap or a replayed action, not a failure.
      stored, also_blocked: blocked,
      ring_duration_ms: b.ringDurationMs ?? null,
      contacts_match: b.contactsMatch === true,
      // [CALL-ATOMIC-1] Did the report also END the call, or was it filed
      // against a call that had already finished? `fsm_rejected` distinguishes
      // a history report (already_terminal) from a genuine authority failure.
      call_disposition: callDisposition,
      fsm_rejected: fsmRejected,
      app_name: "avatok", service_name: "avatok-api", worker: true,
    });
  } catch { /* telemetry must never fail a report */ }

  return json({ ok: true, stored, blocked, call_disposition: callDisposition });
}

// [AVACALL-RING-CANCEL-1] GET /api/call-state?callId=<id> — thin authed proxy to
// the CallRoom DO's strongly-consistent state (answered / ended / terminal_status
// / live peer count). The callee's accept path reads this to honor a cancel that
// arrived before/around the accept (client [AVACALL-CANCEL-1]). The DO's own GET
// /state is internal-only (never client-exposed); this is the sanctioned public
// read. FAIL-OPEN: any DO hiccup returns a benign "unknown" 200 so the client
// simply proceeds as before rather than blocking a legitimate call.
export async function callState(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const url = new URL(req.url);
  const callId = (url.searchParams.get("callId") || "").slice(0, 64);
  if (!callId) return json({ error: "callId required" }, 400);
  try {
    const stub = env.CALL_ROOMS.get(env.CALL_ROOMS.idFromName(callId));
    const r = await stub.fetch("https://call/state", { method: "GET" });
    if (!r.ok) return json({ ok: false, terminal_status: null });
    const j = (await r.json()) as Record<string, unknown>;
    // This proxy is intentionally participant-scoped.  The CallRoom's internal
    // /state endpoint is reachable only from this Worker, but this public route
    // must not let an authenticated third party probe arbitrary call ids.
    const callerUid = typeof j.caller_uid === "string" ? j.caller_uid : "";
    const calleeUid = typeof j.callee_uid === "string" ? j.callee_uid : "";
    if (!callerUid || !calleeUid || (ctx.uid !== callerUid && ctx.uid !== calleeUid)) {
      return json({ error: "not_a_call_participant" }, 403);
    }
    const sessionState = typeof j.session_state === "string" ? j.session_state : "";
    const wireStatus = typeof j.wire_status === "string" ? j.wire_status : "";
    const calleeHandoff = sessionState === "handoff" && j.callee_uid === ctx.uid;
    const callerHandoff = sessionState === "handoff" && j.caller_uid === ctx.uid;
    // A handoff is intentionally non-terminal for the CALLER, who is speaking
    // with Ava. It IS terminal for the CALLEE's ring. Returning a callee-only
    // synthetic terminal status lets already-shipped clients' durable poll close
    // their incoming screen even when FCM cancellation was missed.
    const terminalStatus = (j.terminal_status as string | null) ??
      (calleeHandoff ? (wireStatus || "decline_ava") : null);
    return json({
      ok: true,
      answered: j.answered === true,
      ended: j.ended === true,
      terminal_status: terminalStatus,
      session_state: sessionState || null,
      // The caller normally learns this over the room socket. Exposing the
      // same participant-scoped status here gives the app a strongly-consistent
      // recovery path when Android has left a ghost socket registered and FCM
      // is delayed. It contains no identity data and is visible only to one of
      // the two persisted participants.
      ring_status: (calleeHandoff || callerHandoff)
        ? (wireStatus || "decline_ava")
        : null,
      peers: typeof j.peers === "number" ? j.peers : null,
    });
  } catch {
    return json({ ok: false, terminal_status: null }); // fail-open
  }
}

// [BUSY-CARD-1] "Notify me" — register the caller as a bounded/deduped waiter on
// the busy callee's CallStateAuthorityDO, to be pinged with a "now free" FCM when
// the callee returns to idle. Fail-open: if the authority is unreachable the
// helper returns null and we report a soft rejection (the client confirms locally).
export async function callNotifyRegister(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as { callee_uid?: string; caller_uid?: string; generation?: number };
  const callee = String(b.callee_uid ?? "");
  const caller = String(b.caller_uid ?? ctx.uid ?? "");
  if (!callee || !caller) return json({ error: "callee_uid and caller_uid required" }, 400);
  const res = await authorityNotifyRegister(env, callee, {
    caller_uid: caller,
    generation: typeof b.generation === "number" ? b.generation : undefined,
  });
  return json(res ?? { ok: false, rejected: true, reason: "unavailable" });
}

// ---- directory: /api/profile (auth) /api/resolve /api/search /api/handle/check (public) ----

// Handle = 3–20 chars, lowercase letters/digits/underscore, starts with a letter.
const HANDLE_RE = /^[a-z][a-z0-9_]{2,19}$/;
export function normalizeHandle(h: string): string {
  return (h || "").trim().toLowerCase().replace(/^@/, "");
}

// GET /api/handle/check — DEPRECATED. Handles are retired site-wide
// (Specs/AVATOK-NUMBER-FEATURE-SPEC.md). The network identity is the AvaTOK number;
// search is by number / phone (if public) / email. Kept so old clients get a clear
// signal instead of a 404.
export async function handleCheck(_req: Request, _env: Env): Promise<Response> {
  return json({ deprecated: true, valid: false, available: false, reason: "Handles are retired. Use your AvaTOK number, phone, or email." }, 410);
}

// P11: real-name plausibility via gemini-2.5-flash-lite. Returns {plausible,reason}.
// `ok:false` = the model call itself failed → the caller FAILS CLOSED (a bad public
// profile must not pass just because a model was down). Encodes the policy with
// few-shot examples: fragments/invented/object-innuendo names are implausible;
// legitimately short real names (Al, Bo, Li, Ng, Wu) pass. min length 2.
// Parse the model's JSON verdict → {plausible, reason}; null if unparseable.
function parseNameVerdict(txt: string): { plausible: boolean; reason: string } | null {
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]) as { plausible?: boolean; reason?: string };
    const plausible = parsed.plausible === true;
    return { plausible, reason: plausible ? "" : (parsed.reason || "Please use your real name — it helps people trust who they're talking to.") };
  } catch { return null; }
}

// [VERTEX-1] Was a raw generativelanguage.googleapis.com fetch keyed by x-goog-api-key;
// now routed through generateContentVia. `opts.apiKey`, when passed, pins the
// Developer API (used for the RECEPTIONIST_GEMINI_API_KEY branch below so that
// spend stays separable) — otherwise Vertex is tried first with an automatic
// fallback to env.GEMINI_API_KEY. null on ANY failure.
async function geminiDirectVet(env: Env, prompt: string, opts?: { apiKey?: string }): Promise<{ plausible: boolean; reason: string } | null> {
  try {
    const r = await generateContentVia(
      env as any, "gemini-2.5-flash-lite",
      { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0, maxOutputTokens: 80 } },
      "generateContent", opts,
    );
    if (!r.ok) return null;
    return parseNameVerdict(String(r.out?.candidates?.[0]?.content?.parts?.[0]?.text ?? ""));
  } catch { return null; }
}

// OpenRouter (Gemini model) fallback — same key/endpoint the guardian + CF
// receptionist use. null on ANY failure.
//
// One Brain B1 (SPEC §4): routed through the shared avaReason gateway. Model still
// pinned via `legacyModel` (single OpenRouter call, no reasoner-ladder fallback),
// temperature 0, max_tokens 80, same OPENROUTER_NAME_MODEL override → gemini-2.0.
// NEW: an abort timeout (this vet runs in the registration path and previously had
// NONE — a hung OpenRouter socket could stall a signup indefinitely). The gateway
// also adds ava_reason_call telemetry. The null-on-any-failure contract is kept at
// the call site so vetRealName still fails OPEN when every provider is unreachable.
async function openrouterVet(env: Env, prompt: string): Promise<{ plausible: boolean; reason: string } | null> {
  const key = (env as any).OPENROUTER_API_KEY as string | undefined;
  if (!key) return null;
  const model = (env as any).OPENROUTER_NAME_MODEL || "google/gemini-2.0-flash-001";
  try {
    const text = await avaReason(env, {
      role: "profile", capability: "name_vet", trigger: "profile_upsert",
      feature: "name_vet", legacyModel: model,
      user: prompt, temperature: 0, maxTokens: 80, timeoutMs: 15000,
    });
    return parseNameVerdict(String(text ?? ""));
  } catch { return null; }
}

async function vetRealName(env: Env, first: string, last: string): Promise<{ ok: boolean; plausible: boolean; reason: string; unavailable?: boolean }> {
  const full = `${first} ${last}`.trim();
  if (!full) return { ok: true, plausible: false, reason: "Please enter your first and last name." };
  const prompt =
    "You judge whether a submitted first+last name is a plausible REAL human name for a social app. " +
    "Real names from many cultures can be 2 letters (Al, Bo, Li, Ng, Wu) — judge INTENT, not raw length; min length 2. " +
    "Examples: \"Sat\" -> implausible (fragment). \"Satish\" -> plausible. \"Satisy\" -> implausible (misspelled/invented). " +
    "\"Midnight Rod\", \"Black Stick\" -> implausible (object/innuendo, not a human name). \"Al Wu\" -> plausible. " +
    `Name: "${full}". Respond with ONLY JSON: {"plausible": <true|false>, "reason": "<short kind sentence, only when implausible>"}.`;
  // Provider chain: primary Gemini key → the RECEPTIONIST's Gemini key (the one
  // Gemini Live uses) → OpenRouter (Gemini). First provider that answers wins.
  // FAIL OPEN only if EVERY provider is unreachable — never block a real user on an
  // AI outage / depleted key; `unavailable:true` still logs profile_vet_error.
  // [VERTEX-1] Primary key: no apiKey pin, so geminiDirectVet tries Vertex first
  // and falls back to env.GEMINI_API_KEY internally. Receptionist key: pinned to
  // the Developer API so its spend stays separable (RECEPTIONIST_GEMINI_API_KEY rule).
  const primaryKey = (env as any).GEMINI_API_KEY as string | undefined;
  const receptionistKey = (env as any).RECEPTIONIST_GEMINI_API_KEY as string | undefined;
  if (primaryKey) {
    const out = await geminiDirectVet(env, prompt);
    if (out) return { ok: true, plausible: out.plausible, reason: out.reason };
  }
  if (receptionistKey && receptionistKey !== primaryKey) {
    const out = await geminiDirectVet(env, prompt, { apiKey: receptionistKey });
    if (out) return { ok: true, plausible: out.plausible, reason: out.reason };
  }
  const orOut = await openrouterVet(env, prompt);
  if (orOut) return { ok: true, plausible: orOut.plausible, reason: orOut.reason };
  return { ok: true, plausible: true, reason: "", unavailable: true }; // all providers down → fail open
}

export async function profileUpsert(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as {
    name?: string; first_name?: string; last_name?: string; email?: string; phone?: string;
    account_kind?: string; avatar_url?: string; birth_year?: number; bio?: string; gender?: string;
  };
  // Optional self-description — AvaBrain learns from it. Capped + trimmed; an
  // explicit empty string clears it, undefined leaves it unchanged.
  const bio = b.bio === undefined ? null : String(b.bio).trim().slice(0, 600);
  // Gender (profile) — drives the receptionist's pronouns ("a message for him/her/
  // them"). Allow-list only; undefined leaves it unchanged.
  const gender = b.gender === undefined ? null
    : (["male", "female", "other"].includes(String(b.gender)) ? String(b.gender) : null);
  // Optional birth year — powers coarse age-group analytics only (13+); never shown publicly.
  let birthYear: number | null = null;
  if (b.birth_year !== undefined && b.birth_year !== null && b.birth_year !== 0) {
    const y = Math.trunc(Number(b.birth_year));
    if (!(y >= 1900 && y <= new Date().getFullYear() - 13)) return json({ error: "invalid_birth_year" }, 400);
    birthYear = y;
  }
  // Handles are retired site-wide — names power the directory + contact card.
  const firstName = b.first_name === undefined ? null : (String(b.first_name).trim().slice(0, 60) || null);
  const lastName = b.last_name === undefined ? null : (String(b.last_name).trim().slice(0, 60) || null);
  const assembled = [firstName, lastName].filter(Boolean).join(" ").trim();
  let name = ((b.name || "").trim() || assembled) || null;
  const avatarUrl = typeof b.avatar_url === "string" ? b.avatar_url.trim() : null;
  const email = (b.email || "").trim().toLowerCase();
  const emailHash = email ? await sha256Hex(email) : null;
  const phoneHash = b.phone ? await sha256Hex(normalizePhone(b.phone)) : null;
  const now = Date.now();
  const db = metaSession(env);
  // Save-time content validation (Nemotron): block an abusive name/bio before it's
  // persisted and shown in the directory.
  // [PROFILE-MOD-FIELDS-1] (2026-08-17) first/last used to be passed as the field
  // names "first_name"/"last_name", which are NOT members of ModField. policyFor()
  // has no case for them, so they fell through to `default` and were judged by the
  // GENERIC policy — losing the name-specific rules (profanity, political slogans,
  // and impersonation of staff/official roles like "admin"/"support"/"moderator").
  // The two `@ts-expect-error`s above them said the quiet part out loud: the
  // compiler knew these were not valid fields and the errors were suppressed.
  // They are "name" now, so all three name inputs get the strict name policy.
  // This can only ever REJECT more, never less, which is the safe direction for a
  // moderation change. The `name` entry stays because it is first+last combined and
  // catches an abusive phrase that is split innocuously across the two boxes.
  const blocked = await guardWrite(req, env, ctx.uid, "profile", [
    { text: name, field: "name" },
    { text: firstName, field: "name" },
    { text: lastName, field: "name" },
    { text: bio, field: "bio" },
  ]);
  if (blocked) return blocked;

  // P11: mandatory + AI-vetted profile (behind profileCompletionGate; dark until
  // launch). Runs while the client shows a hold state. Completeness THEN real-name
  // plausibility. Phone is the ONLY optional field. FAIL CLOSED on model outage.
  // [PROFILE-HARD-GATE-1] null when the gate did not run (gate off) — in that
  // case the upsert leaves profile_vetted_at exactly as it was, so turning the
  // gate off never silently un-approves anyone.
  let vetVerdict: "passed" | null = null;
  let gateOn = false;
  try { gateOn = (await readConfig(env)).profileCompletionGate === true; } catch { gateOn = false; }
  if (gateOn) {
    track(env, ctx.uid, "profile_vet_started", "profile", {});
    // [ISSUE-PROFILE-GATE-1] (2026-07-15) Judge completeness on the RESULTING
    // profile, NOT on this request body.
    //
    // Every field parsed above is `null` when its key is simply ABSENT from the
    // request — these are PATCH semantics, and the upsert below COALESCEs each
    // value onto the stored row. The gate used to test those same locals, so a
    // PARTIAL publish (the launch publish sends only name/email/phone) reported
    // all six fields missing and 400'd — even when the stored profile was
    // complete. Telemetry 2026-07-12..15: every profile_publish_rejected on prod
    // carried missing=[photo,first_name,last_name,birth_year,gender,about], for
    // three testers who all have complete rows in D1. The gate was reading the
    // envelope, not the letter. Merge first, then judge.
    const prevRow = await db.prepare(
      "SELECT avatar_url, first_name, last_name, birth_year, gender, bio, profile_vetted_at, profile_vetted_reason FROM users WHERE uid=?1",
    ).bind(ctx.uid).first<{
      avatar_url: string | null; first_name: string | null; last_name: string | null;
      birth_year: number | null; gender: string | null; bio: string | null;
      profile_vetted_at: number | null;
      profile_vetted_reason: string | null;
    }>().catch(() => null);
    // Effective value = this request's value when the key was PROVIDED, else the
    // stored one. `??` (not `||`) is deliberate: an explicit "" clears a field and
    // must stay falsy here, exactly as COALESCE would persist it below.
    const effAvatar = avatarUrl ?? prevRow?.avatar_url ?? null;
    const effFirst = firstName ?? prevRow?.first_name ?? null;
    const effLast = lastName ?? prevRow?.last_name ?? null;
    const effBirth = birthYear ?? prevRow?.birth_year ?? null;
    const effGender = gender ?? prevRow?.gender ?? null;
    const effBio = bio ?? prevRow?.bio ?? null;
    // Completeness: photo, first, last, birth year, gender, About all required.
    const missing: string[] = [];
    if (!effAvatar) missing.push("photo");
    if (!effFirst) missing.push("first_name");
    if (!effLast) missing.push("last_name");
    if (!effBirth) missing.push("birth_year");
    if (!effGender) missing.push("gender");
    if (!effBio) missing.push("about");
    if (missing.length) {
      track(env, ctx.uid, "profile_vet_rejected", "profile", {
        reason_class: "incomplete", field: missing[0], missing_count: missing.length,
        // Distinguishes a genuinely new/blank account from a partial patch onto a
        // stored profile — the two were indistinguishable in the old telemetry.
        had_stored_profile: prevRow ? 1 : 0,
      });
      return json({ error: "profile_incomplete", missing, message: "Please complete every field (only your phone number is optional)." }, 400);
    }
    // Fail closed for NEW/CHANGED profiles when the safety classifier cannot
    // answer. Already-approved, unchanged profiles never enter this path on app
    // launch, so a provider outage cannot lock the whole existing user base.
    const fullEffectiveName = `${effFirst} ${effLast}`.trim();
    if (!namePlausible(fullEffectiveName)) {
      track(env, ctx.uid, "profile_vet_rejected", "profile", { reason_class: "name_format", field: "first_name" });
      return json({ error: "implausible_name", field: "first_name", message: "That doesn't look like a real name. Please use your real first and last name." }, 400);
    }
    // The public/display name is derived from the vetted first + last fields.
    // A client cannot submit clean component fields alongside a separate funny
    // display string and have that unreviewed alias appear across the app.
    name = fullEffectiveName;
    const safetyFields = [
      { text: fullEffectiveName, field: "name" as const },
      { text: effFirst!, field: "name" as const },
      { text: effLast!, field: "name" as const },
      { text: effBio!, field: "bio" as const },
    ];
    for (const candidate of safetyFields) {
      const verdict = await moderate(env, candidate);
      if (!verdict.ok) {
        await track(env, ctx.uid, "profile_vet_error", "profile", { stage: "content_model", field: candidate.field }).catch(() => {});
        return json({ error: "profile_vet_unavailable", field: candidate.field, message: "Ava couldn't verify this profile right now. Nothing was saved — please try again shortly." }, 503);
      }
      if (!verdict.safe) {
        track(env, ctx.uid, "profile_vet_rejected", "profile", { reason_class: "content", field: candidate.field, categories: verdict.categories });
        return json({ error: "profile_vet_rejected", field: candidate.field, message: verdict.reason }, 422);
      }
    }
    // Real-name plausibility (gemini-2.5-flash-lite). The model helper reports
    // provider exhaustion explicitly; this hard gate fails closed so an
    // unverified profile is never persisted.
    //
    // Only vet a name that actually CHANGED. Vetting every publish would fire a
    // Gemini call on every app launch (the launch publish re-sends the profile),
    // and the old `vetRealName(firstName!, lastName!)` passed this request's nulls
    // straight through — vetting the literal string "null null" and rejecting a
    // perfectly good stored profile the moment the gate stopped short-circuiting.
    // `vetted_v2` forces one strict re-check for approvals created by the older
    // save path, which could stamp an existing unreviewed name as approved.
    const needsStrictRevet = prevRow?.profile_vetted_reason !== "vetted_v2";
    const nameChanged = needsStrictRevet || !prevRow?.profile_vetted_at
      || (firstName !== null && firstName !== (prevRow?.first_name ?? null))
      || (lastName !== null && lastName !== (prevRow?.last_name ?? null));
    if (nameChanged) {
      const nm = await vetRealName(env, effFirst!, effLast!);
      if (nm.unavailable) {
        await track(env, ctx.uid, "profile_vet_error", "profile", { stage: "realname_model" }).catch(() => {});
        return json({ error: "profile_vet_unavailable", field: "first_name", message: "Ava couldn't verify that name right now. Nothing was saved — please try again shortly." }, 503);
      }
      if (!nm.plausible) {
        track(env, ctx.uid, "profile_vet_rejected", "profile", { reason_class: "realname", field: "first_name" });
        return json({ error: "implausible_name", field: "first_name", message: nm.reason }, 400);
      }
    }
    // Avatar nudity moderation (Rekognition DetectModerationLabels). Only run on a
    // NEW/changed photo (skip re-moderating an unchanged v2-approved avatar on
    // later saves). Reject explicit unsafe results and fail closed on provider or
    // fetch errors so no photo is stamped approved without actually being checked.
    const photoNeedsVet = needsStrictRevet || !prevRow?.profile_vetted_at || (avatarUrl !== null && avatarUrl !== (prevRow?.avatar_url ?? null));
    if (photoNeedsVet) {
      if (!rekognitionConfigured(env)) {
        await track(env, ctx.uid, "profile_vet_error", "profile", { stage: "photo_model_config" }).catch(() => {});
        return json({ error: "profile_vet_unavailable", field: "photo", message: "Ava couldn't verify that photo right now. Nothing was saved — please try again shortly." }, 503);
      }
      {
        try {
          const res = await fetch(effAvatar!);
          if (!res.ok) throw new Error(`avatar_fetch_${res.status}`);
          const bytes = new Uint8Array(await res.arrayBuffer());
          const mod = await detectModerationLabels(env, bytes);
          const verdict = avatarModerationRejected(mod.ModerationLabels);
          if (verdict.rejected) {
            track(env, ctx.uid, "profile_vet_rejected", "profile", { reason_class: "photo", field: "photo", label: verdict.label });
            return json({ error: "profile_vet_rejected", field: "photo", message: "That photo didn't pass our check — please choose another." }, 400);
          }
        } catch {
          await track(env, ctx.uid, "profile_vet_error", "profile", { stage: "photo_moderation" }).catch(() => {});
          return json({ error: "profile_vet_unavailable", field: "photo", message: "Ava couldn't verify that photo right now. Nothing was saved — please try again shortly." }, 503);
        }
      }
    }
    track(env, ctx.uid, "profile_vet_passed", "profile", {});
    // [PROFILE-HARD-GATE-1] Reaching here means the profile passed EVERY check:
    // content moderation (guardWrite, above), completeness, real-name
    // plausibility, and photo moderation. Stamp the approval so the launch gate
    // can admit this user WITHOUT re-running any classifier.
    //
    // This is what makes the owner's outage rule work: approval is a stored
    // fact, so an OpenRouter/Gemini outage holds only NEW or CHANGED profiles
    // and never evicts someone who already passed. Re-checking live would turn
    // a third-party outage into a total app outage for every user at once.
    //
    // Stamped BEFORE the upsert deliberately: the upsert is the write that
    // persists the values these checks just approved, so the two must land
    // together. `vetVerdict` is applied inside that same statement below.
    vetVerdict = "passed";
  }

  // [WELCOME-100-1] The upsert below both creates and updates, so detect the
  // FIRST materialization here: no users row yet → this publish is the account
  // creation → grant the 100-token welcome bonus after the insert. The grant is
  // idempotent (WalletDO op_id `welcome:<uid>`), so a replayed/racing publish —
  // or this check misreading a lagged replica — can never double-grant.
  const existedBefore = await db.prepare("SELECT 1 AS one FROM users WHERE uid=?1")
    .bind(ctx.uid).first<{ one: number }>().catch(() => null);

  await db.prepare(
    // [PROFILE-HARD-GATE-1] the two vetted columns are in the INSERT list too —
    // a BRAND-NEW account takes this branch, so omitting them would leave a
    // just-approved first-time user with profile_vetted_at NULL and bounce them
    // straight into the gate they had already satisfied.
    `INSERT INTO users (uid, display_name, first_name, last_name, avatar_url, email_hash, phone_hash, birth_year, bio, gender, created_at, updated_at, profile_vetted_at, profile_vetted_reason)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?10,?11,?9,?9,?12,?13)
     ON CONFLICT(uid) DO UPDATE SET
       display_name=COALESCE(?2,display_name), first_name=COALESCE(?3,first_name), last_name=COALESCE(?4,last_name),
       avatar_url=COALESCE(?5,avatar_url), email_hash=COALESCE(?6,email_hash),
       phone_hash=COALESCE(?7,phone_hash), birth_year=COALESCE(?8,birth_year),
       bio=COALESCE(?10,bio), gender=COALESCE(?11,gender), updated_at=?9,
       -- [PROFILE-HARD-GATE-1] COALESCE(?12, profile_vetted_at) — stamp approval
       -- only when the gate actually ran AND passed (?12 is the timestamp then,
       -- NULL otherwise). NULL therefore PRESERVES an existing approval rather
       -- than clearing it, so a partial publish (the launch publish sends only
       -- name/email/phone) can never un-approve a user who already passed.
       profile_vetted_at=COALESCE(?12, profile_vetted_at),
       profile_vetted_reason=COALESCE(?13, profile_vetted_reason)`,
  ).bind(ctx.uid, name, firstName, lastName, avatarUrl, emailHash, phoneHash, birthYear, now, bio, gender,
         vetVerdict === "passed" ? now : null,
         vetVerdict === "passed" ? "vetted_v2" : null).run();
  // [WELCOME-100-1] New account → 100-token welcome bonus (persistent promo
  // bucket; idempotent). Awaited (no executionCtx here) but NEVER blocks signup.
  if (!existedBefore) {
    try { await grantWelcomeBonus(env, ctx.uid); } catch { /* best-effort — backfill route can repair */ }
  }
  // Feed a non-empty self-description to AvaBrain so Ava can personalise. Scoped
  // 'private'; the brain consumer still honours the user's AvaBrain consent toggle.
  if (bio) void brainIngest(env, { uid: ctx.uid, domain: "profile", kind: "profile_bio", sourceId: `${ctx.uid}:bio`, text: String(bio).slice(0, 480), meta: { bio } });
  // P11: feed the profile summary so the receptionist + AvaBrain know their owner
  // (name, gender→pronouns, About). Scoped private; the brain consumer still honours
  // the AvaBrain consent toggle.
  void brainIngest(env, {
    uid: ctx.uid, domain: "profile", kind: "profile_updated", sourceId: `${ctx.uid}:${now}`,
    text: `Profile: ${name}`,
    meta: {
      name, first_name: firstName, last_name: lastName, gender, birth_year: birthYear,
      ...(bio ? { about: bio } : {}),
    },
  });
  return json({ ok: true, profile: { uid: ctx.uid, name, first_name: firstName, last_name: lastName, email: b.email || "", phone: b.phone || "" } });
}

// GET /api/me — restore endpoint. Authenticated by the Clerk JWT. Looks the
// account up by uid and returns the public profile so a fresh install rehydrates.
export async function me(req: Request, env: Env): Promise<Response> {
  const clerk = await verifyClerk(env, req.headers.get("authorization"));
  if ("skipped" in clerk) return json({ found: false, clerk_enabled: false });
  if ("error" in clerk) return json({ error: "clerk: " + clerk.error }, 401);
  const clerkRaw = clerk.clerkUserId;
  const PROF_COLS =
    // [PROFILE-HARD-GATE-1] profile_vetted_at rides along so /api/me can tell the
    // client whether this account is admitted, with no extra query and no
    // classifier call on the launch path.
    "SELECT display_name, first_name, last_name, avatar_url, birth_year, bio, gender, avatok_number, avatok_number_display, phone_discoverable, email_discoverable, who_can_add, share_token, profile_vetted_at, profile_vetted_reason FROM users WHERE uid=?1";
  // [ACCT-RELINK-1] Resolve to the canonical account first (handles a login whose
  // Clerk id previously changed and was already aliased).
  let uid = await resolveCanonicalUid(env, clerkRaw);
  let prof = await metaSession(env).prepare(PROF_COLS).bind(uid).first<any>();
  if (!prof) {
    // No account for this Clerk id. Before forking the person into onboarding (which
    // would orphan an existing account + number), check whether this is the SAME
    // person returning under a NEW Clerk id: match by their Clerk-VERIFIED email
    // against the email_hash we stored. If it matches, alias new id -> original uid
    // and restore. Best-effort throughout — any failure falls through to newUser.
    try {
      const email = await primaryVerifiedEmailFor(env, clerkRaw);
      if (email) {
        const ehLower = await sha256Hex(email.trim().toLowerCase());
        let match = await metaSession(env)
          .prepare("SELECT uid FROM users WHERE email_hash=?1 ORDER BY updated_at DESC LIMIT 1")
          .bind(ehLower).first<{ uid: string }>();
        if (!match) {
          const ehRaw = await sha256Hex(email.trim());
          if (ehRaw !== ehLower) {
            match = await metaSession(env)
              .prepare("SELECT uid FROM users WHERE email_hash=?1 ORDER BY updated_at DESC LIMIT 1")
              .bind(ehRaw).first<{ uid: string }>();
          }
        }
        if (match?.uid && String(match.uid) !== clerkRaw) {
          await linkClerkAlias(env, clerkRaw, String(match.uid), "email_relink");
          try { track(env, String(match.uid), "account_email_relinked", "platform", { from_clerk_id: clerkRaw }); } catch { /* telemetry best-effort */ }
          uid = String(match.uid);
          prof = await metaSession(env).prepare(PROF_COLS).bind(uid).first<any>();
        }
      }
    } catch { /* relink is best-effort; fall through to onboarding if it can't help */ }
  }
  if (!prof) {
    // [ONBOARD-402-1] Bootstrap the idempotent welcome grant before the profile
    // screen can invoke token-metered onboarding AI. Previously the first 100
    // tokens were granted only after POST /api/profile, but ProfileSetupScreen
    // calls /api/ai/gender before the user can save that form.
    try { await grantWelcomeBonus(env, clerkRaw); } catch { /* AI path retries the same idempotent grant */ }
    return json({ found: false, clerk_enabled: true, uid: clerkRaw, email: await emailFor(env, clerkRaw) });
  }
  // P11: completeness = photo + first + last + birth year + gender + About (phone
  // is the only optional field). The client routes an incomplete profile to the
  // Profile screen before the app when profileCompletionGate is ON.
  const profileComplete = !!(prof.avatar_url && prof.first_name && prof.last_name
    && prof.birth_year && prof.gender && prof.bio);
  return json({
    found: true, clerk_enabled: true, uid,
    // Authenticated identity hydration for onboarding. This is returned only
    // to the signed-in account itself; D1 continues storing only email_hash.
    email: await emailFor(env, uid),
    display_name: prof.display_name ?? null, first_name: prof.first_name ?? null, last_name: prof.last_name ?? null,
    avatar_url: prof.avatar_url ?? null, birth_year: prof.birth_year ?? null, bio: prof.bio ?? null,
    gender: prof.gender ?? null, profile_complete: profileComplete,
    avatok_number: prof.avatok_number ?? null, avatok_number_display: prof.avatok_number_display ?? null,
    phone_discoverable: !!prof.phone_discoverable, email_discoverable: prof.email_discoverable !== 0,
    who_can_add: prof.who_can_add ?? "everyone", share_token: prof.share_token ?? null,
    // [PROFILE-HARD-GATE-1] The launch gate, decided server-side so the client
    // cannot be talked out of it and so the rule lives in ONE place.
    //
    // `profile_approved` is true when the stored approval exists — a FACT from
    // the last successful save, never a fresh classifier call. That is the whole
    // point: during an AI-moderation outage an approved user sails through
    // (owner decision 2026-08-17), because nothing is recomputed on this path.
    //
    // `profile_gate_enforced` mirrors the same profileCompletionGate flag the
    // save path already obeys, so the flag is the single kill switch for BOTH
    // halves. Flip it off and the client stops gating immediately, with no
    // deploy — which matters because a bug here locks people out of the app.
    // It fails OPEN (`false`) if the config read throws, for the same reason.
    profile_approved: prof.profile_vetted_at != null && prof.profile_vetted_reason === "vetted_v2",
    profile_gate_enforced: await (async () => {
      try { return (await readConfig(env)).profileCompletionGate === true; } catch { return false; }
    })(),
  });
}

// ---- encrypted per-user vault: /api/vault (auth) — uid-keyed opaque blobs ----
const VAULT_KINDS = new Set(["contacts", "settings", "apps"]);
const VAULT_MAX = 600_000;

export async function vaultPut(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  // Abuse limit (Phase 3): cap vault writes per account + per source IP. Generous
  // for legit sync (contacts/settings/apps blobs), tight enough to stop scripted abuse.
  const ip = req.headers.get("CF-Connecting-IP") || "0.0.0.0";
  const rlU = await rateLimit(env, `vault_put:${ctx.uid}`, 120, 3600);
  if (rlU) return rlU;
  const rlI = await rateLimit(env, `vault_put_ip:${ip}`, 600, 3600);
  if (rlI) return rlI;
  const b = (await req.json().catch(() => ({}))) as { kind?: string; blob?: string };
  const kind = (b.kind || "").trim().toLowerCase();
  const blob = typeof b.blob === "string" ? b.blob : "";
  if (!VAULT_KINDS.has(kind)) return json({ error: "bad kind" }, 400);
  if (!blob || blob.length > VAULT_MAX) return json({ error: "blob missing or too large" }, 400);
  await metaSession(env).prepare(
    `INSERT INTO user_vault (uid, kind, blob, updated_at) VALUES (?1,?2,?3,?4)
     ON CONFLICT(uid, kind) DO UPDATE SET blob=?3, updated_at=?4`,
  ).bind(ctx.uid, kind, blob, Date.now()).run();
  return json({ ok: true });
}

export async function vaultGet(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const rlU = await rateLimit(env, `vault_get:${ctx.uid}`, 600, 3600);
  if (rlU) return rlU;
  const kind = (new URL(req.url).searchParams.get("kind") || "").trim().toLowerCase();
  if (!VAULT_KINDS.has(kind)) return json({ error: "bad kind" }, 400);
  const r = await metaSession(env).prepare(
    "SELECT blob, updated_at FROM user_vault WHERE uid=?1 AND kind=?2",
  ).bind(ctx.uid, kind).first<{ blob: string; updated_at: number }>();
  return json({ blob: r?.blob ?? null, updated_at: r?.updated_at ?? 0 });
}

function profOut(r: any) {
  return r ? { uid: r.uid, name: r.display_name, first_name: r.first_name ?? null, last_name: r.last_name ?? null, avatar_url: r.avatar_url, number: r.avatok_number_display ?? null } : null;
}

// Resolve a query → uid + profile. Handles are retired; the network keys are the
// AvaTOK number (exact), the real phone (exact, only if the owner made it public),
// and email (exact, only if the owner allows email discovery).
// Read-through KV cache for the people-directory (resolve + search). Popular
// queries (an influencer/business searched thousands of times) return from edge
// KV instead of hitting D1. Keyed by a hash of the endpoint+query so raw emails/
// numbers never sit in KV as plaintext keys. TTL is MODERATE (30 min) so results
// stay fresh and a discoverability change self-heals fast; empty/not-found are
// cached only briefly so a just-joined user appears quickly and number probes are
// cheap. Reuses the TOKENS namespace under a `srch:` prefix (TTL auto-evicts).
export async function withSearchCache(req: Request, env: Env, handler: () => Promise<Response>): Promise<Response> {
  const q = (new URL(req.url).searchParams.get("q") || "").trim();
  if (q.length < 2) return handler();
  const kv = (env as any).TOKENS;
  const path = new URL(req.url).pathname;
  let ck = "";
  try { ck = "srch:" + (await sha256Hex(path + "|" + q.toLowerCase())); } catch { return handler(); }
  try {
    const hit = await kv?.get(ck);
    if (hit != null) return new Response(hit, { status: 200, headers: { "content-type": "application/json", "x-cache": "HIT" } });
  } catch { /* cache read best-effort */ }
  const res = await handler();
  try {
    if (res.status === 200) {
      const body = await res.clone().text();
      // Empty/not-found → short TTL so new users show up fast + probes stay cheap.
      const empty = body.includes('"results":[]') || body.includes('"uid":null')
        || body.includes('"profile":null');
      await kv?.put(ck, body, { expirationTtl: empty ? 60 : 1800 });
    }
  } catch { /* cache write best-effort */ }
  return res;
}

export async function resolve(req: Request, env: Env): Promise<Response> {
  const q = (new URL(req.url).searchParams.get("q") || "").trim();
  if (!q) return json({ error: "q required" }, 400);
  const db = metaSession(env);
  const fetchProf = (uid: string) => db.prepare("SELECT uid,display_name,first_name,last_name,avatar_url,avatok_number_display FROM users WHERE uid=?1").bind(uid).first();

  if (q.startsWith("user_")) {
    const profile = profOut(await fetchProf(q));
    // The uid remains routable even if profile publication is still catching
    // up, but make the missing identity explicit. withSearchCache recognises
    // profile:null and retries it after the short empty-result TTL.
    return json({ uid: q, profile, profile_found: profile !== null });
  }
  if (q.includes("@") && q.includes(".")) {
    const r = await db.prepare("SELECT uid FROM users WHERE email_hash=?1 AND email_discoverable<>0 ORDER BY updated_at DESC LIMIT 1").bind(await sha256Hex(q.toLowerCase())).first<{ uid: string }>();
    if (!r) return json({ uid: null }, 404);
    return json({ uid: r.uid, profile: profOut(await fetchProf(r.uid)) });
  }
  const digits = q.replace(/[^0-9]/g, "");
  if (digits.length >= 6) {
    // 1) exact AvaTOK number (canonical E.164 digits). ALSO match a user's
    // EXPLICITLY-exposed private number (show_private_number=1) so dialing it on
    // the AvaTOK dialpad rings their app (owner request 2026-06-29). This is
    // OPT-IN only — a private phone never resolves by default (the 2026-06-27
    // privacy rule still holds for everyone who hasn't turned it on). Guarded:
    // falls back to the AvaTOK-only query if the columns aren't migrated yet, so
    // a deploy-before-migration can NEVER break dialing.
    // Format-tolerant + INDEXED. People type numbers with/without '+', country
    // code and separators. avatok_number (canonical digits) and number_norm (last
    // 10 digits) are BOTH indexed, so "+13022202211", "13022202211" and
    // "3022202211" all resolve via an index lookup — no table scan.
    const suffix = digits.slice(-10);
    // `const`, not `let`: with the private-number fallback below removed there is
    // no longer any reassignment.
    const byNum = await db.prepare(
      "SELECT uid FROM users WHERE avatok_number=?1 OR number_norm=?2 ORDER BY (avatok_number=?1) DESC LIMIT 1",
    ).bind(digits, suffix).first<{ uid: string }>();
    // [PIVOT-NUMBER-PRIVACY-1] The private-number fallback is REMOVED.
    //
    // It used to run `SELECT uid FROM users WHERE show_private_number=1 AND
    // private_number=?1`, which resolved an account from a RAW REAL phone
    // number — anyone who knew (or guessed) someone's real number could turn it
    // into their AvaTOK identity. The marketplace-first pivot (2026-08-27) makes
    // the AvaTOK number the ONLY public identity: the real number is collected
    // for signup, stored as sha256(E.164), and shown to nobody.
    //
    // `privateNumberSet` in routes/number.ts now hard-writes show_private_number=0
    // so no NEW row can become exposable, but that alone does not help the rows
    // already flagged 1 from before the fix. Deleting the read is what actually
    // closes it, for existing rows as well as new ones. The column and its field
    // name are left in place — they are a shipped wire contract — they are simply
    // never read here again.
    //
    // Lookup by `avatok_number` / `number_norm` above is unaffected and is the
    // intended path: `number_norm` is the last 10 digits of the AVATOK number
    // (migrations/search_number_norm.sql), not of the real one.
    if (byNum) return json({ uid: byNum.uid, profile: profOut(await fetchProf(byNum.uid)) });
  }
  return json({ uid: null }, 404);
}

// People discovery by name / bio (prefix + substring LIKE). No handle. Users who
// set "who can add me = nobody" are excluded from discovery.
//
// DISCOVERY IS EXACT-KEY ONLY (owner decision 2026-07-01): email (via /api/resolve)
// and AvaTOK number. NAME SEARCH IS INTENTIONALLY REMOVED — at millions of users a
// name matches thousands of people (useless), and name matching is a scan/cost with
// no product value. So this endpoint only resolves an AvaTOK NUMBER; a non-numeric
// query returns nothing.
export async function search(req: Request, env: Env): Promise<Response> {
  const raw = (new URL(req.url).searchParams.get("q") || "").trim();
  if (raw.length < 2) return json({ results: [] });
  const db = metaSession(env);
  const shape = (r: any) => ({ uid: r.uid, name: r.display_name, first_name: r.first_name ?? null, last_name: r.last_name ?? null, avatar_url: r.avatar_url, number: r.avatok_number_display ?? null, bio: r.bio ?? null });

  // AvaTOK-number lookup — format-tolerant + INDEXED (avatok_number exact OR
  // number_norm last-10). "+13022202211", "13022202211", "3022202211" all resolve.
  const digits = raw.replace(/[^0-9]/g, "");
  if (digits.length >= 6 && /^[+0-9\s()\-]+$/.test(raw)) {
    const suffix = digits.slice(-10);
    const nr = await db.prepare(
      `SELECT uid, display_name, first_name, last_name, avatar_url, bio, avatok_number_display FROM users
         WHERE (who_can_add IS NULL OR who_can_add<>'nobody')
           AND (avatok_number=?1 OR number_norm=?2)
         ORDER BY (avatok_number=?1) DESC LIMIT 10`,
    ).bind(digits, suffix).all();
    return json({ results: (nr.results ?? []).map(shape) });
  }

  // Not a number → no directory results (name search removed by design).
  return json({ results: [] });
}

// ---- contacts: /api/contacts/sync /api/contacts/match (auth) /list ----
// PRIVACY (owner decision 2026-06-27): contact "presence" matching is DISABLED.
// These endpoints previously took a batch of the user's phone-book numbers/emails
// and returned which ones map to AvaTOK accounts (uid) — a presence oracle that
// let anyone confirm a private phone belongs to an AvaTOK user and correlate it
// to their identity (the phone branch wasn't even gated by phone_discoverable).
// They now intentionally return NOTHING regardless of the request body, so even a
// modified client cannot probe. Discovery is allowed ONLY via the exact,
// owner-controlled keys in `resolve` (AvaTOK number, or email when the owner
// enabled email discovery). The phone book stays on-device, used solely for the
// user's own invites.
export async function contactsSync(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  return json({ stored: 0, matched: [] });
}

// [AVA-MISSEDCALL-1] Phone-presence match RE-ENABLED (owner instruction 2026-07-14),
// deliberately REVERSING the 2026-06-27 privacy lock documented above: AvaTOK
// membership is now resolved from the caller's real phone number so the missed-call
// overlay can light the AvaTOK icon. Matches ALL accounts by phone_hash regardless of
// phone_discoverable — the owner's instruction is explicitly to identify AvaTOK users
// by their private number.
//
// GATED by the `missedCallOverlay` platform flag (master kill switch): while that flag
// is false this endpoint still returns nothing, preserving the old privacy behaviour
// until the feature is switched on in KV. Flipping the flag back to false instantly
// restores the lock.
//
// Contract: POST { hashes?: string[], numbers?: string[] }.
//   - `hashes` = sha256 hex of the E.164 number (preferred — the raw number never
//     leaves the device).
//   - `numbers` = raw numbers we normalize + hash server-side (convenience fallback).
// Capped at 500 per call. Returns { matched: [{ hash, uid, name, avatar_url,
// avatok_number }] } for the subset that map to an AvaTOK account.
export type AvatokPhoneMatch = {
  hash: string;
  uid: string;
  name: string | null;
  avatar_url: string | null;
  avatok_number: string | null;
};

/**
 * [AVA-MISSEDCALL-1] Shared phone-presence match core, used by both /api/contacts/match
 * (Clerk-auth) and /api/missedcall/lookup (device-token-auth). Accepts sha256(E.164)
 * hashes and/or raw numbers (normalized + hashed here), caps at 500, and returns the
 * subset that map to an AvaTOK account. Matches ALL accounts by phone_hash regardless of
 * phone_discoverable — the owner's 2026-07-14 instruction is to identify AvaTOK users by
 * their private number. Callers are responsible for the `missedCallOverlay` flag gate.
 */
export async function matchAvatokPhones(
  env: Env,
  input: { hashes?: unknown; numbers?: unknown },
): Promise<AvatokPhoneMatch[]> {
  const hashes = new Set<string>();
  if (Array.isArray(input.hashes)) {
    for (const h of input.hashes) {
      if (typeof h === "string" && /^[0-9a-f]{64}$/.test(h)) hashes.add(h);
    }
  }
  if (Array.isArray(input.numbers)) {
    for (const n of input.numbers) {
      if (typeof n === "string") {
        const e164 = normalizePhone(n);
        if (e164.replace(/\D/g, "").length >= 6) hashes.add(await sha256Hex(e164));
      }
    }
  }
  const list = Array.from(hashes).slice(0, 500);
  if (list.length === 0) return [];

  const db = metaSession(env);
  const matched: AvatokPhoneMatch[] = [];
  // Chunk the IN(...) to stay under D1's bind-var ceiling.
  const CHUNK = 90;
  for (let i = 0; i < list.length; i += CHUNK) {
    const slice = list.slice(i, i + CHUNK);
    const placeholders = slice.map((_, k) => "?" + (k + 1)).join(",");
    const rows = await db
      .prepare(
        `SELECT phone_hash, uid, display_name, avatar_url, avatok_number_display
           FROM users WHERE phone_hash IN (${placeholders})`,
      )
      .bind(...slice)
      .all<{
        phone_hash: string;
        uid: string;
        display_name: string | null;
        avatar_url: string | null;
        avatok_number_display: string | null;
      }>();
    for (const r of rows.results ?? []) {
      matched.push({
        hash: r.phone_hash,
        uid: r.uid,
        name: r.display_name,
        avatar_url: r.avatar_url,
        avatok_number: r.avatok_number_display,
      });
    }
  }
  return matched;
}

export async function contactsMatch(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);

  const cfg = await readConfig(env);
  if (!cfg.missedCallOverlay) return json({ matched: [] });

  const b = (await req.json().catch(() => ({}))) as { hashes?: unknown; numbers?: unknown };
  return json({ matched: await matchAvatokPhones(env, b) });
}

export function contactsList(): Response {
  return json({ updated: 0, contacts: [] });
}

// ---- communities: /api/community /api/community/join (auth) /communities (public) ----
export async function communityUpsert(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  if (!b.name) return json({ error: "name required" }, 400);
  const owner = ctx.uid;
  const id = String(b.id || crypto.randomUUID());
  const now = Date.now();
  const db = metaSession(env);
  await db.prepare(
    `INSERT INTO communities (id, name, description, avatar_url, owner_uid, created_at)
     VALUES (?1,?2,?3,NULL,?4,?5) ON CONFLICT(id) DO UPDATE SET name=?2, description=?3`,
  ).bind(id, String(b.name).trim(), String(b.about || "").trim(), owner, now).run();
  const members: string[] = Array.from(new Set([owner, ...((b.members) || [])]));
  for (const m of members) {
    await db.prepare("INSERT OR IGNORE INTO community_members (community_id, uid, role, joined_at) VALUES (?1,?2,?3,?4)")
      .bind(id, m, m === owner ? "owner" : "member", now).run();
  }
  return json({ ok: true, community: await communityObj(db, id) });
}

export async function communityJoin(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as { id?: string };
  if (!b.id) return json({ error: "id required" }, 400);
  const db = metaSession(env);
  const exists = await db.prepare("SELECT 1 FROM communities WHERE id=?1").bind(b.id).first();
  if (!exists) return json({ error: "not found" }, 404);
  await db.prepare("INSERT OR IGNORE INTO community_members (community_id, uid, role, joined_at) VALUES (?1,?2,'member',?3)")
    .bind(b.id, ctx.uid, Date.now()).run();
  return json({ ok: true, community: await communityObj(db, b.id) });
}

async function communityObj(db: D1DatabaseSession, id: string): Promise<any> {
  const c = await db.prepare("SELECT id,name,description,owner_uid,created_at FROM communities WHERE id=?1").bind(id).first<any>();
  if (!c) return null;
  const m = await db.prepare("SELECT uid FROM community_members WHERE community_id=?1").bind(id).all();
  return { id: c.id, name: c.name, about: c.description, owner: c.owner_uid, created: c.created_at, members: (m.results ?? []).map((x: any) => x.uid), groups: [] };
}

export async function communities(req: Request, env: Env): Promise<Response> {
  const sp = new URL(req.url).searchParams;
  const db = metaSession(env);
  const id = sp.get("id");
  if (id) { const c = await communityObj(db, id); return c ? json({ community: c }) : json({ error: "not found" }, 404); }
  const member = (sp.get("member") || "").trim();
  if (!member) return json({ communities: [] });
  const ids = await db.prepare("SELECT community_id FROM community_members WHERE uid=?1 LIMIT 100").bind(member).all();
  const out: any[] = [];
  for (const r of (ids.results ?? []) as any[]) { const c = await communityObj(db, r.community_id); if (c) out.push(c); }
  return json({ communities: out });
}

// ---- backup: deprecated with the relay. Message history now lives in InboxDO;
// a uid-scoped export will be re-added off the InboxDO sync log if needed. ----
export async function backup(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  return json({ error: "backup deprecated — relay removed; history lives in your InboxDO" }, 501);
}

// [LASTSEEN-SERVER-1] WhatsApp-style last seen. GET /api/user/last-seen?uid=X →
// { online, last_active_at } from X's InboxDO — the one component that truthfully
// knows when their device's socket was last connected. Auth required (no anonymous
// presence oracle); the client's per-thread privacy toggle still governs display.
export async function userLastSeen(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const uid = new URL(req.url).searchParams.get("uid") ?? "";
  if (!uid) return json({ error: "uid required" }, 400);
  // [LASTSEEN-PRIVACY-1] Enforce the TARGET's visibility choice server-side —
  // everyone | contacts | list | nobody (WhatsApp-style). 'contacts' and 'list'
  // both check the requester against the target's last_seen_allow uid set.
  // Missing columns / NULL (pre-migration rows) fail open to 'everyone'.
  try {
    const row = await env.DB_META.prepare(
      "SELECT last_seen_visibility, last_seen_allow FROM users WHERE uid=?1",
    ).bind(uid).first<any>().catch(() => null);
    const vis = (row?.last_seen_visibility as string | null) ?? "everyone";
    if (vis === "nobody") {
      return json({ ok: true, online: false, last_active_at: null, restricted: true });
    }
    if (vis === "contacts" || vis === "list") {
      let allowed = false;
      try {
        const a = JSON.parse(row?.last_seen_allow ?? "[]");
        allowed = Array.isArray(a) && a.map(String).includes(ctx.uid);
      } catch { /* corrupt allow list → treat as empty */ }
      if (!allowed) {
        return json({ ok: true, online: false, last_active_at: null, restricted: true });
      }
    }
  } catch { /* privacy read failed → fail open (everyone), matching NULL rows */ }
  try {
    const stub = env.INBOX.get(env.INBOX.idFromName(uid));
    const r = await stub.fetch("https://inbox/last-seen", { method: "GET" });
    const j = (await r.json().catch(() => ({}))) as { online?: boolean; last_active_at?: number | null };
    return json({ ok: true, online: j.online === true, last_active_at: j.last_active_at ?? null });
  } catch {
    return json({ ok: false, online: false, last_active_at: null });
  }
}

// [WP3-ACT-1] POST /api/call/no-answer — plan §3 step 4: the CALLER's client
// calls this once a genuine ring-timeout has elapsed (or the callee declined /
// tapped "Send to Ava AI Agent") on a business (dialpad) call, so the
// after-ring outcome (agent/voicemail/none) is decided server-side. Auth =
// the caller (ctx.uid) — same trigger shape as the existing receptionistStart().
export async function callNoAnswer(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const cfg = await readConfig(env);
  if (cfg.businessCallUx !== true) return json({ error: "disabled", flag: "businessCallUx" }, 503);
  const b = (await req.json().catch(() => ({}))) as {
    callee?: string; call_id?: string; trace_id?: string; outcome?: string;
  };
  const callee = String(b.callee || "");
  const callId = String(b.call_id || "");
  if (!callee || !callId) return json({ error: "callee and call_id required" }, 400);
  const outcomes: NoAnswerOutcome[] = ["declined", "no_answer", "manual_send_to_agent"];
  const outcome: NoAnswerOutcome = outcomes.includes(b.outcome as NoAnswerOutcome)
    ? (b.outcome as NoAnswerOutcome) : "no_answer"; // default: a genuine ring-timeout
  const traceId = String(b.trace_id || req.headers.get("x-trace-id") || newTraceId());

  const result = await decideNoAnswerRouting(env, {
    call_id: callId, trace_id: traceId, caller_id: ctx.uid, callee_id: callee,
    number_dialed: null, via: "dialpad", outcome,
  });
  if (result.action === "busy") {
    // Paid line (Mode B) overflow discovered only after the ring genuinely
    // timed out (plan §11/§15.1) — same treatment as the pre-ring /api/call
    // busy path: never voicemail, release any hold that was armed for this
    // call_id before the ring started.
    try {
      const stub = env.CALL_ROOMS.get(env.CALL_ROOMS.idFromName(callId));
      await stub.fetch("https://call/billing-disarm", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "BUSY" }),
      });
    } catch { /* best-effort */ }
    const busyKind = result.busy_kind;
    const message = busyKind === "agents_full"
      ? "All agents are busy right now — please try again in a while."
      : "This line is busy. Please try again later.";
    return json({ next: "busy", busy_kind: busyKind, message, voicemail_available: false });
  }
  const next: "voicemail" | "agent" | "none" =
    result.action === "agent" ? "agent" : result.action === "voicemail" ? "voicemail" : "none";
  return json({
    next,
    ...(next !== "none" ? { start: { to: callee, call_id: callId, trace_id: traceId } } : {}),
    voicemail_available: result.snapshot.voicemail_enabled === true,
  });
}

// [CALL-REL-9] REL-10: compact device-side ring-audibility fields, carried on
// the SAME device-ringing receipt the callee already sends here (see
// PushService.reportRinging in push_service.dart). Data-plumbing only in this
// pass — CallRoom DO does not yet branch on these; they ride along on the
// existing /control POST so the fields reach the backend and are queryable
// once a follow-up teaches the DO (and/or an analytics sink) to read them.
// `audible` mirrors the client's own tri-state classification: 'true' | 'false'
// | 'unknown' — see call_ring_audibility (client telemetry) for the full
// signal set this is a compact echo of.
interface RingAudibilityFields {
  audible?: string;        // 'true' | 'false' | 'unknown'
  ringerMode?: string;     // 'normal' | 'vibrate' | 'silent' | 'unknown'
  dndBlocking?: boolean;
  ringVolume?: number;
  ringVolumeMax?: number;
  route?: string;
  // [CALL-4RINGS-1 2026-08-08] Which ring CYCLE this receipt is for, 1-based and
  // monotonic within one call. Absent on every shipped client and on the very
  // first (audibility-free) receipt, which is why the DO treats "no ringIndex"
  // as "not a countable cycle" rather than inventing index 1 for it.
  ringIndex?: number;
  // True when the cycle boundary was ASSUMED from a `ringCycleMs` timer rather
  // than observed. Android exposes no per-cycle callback for the OS ringtone, so
  // this is true for most receipts; keeping it on the wire is what stops us
  // quietly presenting a guess as a measurement.
  derived?: boolean;
}

export async function callRinging(req: Request, env: Env): Promise<Response> {
  const b = (await req.json().catch(() => ({}))) as {
    callId?: string;
    ringReceiptToken?: string;
  } & RingAudibilityFields;
  const callId = String(b.callId ?? "").trim();
  const token = String(b.ringReceiptToken ?? "").trim();
  if (!callId) return json({ error: "callId required" }, 400);
  if (!token) return json({ error: "ringReceiptToken required" }, 400);
  if (!env.CALL_ROOMS) return json({ error: "CALL_ROOMS binding missing" }, 500);

  // [CALL-REL-9] Only forward the audibility fields when the client actually
  // sent at least one — keeps the payload byte-identical for any client build
  // that predates this change (no fake/half-populated fields).
  const audibility: RingAudibilityFields = {};
  if (typeof b.audible === "string") audibility.audible = b.audible;
  if (typeof b.ringerMode === "string") audibility.ringerMode = b.ringerMode;
  if (typeof b.dndBlocking === "boolean") audibility.dndBlocking = b.dndBlocking;
  if (typeof b.ringVolume === "number") audibility.ringVolume = b.ringVolume;
  if (typeof b.ringVolumeMax === "number") audibility.ringVolumeMax = b.ringVolumeMax;
  if (typeof b.route === "string") audibility.route = b.route.slice(0, 24);
  // [CALL-4RINGS-1] Clamped, not merely type-checked: `ringIndex` is the only
  // client-supplied number the handoff decision reads, so a device that sent
  // `ringIndex: 9999` would otherwise hand its own caller to Ava on cycle one.
  // The DO also requires strict monotonicity, so this is the second of two gates.
  if (typeof b.ringIndex === "number" && Number.isFinite(b.ringIndex)) {
    audibility.ringIndex = Math.min(64, Math.max(1, Math.round(b.ringIndex)));
  }
  if (typeof b.derived === "boolean") audibility.derived = b.derived;

  try {
    const stub = env.CALL_ROOMS.get(env.CALL_ROOMS.idFromName(callId));
    const r = await stub.fetch("https://call-room/control", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "device-ringing",
        callId,
        token,
        ...(Object.keys(audibility).length ? { ringAudibility: audibility } : {}),
      }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({ error: "failed to relay ringing to CallRoom" }));
      return json(err, r.status);
    }
    return json({ ok: true });
  } catch (e) {
    return json({ error: `error: ${e}` }, 500);
  }
}
