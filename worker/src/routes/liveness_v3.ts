// Liveness V3 — server side (Trust Engine capability; Specs/LIVENESS-V3-VOICE-
// GUIDED-PLAN-DRAFT.md + Specs/TRUST-ENGINE-ARCH.md v1.1). This EXTENDS the
// deployed V2 flow (routes/liveness.ts + the self-consumed liveness-verify queue)
// — it does NOT rewrite it. V2 stays the default; V3 ships DARK behind the
// `livenessV3Enabled` KV flag (readConfig merge — code defaults NEVER win over KV,
// the 2026-07-04 lesson).
//
// Entrypoint model (plan §0-A / §4-A.1): ONE generic Policy-Engine entrypoint,
// many callers. A caller passes {policy_id, requester}; liveness never learns WHY
// it was invoked. Its only output is an append-only verdict event
// (liveness_verdicts) + the existing identity_proofs / ladder wiring. It never
// touches Guardian/Sentinel state (strict boundary).
//
//   POST /api/liveness/v3/session {policy_id, requester}
//        → {session_id, nonce, challenges[], overlay, capture_offsets[],
//           upload{url|part_path, method, max_bytes}}
//   POST /api/liveness/v3/verify  {session_id, object_key?, device_report?,
//                                   client_sequence?[], capture_meta?,
//                                   frames?:[{t_offset_ms,jpeg_b64}]} → 202 pending
//        (frames[] is the INTERIM client-frame path — plan §0-C "Interim frame
//         path" — used until the MEDIA_EXTRACT server-decode binding exists.)
//   GET  /api/liveness/v3/result?session=<sid>          → {status} | verdict
//
// Verify runs ASYNC on the SAME `liveness-verify` queue as V2 (index.ts self-
// consumes it). The queue message carries {v3:true, uid, sid} so the consumer
// dispatches to runLivenessV3Checks. Idempotency + content-hash dedupe guard
// Rekognition spend; the ratified breaker (Rekognition 429/outage → Workers AI →
// REVIEW, never FAIL) is preserved via isRekognitionQuotaOrOutage().
//
// NO LLM anywhere in the decision path (Trust Engine invariant). Deterministic
// rules (lib/liveness_rules_v3.ts) consume only normalized provider fields
// (lib/liveness_provider.ts).
import type { Env } from "../types";
import { json, sha256Hex } from "../util";
import { requireUser, isFail } from "../authz";
import { setVerifiedCache } from "../auth";
import { metaDb, metaSession } from "../db/shard";
import { trackUserContact, metric, brainFact } from "../hooks";
import { contactFor } from "../lib/identity";
import { notifyUser } from "../notify";
import { invalidateLevelCache } from "./ladder";
import { markGatePassed } from "./ava_guardian";
import { recordLivenessAudit, auditPrefix, deviceCtxFromBody, edgeCtx } from "./liveness_audit";
import { readConfig } from "./config";
import {
  rekognitionConfigured, detectFaces, isRekognitionQuotaOrOutage, compareFaces,
} from "../aws/rekognition";
import { presignPutUrl } from "../aws/sigv4";
import {
  normalizeRekognition, normalizeWorkersAiFace,
} from "../lib/liveness_provider";
import {
  evaluateV3, motionMonotonic, LIVENESS_RULESET_V3_1,
  type FrameEvidence, type ReasonCode, type Verdict,
} from "../lib/liveness_rules_v3";
import {
  buildActiveChecks, parseCaptureMeta, evaluateAvatarDefense,
  type ActiveChecks, type CaptureMeta, type AvatarDefenseSignals,
} from "../lib/liveness_avatar_defense";

// ── Config / limits ──────────────────────────────────────────────────────────
// Active ruleset stamp. Bumped to V3_1 when the AI-avatar / second-phone /
// injected-camera defense layer (lib/liveness_avatar_defense.ts) shipped
// (2026-07-06). Every verdict/telemetry event carries this so a decision is
// reproducible against the exact weights/thresholds that produced it.
const RULESET = LIVENESS_RULESET_V3_1;
const DAY = 86_400_000;
const SESSION_TTL_S = 900;              // 15 min to finish a session
const MAX_VIDEO_BYTES = 15_000_000;     // 15 MB cap (plan §3 upload path)
const RESULT_TTL_S = 3600;              // verdict cached in KV 1h for the poll
const MAX_ATTEMPTS_24H = 20;            // per-account/day abuse+cost guard (matches V2)
const SAMPLE_FRAMES = 6;                // frames extracted per verify (plan §2.1)
// ── Interim client-frame path limits (plan §0-C "Interim frame path"). ─────────
// Workers can't decode MP4 and the MEDIA_EXTRACT binding doesn't exist yet, so
// until it does the CLIENT uploads still JPEG frames at the session capture_offsets
// alongside the video. Hard caps keep the (base64) verify body <1MB and bound the
// per-frame Rekognition spend. See runLivenessV3Checks §3b + the security note.
const MAX_CLIENT_FRAMES = 6;            // ≤6 frames (matches SAMPLE_FRAMES)
const MAX_CLIENT_FRAME_BYTES = 200_000; // ≤200KB per decoded JPEG (plan §1)
const MAX_CLIENT_FRAMES_TOTAL_BYTES = 900_000; // whole frame set <~1MB decoded
// Rough per-check Rekognition cost estimate (DetectFaces ~ $0.001/image). Used
// only for the cost_usd_estimate on the verdict row + telemetry, never a decision.
const REK_COST_PER_IMAGE = 0.001;

// Valid requester contexts (plan §4-A.1 / §0-A). Liveness records this but never
// branches on it — policy variation lives in the Policy Engine, not here.
const REQUESTERS = new Set([
  "onboarding", "marketplace_publish", "guardian_require_verification", "periodic_recheck",
]);

// Randomizable challenge actions (plan §0-B.1 / §1 step 4).
const CHALLENGE_ACTIONS = [
  "BLINK", "TURN_LEFT", "TURN_RIGHT", "LOOK_UP", "COME_CLOSER", "HOLD_STILL",
] as const;
const OVERLAY_SHAPES = ["circle", "rounded_square", "oval"] as const;
const OVERLAY_POSITIONS = ["center", "top_left", "top_right", "bottom_center"] as const;

// ── Small crypto-random helpers (same style as V2 pick()) ─────────────────────
function randInt(maxExclusive: number): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] % maxExclusive;
}
function pickN<T>(arr: readonly T[], n: number): T[] {
  const pool = [...arr];
  const out: T[] = [];
  while (out.length < n && pool.length) out.push(pool.splice(randInt(pool.length), 1)[0]);
  return out;
}
function randFloat(min: number, max: number): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return min + (buf[0] / 0xffffffff) * (max - min);
}

// ── Flag / attempt helpers (mirror V2's readConfig + KV attempt-counter pattern) ─
async function v3Enabled(env: Env): Promise<boolean> {
  return readConfig(env).then((c) => (c as { livenessV3Enabled?: boolean }).livenessV3Enabled === true).catch(() => false);
}

const dayKey = (uid: string, ts: number): string => {
  const d = new Date(ts);
  const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  return `livenessv3:att:${uid}:${ymd}`;
};
async function attemptsLast24h(env: Env, uid: string): Promise<number> {
  try {
    const now = Date.now();
    const [t, y] = await Promise.all([env.TOKENS.get(dayKey(uid, now)), env.TOKENS.get(dayKey(uid, now - DAY))]);
    return (Number(t) || 0) + (Number(y) || 0);
  } catch { return 0; }
}
async function bumpAttempt(env: Env, uid: string): Promise<void> {
  try {
    const key = dayKey(uid, Date.now());
    const cur = Number(await env.TOKENS.get(key)) || 0;
    await env.TOKENS.put(key, String(cur + 1), { expirationTtl: 2 * 86_400 });
  } catch { /* best-effort */ }
}

// ── R2 keys ──────────────────────────────────────────────────────────────────
// Transient upload prefix (mirrors V2's u/<uid>/liveness/<sid>/). The clip lands
// at <prefix>video.mp4. Retained pass evidence goes to the shared audit prefix
// liveness/<uid>/<sid>/ (reused from V2 liveness_audit.auditPrefix).
const uploadPrefix = (uid: string, sid: string) => `u/${uid}/livenessv3/${sid}/`;
const videoKey = (uid: string, sid: string) => uploadPrefix(uid, sid) + "video.mp4";

const sessionKvKey = (uid: string, sid: string) => `livenessv3:sess:${uid}:${sid}`;
const resultKvKey = (uid: string, sid: string) => `livenessv3:result:${uid}:${sid}`;
const deviceRepKvKey = (uid: string, sid: string) => `livenessv3:devrep:${uid}:${sid}`;
const edgeCtxKvKey = (uid: string, sid: string) => `livenessv3:edge:${uid}:${sid}`;
const captureMetaKvKey = (uid: string, sid: string) => `livenessv3:capmeta:${uid}:${sid}`;
// Interim client-supplied frames (base64 JPEG stills at the session capture_offsets).
// Stored transiently so the async verify pipeline reads them off the request path.
const clientFramesKvKey = (uid: string, sid: string) => `livenessv3:frames:${uid}:${sid}`;

// Hashed edge/verification-farm correlation props (plan §4-A "PostHog properties
// to capture NOW ... hashed/bucketed, not raw PII"). IP is HASHED (never raw);
// country/region(colo)/asn are low-cardinality buckets safe to keep as-is. Salted
// so the hash isn't reversible to the raw IP across projects.
async function edgeCorrelation(
  req: Request | undefined,
): Promise<Record<string, unknown>> {
  if (!req) return {};
  try {
    const e = edgeCtx(req);
    const ipHash = e.ip ? (await sha256Hex(`avatok-liveness-v3:${e.ip}`)).slice(0, 32) : null;
    return {
      ip_hash: ipHash,
      country: e.country ?? null,
      colo: e.colo ?? null,
      asn: e.asn ?? null,
    };
  } catch {
    return {};
  }
}

// ── Session persisted shape (KV mirror of the D1 row for the hot verify path) ──
interface V3Session {
  sid: string;
  uid: string;
  policy_id: string;
  requester: string;
  nonce: string;
  challenges: string[];
  overlay: { shape: string; position: string; offset_x: number; offset_y: number; size_factor: number };
  capture_offsets: number[]; // 0..1 fractions of the clip to sample frames at
  // Server-randomized active probes (ruleset V3_1 — AI-avatar/second-phone
  // defense). flash_sequence (2–4 colored screen flashes), optional vibrate, and
  // one random gap per challenge. The client executes these; the verify pipeline
  // correlates the client-reported actuals (capture_meta) against them.
  active_checks: ActiveChecks;
  created_at: number;
}

// ── The queue message shape (shared with index.ts consumer) ───────────────────
export interface LivenessV3QueueMsg { v3: true; uid: string; sid: string; object_key?: string; }

// The verdict returned to the polling client + cached in KV.
export interface V3Result {
  verdict: Verdict;
  reason_codes: ReasonCode[];
  ruleset_version: string;
  attempts_remaining: number;
  level?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
//  POST /api/liveness/v3/session  — Policy-Engine entrypoint.
// ═══════════════════════════════════════════════════════════════════════════
export async function livenessV3Session(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);

  if (!(await v3Enabled(env))) {
    void telemetry(env, ctx.uid, "liveness_v3_session_blocked", { reason: "flag_off", status: 503 });
    metric(env, "liveness_v3_session_blocked", [1], ["flag_off"]);
    return json({ error: "liveness v3 disabled", reason: "flag_off" }, 503);
  }

  // Rate limit (fast-fail lane, plan §0-B.8): attempts/account/day → 429 + cooldown.
  const attempts = await attemptsLast24h(env, ctx.uid);
  if (attempts >= MAX_ATTEMPTS_24H) {
    void telemetry(env, ctx.uid, "liveness_v3_session_blocked", { reason: "rate_limited", status: 429 });
    metric(env, "liveness_v3_session_blocked", [1], ["rate_limited"]);
    return json({ error: "too many attempts", reason: "rate_limited", retry_after_hours: 24 }, 429);
  }

  const body = (await req.json().catch(() => ({}))) as { policy_id?: string; requester?: string };
  const requester = REQUESTERS.has(String(body.requester)) ? String(body.requester) : "onboarding";
  const policy_id = (typeof body.policy_id === "string" && body.policy_id.length <= 64 && body.policy_id)
    ? body.policy_id : "default";

  const sid = crypto.randomUUID();
  const nonce = crypto.randomUUID().replace(/-/g, "");
  // Randomized challenge subset + order (plan §0-B.1): 3–4 actions, shuffled.
  const count = 3 + randInt(2); // 3 or 4
  const challenges = pickN(CHALLENGE_ACTIONS, count);
  // Ensure COME_CLOSER is present so the approach-geometry motion check applies.
  if (!challenges.includes("COME_CLOSER")) challenges[randInt(challenges.length)] = "COME_CLOSER";

  const overlay = {
    shape: OVERLAY_SHAPES[randInt(OVERLAY_SHAPES.length)],
    position: OVERLAY_POSITIONS[randInt(OVERLAY_POSITIONS.length)],
    offset_x: Number(randFloat(-0.08, 0.08).toFixed(3)),
    offset_y: Number(randFloat(-0.08, 0.08).toFixed(3)),
    size_factor: Number(randFloat(0.85, 1.15).toFixed(3)),
  };
  // Randomized capture-frame offsets (plan §4-A.7): SAMPLE_FRAMES fractions in
  // [0.05, 0.95], sorted, jittered so a universal replay can't line up frames.
  const capture_offsets = Array.from({ length: SAMPLE_FRAMES }, () => Number(randFloat(0.05, 0.95).toFixed(3)))
    .sort((a, b) => a - b);

  // Server-randomized active probes (ruleset V3_1). Reuses the same crypto-random
  // source so the schedule is unpredictable per session (kills a universal replay).
  const active_checks = buildActiveChecks(challenges.length, { int: randInt, float: randFloat });

  const now = Date.now();
  const sess: V3Session = { sid, uid: ctx.uid, policy_id, requester, nonce, challenges, overlay, capture_offsets, active_checks, created_at: now };
  await env.TOKENS.put(sessionKvKey(ctx.uid, sid), JSON.stringify(sess), { expirationTtl: SESSION_TTL_S });

  // Persist the append-only session row (D1). status starts 'created'. active_checks
  // is stored so a verdict is reproducible against the exact schedule it faced.
  await metaDb(env).prepare(
    `INSERT INTO liveness_v3_sessions
       (session_id, uid, policy_id, requester, nonce, challenges, overlay, capture_offsets, active_checks, status, created_at, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'created',?10,?10)`,
  ).bind(
    sid, ctx.uid, policy_id, requester, nonce,
    JSON.stringify(challenges), JSON.stringify(overlay), JSON.stringify(capture_offsets),
    JSON.stringify(active_checks), now,
  ).run().catch(() => { /* KV mirror is authoritative on the hot path; D1 is the audit copy */ });

  void telemetry(env, ctx.uid, "liveness_v3_session_started", {
    session_id: sid, policy_id, requester, challenge_count: challenges.length, ruleset_version: RULESET,
  });
  metric(env, "liveness_v3_session", [1]);

  // Upload contract (plan §2 UPLOAD): presigned R2 PUT so the video never streams
  // through the Worker body. Falls back to the Worker-proxied part path if R2 S3
  // creds are unset (same fallback shape as olx.ts).
  const upload = await buildUploadContract(env, ctx.uid, sid);

  return json({
    session_id: sid,
    nonce,
    challenges,
    overlay,
    capture_offsets,
    active_checks,
    upload,
    max_video_bytes: MAX_VIDEO_BYTES,
    ttl_seconds: SESSION_TTL_S,
    ruleset_version: RULESET,
  });
}

// Presigned R2 PUT URL (preferred) or a Worker-proxied upload path (fallback).
async function buildUploadContract(env: Env, uid: string, sid: string): Promise<Record<string, unknown>> {
  const key = videoKey(uid, sid);
  if (env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY) {
    try {
      const url = await presignPutUrl({
        url: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/avatok-verification/${key}`,
        region: "auto", service: "s3",
        accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY,
        expiresSec: SESSION_TTL_S,
      });
      return { mode: "presigned_put", url, method: "PUT", object_key: key, max_bytes: MAX_VIDEO_BYTES };
    } catch { /* fall through to proxied path */ }
  }
  // Fallback: client PUTs the raw body to the Worker, which stores it in R2. Kept
  // for parity when R2 S3 creds are unset (dev/staging). Bytes DO pass through the
  // Worker here — the presigned path is the production path.
  return { mode: "worker_proxy", path: `/api/liveness/v3/upload?session=${sid}`, method: "PUT", object_key: key, max_bytes: MAX_VIDEO_BYTES };
}

// ═══════════════════════════════════════════════════════════════════════════
//  POST /api/liveness/v3/upload?session=<sid>  — fallback proxied upload only.
// ═══════════════════════════════════════════════════════════════════════════
export async function livenessV3Upload(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const u = new URL(req.url);
  const sid = u.searchParams.get("session") || "";
  if (!/^[0-9a-f-]{36}$/.test(sid)) return json({ error: "bad session" }, 400);
  const sess = await env.TOKENS.get(sessionKvKey(ctx.uid, sid));
  if (!sess) return json({ error: "session expired" }, 410);
  const body = await req.arrayBuffer();
  if (body.byteLength === 0 || body.byteLength > MAX_VIDEO_BYTES) return json({ error: "bad size" }, 413);
  await env.VERIFICATION.put(videoKey(ctx.uid, sid), body);
  return json({ ok: true, bytes: body.byteLength });
}

// ═══════════════════════════════════════════════════════════════════════════
//  POST /api/liveness/v3/verify {session_id, device_report?, client_sequence?}
//  → 202; the real work runs on the liveness-verify queue (or waitUntil fallback).
// ═══════════════════════════════════════════════════════════════════════════
export async function livenessV3Verify(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const auth = await requireUser(req, env);
  if (isFail(auth)) return json({ error: auth.error }, auth.status);

  const b = (await req.json().catch(() => ({}))) as {
    session_id?: string; object_key?: string; device_report?: unknown; client_sequence?: unknown;
    capture_meta?: unknown; frames?: unknown;
  };
  const sid = String(b.session_id || "");
  const sessRaw = await env.TOKENS.get(sessionKvKey(auth.uid, sid));
  if (!sessRaw) {
    void telemetry(env, auth.uid, "liveness_v3_verify_rejected", { reason: "session_expired", status: 410, session_id: sid });
    return json({ error: "session expired — start again" }, 410);
  }

  // Optional capture_meta (ruleset V3_1 — sensor/luma/flash/vibrate timelines +
  // device integrity). Size-capped ~32KB; reject an oversize payload POLITELY
  // (verify still runs without it — the defense layer degrades to null scores).
  const parsedMeta = parseCaptureMeta(b.capture_meta);
  if (parsedMeta.tooLarge) {
    void telemetry(env, auth.uid, "liveness_v3_verify_rejected", { reason: "capture_meta_too_large", status: 413, session_id: sid });
    return json({ error: "capture_meta too large — cap is 32KB", reason: "capture_meta_too_large" }, 413);
  }
  if (parsedMeta.meta) {
    await env.TOKENS.put(captureMetaKvKey(auth.uid, sid), JSON.stringify(parsedMeta.meta),
      { expirationTtl: SESSION_TTL_S }).catch(() => {});
  }

  // Interim client-supplied frames (plan §0-C "Interim frame path"): still JPEGs
  // captured at the session capture_offsets, uploaded in the verify body so the
  // pipeline has a frame set WITHOUT MEDIA_EXTRACT (which isn't bound yet). Bounded
  // to keep the base64 body <1MB; an oversize set is rejected POLITELY (verify still
  // runs and falls back to server extraction → EXTRACTION_FAILED/REVIEW).
  const parsedFrames = parseClientFrames(b);
  if (parsedFrames.tooLarge) {
    void telemetry(env, auth.uid, "liveness_v3_verify_rejected", { reason: "frames_too_large", status: 413, session_id: sid });
    return json({ error: "frames too large — cap is 6 × 200KB, <1MB total", reason: "frames_too_large" }, 413);
  }
  if (parsedFrames.frames.length > 0) {
    await env.TOKENS.put(clientFramesKvKey(auth.uid, sid), JSON.stringify(parsedFrames.frames),
      { expirationTtl: SESSION_TTL_S }).catch(() => {});
  }

  // Idempotency: a re-poll / double-tap returns the stored verdict, no re-run.
  const existing = await env.TOKENS.get(resultKvKey(auth.uid, sid), "json").catch(() => null);
  if (existing) return json({ status: "done", ...(existing as V3Result) }, 200);

  // Stash the device report + client-reported challenge sequence for the async
  // pipeline (both read from KV, not the request body — parity with V2 devauth).
  const devReport = deviceReportFromBody(b);
  const clientSeq = Array.isArray(b.client_sequence)
    ? (b.client_sequence as unknown[]).map(String).slice(0, 8) : null;
  await env.TOKENS.put(deviceRepKvKey(auth.uid, sid),
    JSON.stringify({ device: devReport, client_sequence: clientSeq }),
    { expirationTtl: SESSION_TTL_S }).catch(() => {});

  // Capture hashed edge/farm-correlation context HERE (the live request has cf.*);
  // the async pipeline (queue consumer) has no request, so it reads this from KV.
  const edgeCorr = await edgeCorrelation(req);
  await env.TOKENS.put(edgeCtxKvKey(auth.uid, sid), JSON.stringify(edgeCorr),
    { expirationTtl: SESSION_TTL_S }).catch(() => {});

  // frame_source on verify_start = which frame set the pipeline WILL use: the
  // interim client-supplied stills if present, else the server extractor. The
  // authoritative provenance is re-stamped on the verdict (extraction can still
  // fail server-side and fall back).
  const intendedFrameSource = parsedFrames.frames.length > 0 ? "client" : "server_extract";
  void telemetry(env, auth.uid, "liveness_verify_start", {
    session_id: sid, ruleset_version: RULESET, v3: true, frame_source: intendedFrameSource, ...edgeCorr,
  });
  // liveness_frames_uploaded {count, bytes, source} — one event per verify that
  // carried client frames (plan §4 telemetry). bytes = approx decoded JPEG total.
  if (parsedFrames.frames.length > 0) {
    const bytes = parsedFrames.frames.reduce((a, f) => a + Math.floor((f.jpeg_b64.length * 3) / 4), 0);
    void telemetry(env, auth.uid, "liveness_frames_uploaded", {
      session_id: sid, count: parsedFrames.frames.length, bytes, source: "client", v3: true,
    });
    metric(env, "liveness_frames_uploaded", [parsedFrames.frames.length, bytes], ["client"]);
  }

  // Prefer the shared liveness-verify queue (index.ts self-consumes); the {v3:true}
  // discriminator routes it to runLivenessV3Checks. Fall back to waitUntil on any
  // send() failure (queue not created / binding missing) — same pattern as V2.
  let queued = false;
  try {
    if (env.LIVENESS_QUEUE) {
      await env.LIVENESS_QUEUE.send({ v3: true, uid: auth.uid, sid, object_key: String(b.object_key || "") } as LivenessV3QueueMsg);
      queued = true;
    }
  } catch (e) {
    console.error("[livenessV3] queue send failed, waitUntil fallback:", String(e));
  }
  if (!queued) {
    const work = runLivenessV3Checks(env, auth.uid, sid, req).catch(async (e) => {
      console.error("[livenessV3] background verify failed:", String(e));
      void telemetry(env, auth.uid, "liveness_v3_verify_error", { session_id: sid, error: String(e).slice(0, 300) });
    });
    if (ctx) ctx.waitUntil(work); else await work;
  }
  return json({ status: "pending", session_id: sid }, 202);
}

// ═══════════════════════════════════════════════════════════════════════════
//  GET /api/liveness/v3/result?session=<sid>
// ═══════════════════════════════════════════════════════════════════════════
export async function livenessV3Result(req: Request, env: Env): Promise<Response> {
  const auth = await requireUser(req, env);
  if (isFail(auth)) return json({ error: auth.error }, auth.status);
  const u = new URL(req.url);
  const sid = u.searchParams.get("session") || "";
  if (!/^[0-9a-f-]{36}$/.test(sid)) return json({ error: "bad session" }, 400);
  const stored = await env.TOKENS.get(resultKvKey(auth.uid, sid), "json").catch(() => null);
  if (!stored) return json({ status: "pending" }, 200);
  return json({ status: "done", ...(stored as V3Result) }, 200);
}

// ── device_report (dark attestation hook — presence/length only for now) ──────
interface V3DeviceReport { platform?: "android" | "ios"; attestation_token?: string; }
function deviceReportFromBody(body: unknown): V3DeviceReport | undefined {
  const b = (body ?? {}) as Record<string, unknown>;
  const dr = b.device_report as Record<string, unknown> | undefined;
  if (!dr || typeof dr !== "object") return undefined;
  return {
    platform: dr.platform === "ios" ? "ios" : dr.platform === "android" ? "android" : undefined,
    attestation_token: typeof dr.attestation_token === "string" ? dr.attestation_token.slice(0, 4096) : undefined,
  };
}

// ── Interim client-supplied frames (plan §0-C "Interim frame path"). ──────────
// SECURITY: these are ATTACKER-CONTROLLABLE pre-attestation — the client can send
// any JPEGs it likes. They are accepted ONLY as an interim measure until the
// MEDIA_EXTRACT service binding exists (server-side decode is the hardened path).
// Every verdict computed from them is stamped frame_source:"client" for fraud
// analytics, and they are subject to the SAME defenses as extracted frames:
//   • per-frame content-hash dedupe (a set of identical/duplicated stills is a
//     tell — see runLivenessV3Checks §3b),
//   • CompareFaces consistency across frames + vs the account's existing proof,
//   • the avatar-defense display/timing/sensor/integrity signals,
//   • (future) Play Integrity attestation enforcement.
// Shape: [{t_offset_ms:int, jpeg_b64:string}]. Bounded to MAX_CLIENT_FRAMES,
// MAX_CLIENT_FRAME_BYTES each, MAX_CLIENT_FRAMES_TOTAL_BYTES combined.
interface ClientFrame { t_offset_ms: number; jpeg_b64: string; }
function parseClientFrames(body: unknown): { frames: ClientFrame[]; tooLarge: boolean } {
  const b = (body ?? {}) as Record<string, unknown>;
  const raw = b.frames;
  if (!Array.isArray(raw) || raw.length === 0) return { frames: [], tooLarge: false };
  const out: ClientFrame[] = [];
  let total = 0;
  for (const item of raw.slice(0, MAX_CLIENT_FRAMES)) {
    const o = (item ?? {}) as Record<string, unknown>;
    const b64 = typeof o.jpeg_b64 === "string" ? o.jpeg_b64 : "";
    if (!b64) continue;
    // base64 decoded size ≈ len * 3/4; reject an oversize single frame.
    const approxBytes = Math.floor((b64.length * 3) / 4);
    if (approxBytes > MAX_CLIENT_FRAME_BYTES) return { frames: [], tooLarge: true };
    total += approxBytes;
    if (total > MAX_CLIENT_FRAMES_TOTAL_BYTES) return { frames: [], tooLarge: true };
    const t = typeof o.t_offset_ms === "number" && isFinite(o.t_offset_ms) ? Math.max(0, Math.round(o.t_offset_ms)) : 0;
    out.push({ t_offset_ms: t, jpeg_b64: b64 });
  }
  return { frames: out, tooLarge: false };
}
// Decode a base64 JPEG to bytes (no data-URI prefix expected; strip one if present).
function decodeJpegB64(b64: string): Uint8Array {
  const clean = b64.includes(",") ? b64.slice(b64.indexOf(",") + 1) : b64;
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
//  runLivenessV3Checks — the async verify pipeline. Called from the queue
//  consumer (index.ts) AND the waitUntil fallback. Never throws to the caller.
// ═══════════════════════════════════════════════════════════════════════════
export async function runLivenessV3Checks(env: Env, uid: string, sid: string, req?: Request): Promise<V3Result> {
  const startedAt = Date.now();
  const finalize = async (
    verdict: Verdict, reasonCodes: ReasonCode[], level?: number,
  ): Promise<V3Result> => {
    const result: V3Result = {
      verdict, reason_codes: reasonCodes, ruleset_version: RULESET,
      attempts_remaining: Math.max(0, MAX_ATTEMPTS_24H - (await attemptsLast24h(env, uid))),
      ...(level != null ? { level } : {}),
    };
    await env.TOKENS.put(resultKvKey(uid, sid), JSON.stringify(result), { expirationTtl: RESULT_TTL_S }).catch(() => {});
    return result;
  };

  const sessRaw = await env.TOKENS.get(sessionKvKey(uid, sid));
  if (!sessRaw) {
    return finalize("REVIEW", ["EXTRACTION_FAILED"]);
  }
  const sess = JSON.parse(sessRaw) as V3Session;

  // Hashed edge/farm-correlation props captured at verify-enqueue time (the queue
  // consumer has no live request). Merged into every verdict telemetry event.
  const edgeCorr = await env.TOKENS.get(edgeCtxKvKey(uid, sid), "json").catch(() => null) as Record<string, unknown> | null;

  // Enqueue-time queue wait (telemetry) — created_at → now.
  const queueWaitMs = Date.now() - sess.created_at;

  // Interim client-supplied frames (plan §0-C). Loaded FIRST so we know whether we
  // even need the video object: on the interim path the frames carry the decision,
  // so an absent/late video no longer forces REVIEW. The video is still required
  // for the server-extract fallback path.
  const clientFramesRaw = await env.TOKENS.get(clientFramesKvKey(uid, sid), "json").catch(() => null) as ClientFrame[] | null;
  const haveClientFrames = !!clientFramesRaw && clientFramesRaw.length > 0;

  // ── 1. Load the video object. Missing → REVIEW UNLESS the interim client frames
  //    are present (then the video is optional). Never FAIL on our own problem. ──
  const key = videoKey(uid, sid);
  const obj = await env.VERIFICATION.get(key).catch(() => null);
  if (!obj && !haveClientFrames) {
    void verdictTelemetry(env, uid, sid, sess, "REVIEW", ["EXTRACTION_FAILED"], "none", 0, queueWaitMs, startedAt, false, edgeCorr, null, "none");
    await writeVerdictRow(env, uid, sess, "REVIEW", ["EXTRACTION_FAILED"], [], "none", 0, undefined, undefined, undefined, undefined, "none");
    await discardEvidence(env, uid, sid);
    await bumpAttempt(env, uid);
    return finalize("REVIEW", ["EXTRACTION_FAILED"]);
  }
  const bytes = obj ? new Uint8Array(await obj.arrayBuffer()) : new Uint8Array(0);

  // ── 2. Content-hash idempotency / replay dedupe (plan §3, failure runbook). ─
  // Hash the video object when present; otherwise (interim frames, no video) hash
  // the concatenated frame bytes so a replayed frame SET is still caught. Same hash
  // seen before (any user) → REPLAY_ATTACK with NO Rekognition spend.
  let hashInput = bytes;
  if (bytes.byteLength === 0 && haveClientFrames) {
    try {
      const parts = clientFramesRaw!.map((f) => decodeJpegB64(f.jpeg_b64));
      let total = 0; for (const p of parts) total += p.byteLength;
      const merged = new Uint8Array(total); let off = 0;
      for (const p of parts) { merged.set(p, off); off += p.byteLength; }
      hashInput = merged;
    } catch { /* fall back to empty — dedupe skipped */ }
  }
  const hash = await sha256Hex(hashInput);
  let replaySeen = false;
  try {
    const seen = await metaSession(env)
      .prepare("SELECT session_id FROM liveness_v3_hashes WHERE content_hash=?1 LIMIT 1")
      .bind(hash).first<{ session_id: string }>();
    if (seen && seen.session_id !== sid) replaySeen = true;
    if (!replaySeen && hashInput.byteLength > 0) {
      await metaDb(env).prepare(
        "INSERT OR IGNORE INTO liveness_v3_hashes (content_hash, uid, session_id, created_at) VALUES (?1,?2,?3,?4)",
      ).bind(hash, uid, sid, Date.now()).run();
    }
  } catch { /* dedupe DB miss is non-fatal — proceed (fail-open on the dedupe read) */ }

  if (replaySeen) {
    const v = evaluateV3({
      frames: [], replayHashSeen: true, extractionFailed: false, attestationOk: null,
      sequenceMatched: null, sameFaceOk: null, motionMonotonicOk: null, anyProviderDegraded: false,
    });
    void verdictTelemetry(env, uid, sid, sess, v.verdict, v.reason_codes, "none", 0, queueWaitMs, startedAt, true, edgeCorr, null, haveClientFrames ? "client" : "none");
    await writeVerdictRow(env, uid, sess, v.verdict, v.reason_codes, v.rule_pass_map, "none", 0, undefined, undefined, undefined, undefined, haveClientFrames ? "client" : "none");
    // [LIVE-RETAIN-1] FAIL (replay attack) → delete the clip immediately.
    await discardEvidence(env, uid, sid);
    await bumpAttempt(env, uid);
    return finalize(v.verdict, v.reason_codes);
  }

  // ── 3. Obtain the frame set. Two paths, in priority order:
  //    (a) INTERIM CLIENT PATH (plan §0-C "Interim frame path"): the client
  //        uploaded still JPEGs at the session capture_offsets in the verify body.
  //        We use them directly and SKIP MEDIA_EXTRACT. Provenance is stamped
  //        frame_source:"client" on the verdict — these are attacker-controllable
  //        pre-attestation, mitigated by the per-frame content-hash dedupe below,
  //        CompareFaces consistency (§5), and the avatar-defense signals (§9).
  //    (b) SERVER EXTRACT (LONG-TERM HARDENED PATH — keep intact): decode frames
  //        from the MP4 via the MEDIA_EXTRACT service binding. Until that binding
  //        exists this throws → EXTRACTION_FAILED → REVIEW (never a false FAIL).
  //    The poison-pill quarantine only guards the server decode path (a client
  //    frame set can't crash the decoder).
  let frameSource: "client" | "server_extract" | "none" = "none";
  let extractionFailed = false;
  let frameBufs: Uint8Array[] = [];

  if (haveClientFrames) {
    // ── 3a. Interim client frame path. ──
    try {
      frameBufs = clientFramesRaw!
        .map((f) => decodeJpegB64(f.jpeg_b64))
        .filter((u) => u.byteLength > 0 && u.byteLength <= MAX_CLIENT_FRAME_BYTES)
        .slice(0, MAX_CLIENT_FRAMES);
    } catch { frameBufs = []; }
    if (frameBufs.length === 0) {
      extractionFailed = true;
    } else {
      frameSource = "client";
      // Per-frame content-hash dedupe (reuse the content-hash pattern): a set of
      // byte-identical stills means the "frames" are one image copied N times — a
      // strong replay/2D tell. Collapse duplicates; if <2 unique frames remain we
      // can't run the cross-frame consistency checks, so treat as extraction-poor.
      const seenHashes = new Set<string>();
      const unique: Uint8Array[] = [];
      let dupCount = 0;
      for (const fb of frameBufs) {
        const h = await sha256Hex(fb);
        if (seenHashes.has(h)) { dupCount++; continue; }
        seenHashes.add(h);
        unique.push(fb);
      }
      if (dupCount > 0) {
        void telemetry(env, uid, "liveness_spoof_signal", { session_id: sid, signal: "client_frame_duplicate", dup_count: dupCount, frame_source: "client" });
      }
      void telemetry(env, uid, "liveness_frames_uploaded", {
        session_id: sid, count: frameBufs.length, unique: unique.length,
        bytes: frameBufs.reduce((a, u) => a + u.byteLength, 0), source: "client", stage: "consumed", v3: true,
      });
      frameBufs = unique;
      if (frameBufs.length === 0) extractionFailed = true;
    }
  } else {
    // ── 3b. Server extract path (poison-pill guarded). ──
    const quarantineKey = `livenessv3:quarantine:${uid}:${sid}`;
    const quarantined = await env.TOKENS.get(quarantineKey).catch(() => null);
    if (quarantined) {
      extractionFailed = true;
    } else {
      try {
        frameBufs = await extractFrames(env, bytes, sess.capture_offsets);
        if (frameBufs.length === 0) throw new Error("no_frames_extracted");
        frameSource = "server_extract";
      } catch (e) {
        extractionFailed = true;
        // First failure → quarantine so retries skip decode (never re-crash).
        await env.TOKENS.put(quarantineKey, "1", { expirationTtl: SESSION_TTL_S }).catch(() => {});
        void telemetry(env, uid, "liveness_spoof_signal", { session_id: sid, signal: "extraction_failed", error: String(e).slice(0, 200) });
      }
    }
  }

  if (extractionFailed) {
    const v = evaluateV3({
      frames: [], replayHashSeen: false, extractionFailed: true, attestationOk: null,
      sequenceMatched: null, sameFaceOk: null, motionMonotonicOk: null, anyProviderDegraded: false,
    });
    void verdictTelemetry(env, uid, sid, sess, v.verdict, v.reason_codes, "none", 0, queueWaitMs, startedAt, false, edgeCorr, null, "none");
    await writeVerdictRow(env, uid, sess, v.verdict, v.reason_codes, v.rule_pass_map, "none", 0, undefined, undefined, undefined, undefined, "none");
    await tagAndDiscard(env, uid, sid, "review");
    await bumpAttempt(env, uid);
    return finalize(v.verdict, v.reason_codes);
  }

  // ── 4. Provider normalization per frame (breaker: Rekognition → Workers AI). ─
  const cfg = await readConfig(env);
  const useRek = rekognitionConfigured(env);
  let anyDegraded = false;
  let rekCalls = 0;
  const frames: FrameEvidence[] = [];
  let providerName: "aws_rekognition" | "workers_ai" | "mixed" | "none" = useRek ? "aws_rekognition" : "workers_ai";

  for (const fb of frameBufs) {
    let normalized;
    let degraded = false;
    if (useRek) {
      try {
        const raw = await detectFaces(env, fb);
        rekCalls++;
        normalized = normalizeRekognition(raw);
      } catch (e) {
        // Breaker: 429 / outage → degrade to Workers AI face-present, mark degraded.
        if (isRekognitionQuotaOrOutage(e)) {
          anyDegraded = true; degraded = true;
          void telemetry(env, uid, "liveness_spoof_signal", { session_id: sid, signal: "provider_degraded", provider: "aws_rekognition" });
          const faceFound = await workersAiFacePresent(env, fb).catch(() => false);
          normalized = normalizeWorkersAiFace(faceFound);
        } else {
          // Non-quota Rekognition error on a single frame → treat that frame as
          // degraded (skip its quality), don't fail the whole verify.
          anyDegraded = true; degraded = true;
          normalized = normalizeWorkersAiFace(false);
        }
      }
    } else {
      // No AWS creds at all → Workers AI face-present only (whole verify degraded).
      anyDegraded = true; degraded = true;
      const faceFound = await workersAiFacePresent(env, fb).catch(() => false);
      normalized = normalizeWorkersAiFace(faceFound);
    }
    frames.push({ normalized, degraded });
  }
  if (anyDegraded && useRek) providerName = "mixed";
  else if (!useRek) providerName = "workers_ai";

  // ── 5. Face consistency (CompareFaces across frames + vs existing proof). ────
  let sameFaceOk: boolean | null = null;
  if (useRek && !anyDegraded && frameBufs.length >= 2 && cfg.livenessUseRekognition !== false) {
    try {
      // Same person across the first + last approach frame.
      const { similarity } = await compareFaces(env, frameBufs[0], frameBufs[frameBufs.length - 1], 80);
      rekCalls++;
      sameFaceOk = similarity >= 90;
      // vs existing account proof (thumbnail) if present — reuse V2's evidence_ref.
      const proof = await metaSession(env)
        .prepare("SELECT evidence_ref FROM identity_proofs WHERE uid=?1 AND proof='liveness' AND status='verified' LIMIT 1")
        .bind(uid).first<{ evidence_ref: string }>();
      if (sameFaceOk && proof?.evidence_ref) {
        const ref = await env.VERIFICATION.get(proof.evidence_ref).catch(() => null);
        if (ref) {
          const refBytes = new Uint8Array(await ref.arrayBuffer());
          const cmp = await compareFaces(env, refBytes, frameBufs[0], 80);
          rekCalls++;
          sameFaceOk = cmp.similarity >= 90;
        }
      }
    } catch (e) {
      // CompareFaces throttle/error → don't punish; leave null (skipped).
      if (isRekognitionQuotaOrOutage(e)) anyDegraded = true;
      sameFaceOk = null;
    }
  }

  // ── 6. Motion consistency (pure math on the approach frames). ───────────────
  const motionOk = motionMonotonic(frames);

  // ── 7. Challenge sequence (client-reported order vs the issued challenges). ─
  let sequenceMatched: boolean | null = null;
  try {
    const stash = await env.TOKENS.get(deviceRepKvKey(uid, sid), "json").catch(() => null) as
      { device?: V3DeviceReport; client_sequence?: string[] } | null;
    if (stash?.client_sequence && stash.client_sequence.length) {
      sequenceMatched = arraysEqual(stash.client_sequence.map((s) => s.toUpperCase()), sess.challenges);
    }
  } catch { /* leave null → rule skipped */ }

  // ── 8. Deterministic core verdict (LLM-free). ──────────────────────────────
  const v = evaluateV3({
    frames,
    replayHashSeen: false,
    extractionFailed: false,
    attestationOk: null,      // [LIVE-ATTEST-1] real attestation is a later phase
    sequenceMatched,
    sameFaceOk,
    motionMonotonicOk: motionOk,
    anyProviderDegraded: anyDegraded,
  });

  // ── 9. AI-avatar / second-phone / injected-camera defense (ruleset V3_1). ───
  // Weighted suspicion SIGNALS — never a standalone FAIL. A high combined score,
  // a hard camera-path compromise, a flash/sensor/timing mismatch → escalate the
  // verdict to REVIEW (only if the core didn't already FAIL). All emitted codes
  // are REVIEW-class or informational.
  const capMeta = await env.TOKENS.get(captureMetaKvKey(uid, sid), "json").catch(() => null) as CaptureMeta | null;
  const defense = evaluateAvatarDefense(frames, sess.active_checks ?? null, capMeta);

  // ── 10. Device-binding evidence (informational; Trust Engine consumes later). ─
  // Compare this verify's device context + IP country against the account's last
  // PASS verdict. New device + new country within a short window → DEVICE_CONTEXT_
  // CHANGED. This NEVER blocks — it rides on the verdict + telemetry only.
  const deviceCtx = await deviceContextEvidence(env, uid, sess, capMeta, edgeCorr);
  if (deviceCtx.changed) defense.review_codes.push("DEVICE_CONTEXT_CHANGED");

  // Merge the defense codes into the final verdict. Core FAIL stays FAIL (spoof/
  // quality is decisive); otherwise any REVIEW-class defense code lifts PASS/REVIEW
  // to REVIEW. DEVICE_CONTEXT_CHANGED is informational and does NOT change verdict.
  const reviewClass = defense.review_codes.filter((c) => c !== "DEVICE_CONTEXT_CHANGED");
  let finalVerdict: Verdict = v.verdict;
  if (finalVerdict !== "FAIL" && reviewClass.length > 0) finalVerdict = "REVIEW";
  const mergedCodes = uniqCodes([...v.reason_codes, ...(defense.review_codes as ReasonCode[])]);

  const costUsd = Number((rekCalls * REK_COST_PER_IMAGE).toFixed(4));
  await writeVerdictRow(env, uid, sess, finalVerdict, mergedCodes, v.rule_pass_map, providerName, costUsd, defense, capMeta, deviceCtx.changed, edgeCorr, frameSource);
  await bumpAttempt(env, uid);
  void verdictTelemetry(env, uid, sid, sess, finalVerdict, mergedCodes, providerName, costUsd, queueWaitMs, startedAt, false, edgeCorr, defense, frameSource);
  // Surface any spoof signal codes as their own telemetry event (plan §4).
  for (const c of v.reason_codes) {
    if (c === "PHONE_SCREEN" || c === "REPLAY_ATTACK" || c === "MOTION_IMPLAUSIBLE" || c === "MULTIPLE_PEOPLE") {
      void telemetry(env, uid, "liveness_spoof_signal", { session_id: sid, signal: c });
    }
  }
  // Rich per-signal defense telemetry (plan §0-C / §4-A).
  void emitDefenseTelemetry(env, uid, sid, sess, defense, capMeta, deviceCtx);

  if (finalVerdict === "PASS") {
    // Retain ONLY the reference (sharpest) frame as frame0.jpg (green-tick thumb),
    // tag pass, delete the raw video (R2 lifecycle pass=24h on the retained still).
    const thumbKey = await retainPassEvidence(env, uid, sid, frameBufs, frames);
    await recordLivenessAudit(env, { uid, provider: "workersai", status: "pass", req, device: deviceCtxFromBody({}), r2Prefix: auditPrefix(uid, sid) });
    await applyPassToLadder(env, uid, sid, thumbKey, sess);
    return finalize("PASS", mergedCodes, 2);
  }

  // [LIVE-RETAIN-1] FAIL → delete the clip IMMEDIATELY (no 7d grace, nothing
  // rejected is ever stored — a no-face/black/abusive clip must not sit in R2).
  // REVIEW → keep 7d with the review tag; a human decision NEEDS the evidence.
  await recordLivenessAudit(env, { uid, provider: "workersai", status: finalVerdict === "FAIL" ? "fail" : "abandoned", req, device: deviceCtxFromBody({}), r2Prefix: null });
  if (finalVerdict === "FAIL") {
    await discardEvidence(env, uid, sid);
  } else {
    await tagAndDiscard(env, uid, sid, "review");
  }
  return finalize(finalVerdict, mergedCodes);
}

function uniqCodes(a: ReasonCode[]): ReasonCode[] { return [...new Set(a)]; }

// ── Device-binding evidence (plan §0-C.6). Informational only — never blocks. ──
// A PASS "green tick" from a new device in a new country within a short window is
// a Trust-Engine signal (account takeover / farm), not a liveness FAIL. We compare
// against the account's LAST verdict row (device model + IP country captured then).
interface DeviceContextEvidence { changed: boolean; new_device: boolean; new_country: boolean; }
async function deviceContextEvidence(
  env: Env, uid: string, sess: V3Session, capMeta: CaptureMeta | null, edgeCorr: Record<string, unknown> | null,
): Promise<DeviceContextEvidence> {
  try {
    const curCountry = (edgeCorr?.country as string | null) ?? null;
    const curDevice = capMeta?.camera?.model || null;
    // Last verdict for this account (any outcome) carries the prior context props.
    const last = await metaSession(env)
      .prepare(
        `SELECT camera_path, created_at FROM liveness_v3_verdicts
          WHERE uid=?1 AND camera_path IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
      ).bind(uid).first<{ camera_path: string; created_at: number }>();
    if (!last) return { changed: false, new_device: false, new_country: false };
    // The prior device/country live on the last verdict's stored capture context.
    let priorCountry: string | null = null; let priorDevice: string | null = null;
    try {
      const cp = JSON.parse(last.camera_path) as { _ctx_country?: string | null; _ctx_device?: string | null };
      priorCountry = cp._ctx_country ?? null; priorDevice = cp._ctx_device ?? null;
    } catch { /* prior row predates ctx capture — treat as unknown, no change */ }
    const WINDOW = 7 * DAY; // "short window" for takeover/farm correlation
    const recent = Date.now() - (last.created_at ?? 0) <= WINDOW;
    const new_country = !!priorCountry && !!curCountry && priorCountry !== curCountry;
    const new_device = !!priorDevice && !!curDevice && priorDevice !== curDevice;
    return { changed: recent && new_country && new_device, new_device, new_country };
  } catch {
    return { changed: false, new_device: false, new_country: false };
  }
}

// ── Frame extraction (LONG-TERM HARDENED PATH — keep intact). ─────────────────
// This is the server-side, NON-attacker-controllable frame path. It stays the
// production target; the interim client-frame path (parseClientFrames + §3a in
// runLivenessV3Checks) is a stopgap ONLY until MEDIA_EXTRACT is bound. Do NOT
// delete this or its TODO when wiring the interim path.
// NOTE (owner gap): the Workers runtime cannot decode H.264/MP4 in-process. In
// production, frame extraction runs in a Cloudflare Container / media Worker (plan
// §3 "frame extraction in a Cloudflare Container/Workers"). Until that binding
// exists, we attempt an optional MEDIA service binding; if absent, extraction
// "fails" cleanly → the pipeline records EXTRACTION_FAILED → REVIEW (never a false
// FAIL). This keeps the whole V3 path safe to ship DARK behind the flag.
async function extractFrames(env: Env, video: Uint8Array, offsets: number[]): Promise<Uint8Array[]> {
  const media = (env as { MEDIA_EXTRACT?: { fetch: (r: Request) => Promise<Response> } }).MEDIA_EXTRACT;
  if (!media) {
    // No extractor bound yet — signal extraction unavailable so the caller records
    // EXTRACTION_FAILED → REVIEW. (Do NOT fabricate frames.)
    throw new Error("media_extract_unbound");
  }
  const res = await media.fetch(new Request("https://internal/extract", {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "x-offsets": offsets.join(",") },
    body: video.buffer.slice(0) as ArrayBuffer,
  }));
  if (!res.ok) throw new Error(`media_extract_${res.status}`);
  // Expect a JSON array of base64 JPEG frames.
  const arr = (await res.json()) as string[];
  return arr.map((b64) => {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  });
}

// Workers AI face-present fallback (breaker path only). One LLaVA yes/no — used
// solely to confirm "a face is present" when Rekognition is unavailable; the
// verdict still degrades to REVIEW (never a PASS on the fallback alone).
async function workersAiFacePresent(env: Env, image: Uint8Array): Promise<boolean> {
  try {
    const r: any = await env.AI.run(
      "@cf/llava-hf/llava-1.5-7b-hf" as any,
      { image: [...image], prompt: "Is there exactly one real human face in this photo? Answer only YES or NO.", max_tokens: 8 } as any,
    );
    return String(r?.description ?? r?.response ?? "").trim().toUpperCase().startsWith("YES");
  } catch { return false; }
}

// ── Pass → ladder wiring (reuse V2's identity_proofs + invalidateLevelCache). ──
async function applyPassToLadder(env: Env, uid: string, sid: string, thumbKey: string, sess: V3Session): Promise<void> {
  const now = Date.now();
  try {
    await metaDb(env).batch([
      metaDb(env).prepare("UPDATE verification_status SET status='verified', verified_at=?2, updated_at=?2 WHERE uid=?1").bind(uid, now),
      metaDb(env).prepare(
        `INSERT INTO kyc_status (uid, status, provider, verified_at, updated_at)
         VALUES (?1,'verified','liveness_v3',?2,?2)
         ON CONFLICT(uid) DO UPDATE SET status='verified', provider='liveness_v3', verified_at=?2, updated_at=?2`,
      ).bind(uid, now),
      metaDb(env).prepare(
        `INSERT INTO identity_proofs (uid, proof, status, provider, evidence_ref, verified_at, updated_at)
         VALUES (?1,'liveness','verified','liveness_v3',?2,?3,?3)
         ON CONFLICT(uid, proof) DO UPDATE SET status='verified', provider='liveness_v3', evidence_ref=?2, verified_at=?3, updated_at=?3`,
      ).bind(uid, thumbKey, now),
    ]);
  } catch { /* best-effort — the verdict row + KV result are the source of truth */ }
  await setVerifiedCache(env, uid, true).catch(() => {});
  await invalidateLevelCache(env, uid).catch(() => {}); // KNOWN-missing-piece fix: always invalidate after write
  // Guardian gate hand-off (dark; no-op when guardianGateEnabled is off). Liveness
  // ONLY emits this signal — it never reads/writes Guardian state (strict boundary).
  void markGatePassed(env, uid);
  brainFact(env, uid, "identity_verified", "avaid", { method: "liveness_v3", requester: sess.requester, at: now });
  try {
    await notifyUser(env, uid, { type: "system", title: "You're verified ✓", body: "Your identity check passed.", data: { deeplink: "/identity" } });
  } catch { /* best-effort */ }
}

// ── Append-only verdict row (never update-in-place). ──────────────────────────
// The last 3 args are the ruleset-V3_1 avatar-defense signals + the raw
// capture_meta + the device-context-changed flag. They are OPTIONAL so the early
// bail-out callsites (missing video / replay / extraction failure) can write a
// verdict row without them — the columns default NULL for those rows.
async function writeVerdictRow(
  env: Env, uid: string, sess: V3Session, verdict: Verdict, reasonCodes: ReasonCode[],
  rulePassMap: unknown[], provider: string, costUsd: number,
  defense?: AvatarDefenseSignals, capMeta?: CaptureMeta | null, deviceContextChanged?: boolean,
  edgeCorr?: Record<string, unknown> | null,
  // Provenance of the frame set this verdict was computed on (plan §0-C interim
  // frame path): "client" = attacker-controllable client stills, "server_extract"
  // = MEDIA_EXTRACT decode, "none" = no frames (early bail-outs). Load-bearing for
  // fraud analytics — segment PASS rates by provenance.
  frameSource?: "client" | "server_extract" | "none",
): Promise<void> {
  try {
    // Stash the device+country context ON the camera_path JSON so a FUTURE verify's
    // deviceContextEvidence() can compare against it (no schema churn for 2 fields).
    let cameraPathJson: string | null = null;
    if (defense) {
      cameraPathJson = JSON.stringify({
        ...defense.camera_path,
        _ctx_country: (edgeCorr?.country as string | null) ?? null,
        _ctx_device: capMeta?.camera?.model || null,
      });
    }
    await metaDb(env).prepare(
      `INSERT INTO liveness_v3_verdicts
        (id, session_id, uid, verdict, reason_codes, rule_pass_map, ruleset_version,
         provider, provider_version, cost_usd_estimate, requester, policy_id, created_at,
         display_suspicion_score, flash_correlation_score, sensor_correlation_score,
         display_signals, camera_path, timing_anomaly, policy_escalation,
         device_context_changed, capture_meta, frame_source)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,
               ?14,?15,?16,?17,?18,?19,?20,?21,?22,?23)`,
    ).bind(
      crypto.randomUUID(), sess.sid, uid, verdict, JSON.stringify(reasonCodes),
      JSON.stringify(rulePassMap), RULESET, provider,
      provider === "aws_rekognition" || provider === "mixed" ? "detectfaces-2016-06-27" : "workers_ai",
      costUsd, sess.requester, sess.policy_id, Date.now(),
      defense?.display_suspicion_score ?? null,
      defense?.flash_correlation_score ?? null,
      defense?.sensor_correlation_score ?? null,
      defense ? JSON.stringify(defense.display_signals) : null,
      cameraPathJson,
      defense ? (defense.timing_anomaly ? 1 : 0) : null,
      defense ? (defense.policy_escalation ? 1 : 0) : null,
      deviceContextChanged != null ? (deviceContextChanged ? 1 : 0) : null,
      capMeta ? JSON.stringify(capMeta).slice(0, 32_768) : null,
      frameSource ?? null,
    ).run();
    // Advance the session row status (append-only verdicts; session row tracks state).
    await metaDb(env).prepare("UPDATE liveness_v3_sessions SET status=?2, updated_at=?3 WHERE session_id=?1")
      .bind(sess.sid, verdict.toLowerCase(), Date.now()).run();
  } catch { /* best-effort — KV result is what the client polls */ }
}

// ── Telemetry helpers (email + phone stamped, plan §4). ───────────────────────
function telemetry(env: Env, uid: string, event: string, props: Record<string, unknown>): Promise<void> {
  return contactFor(env, uid)
    .then(({ email, phone }) => trackUserContact(env, uid, email, phone, event, "avaid", props))
    .catch(() => Promise.resolve());
}
function verdictTelemetry(
  env: Env, uid: string, sid: string, sess: V3Session, verdict: Verdict, reasonCodes: ReasonCode[],
  provider: string, costUsd: number, queueWaitMs: number, startedAt: number, replay = false,
  edgeCorr: Record<string, unknown> | null = null, defense: AvatarDefenseSignals | null = null,
  frameSource: "client" | "server_extract" | "none" = "none",
): Promise<void> {
  metric(env, "liveness_v3_verdict", [costUsd, Date.now() - startedAt], [verdict, frameSource]);
  return telemetry(env, uid, "liveness_verdict", {
    session_id: sid, verdict, reason_codes: reasonCodes, provider, frame_source: frameSource,
    cost_usd: costUsd, queue_wait_ms: queueWaitMs, duration_ms: Date.now() - startedAt,
    requester: sess.requester, policy_id: sess.policy_id, ruleset_version: RULESET,
    replay, v3: true, ...(edgeCorr ?? {}),
    // Ruleset-V3_1 avatar-defense summary on the core verdict event (plan §0-C.8).
    ...(defense ? {
      display_suspicion_score: defense.display_suspicion_score,
      flash_correlation_score: defense.flash_correlation_score,
      sensor_correlation_score: defense.sensor_correlation_score,
      timing_anomaly: defense.timing_anomaly,
      policy_escalation: defense.policy_escalation,
      integrity_rooted: defense.camera_path.rooted,
      integrity_emulator: defense.camera_path.emulator,
      integrity_virtual_camera: defense.camera_path.virtual_camera,
      integrity_instrumentation: defense.camera_path.instrumentation,
      integrity_play_integrity: defense.camera_path.play_integrity,
      integrity_compromised: defense.camera_path.compromised,
      defense_codes: defense.review_codes,
      weights_version: defense.weights_version,
    } : {}),
  });
}

// ── Rich avatar-defense telemetry (plan §0-C.8). Separate events for the active
//    checks, each weighted display signal, the camera-path integrity, and the
//    device-context comparison — all email/phone-stamped via telemetry(). ────────
function emitDefenseTelemetry(
  env: Env, uid: string, sid: string, sess: V3Session, defense: AvatarDefenseSignals,
  capMeta: CaptureMeta | null, deviceCtx: DeviceContextEvidence,
): void {
  // liveness_active_check — one per scheduled active probe (flash, then vibrate).
  const flashes = sess.active_checks?.flash_sequence ?? [];
  const flashEvents = capMeta?.flash_events ?? [];
  flashes.forEach((f, i) => {
    void telemetry(env, uid, "liveness_active_check", {
      session_id: sid, check: "flash",
      scheduled: f.t_offset_ms, actual: flashEvents[i]?.t_actual_ms ?? null,
      correlation_score: defense.flash_correlation_score, color: f.color, v3: true,
    });
  });
  if (sess.active_checks?.vibrate) {
    void telemetry(env, uid, "liveness_active_check", {
      session_id: sid, check: "vibrate",
      scheduled: sess.active_checks.vibrate.t_offset_ms,
      actual: capMeta?.vibrate_event?.t_actual_ms ?? null,
      correlation_score: null, v3: true,
    });
  }
  // liveness_display_signal — one per weighted display signal (value/weight/total).
  for (const s of defense.display_signals) {
    void telemetry(env, uid, "liveness_display_signal", {
      session_id: sid, signal: s.signal, value: s.value, weight: s.weight,
      score_total: defense.display_suspicion_score, v3: true,
    });
  }
  // liveness_camera_path — the device-integrity summary (verbatim play_integrity).
  void telemetry(env, uid, "liveness_camera_path", {
    session_id: sid,
    rooted: defense.camera_path.rooted, emulator: defense.camera_path.emulator,
    virtual_camera: defense.camera_path.virtual_camera, instrumentation: defense.camera_path.instrumentation,
    play_integrity: defense.camera_path.play_integrity, compromised: defense.camera_path.compromised, v3: true,
  });
  // liveness_device_context — informational new-device / new-country signal.
  void telemetry(env, uid, "liveness_device_context", {
    session_id: sid, changed: deviceCtx.changed, new_country: deviceCtx.new_country,
    new_device: deviceCtx.new_device, v3: true,
  });
}

// ── R2 evidence handling + lifecycle tags (plan §5). ──────────────────────────
// Tag objects by verdict state so the wrangler R2 lifecycle rules can expire them
// (pass 24h / fail 7d). R2 object customMetadata is set on write via put(...,
// { customMetadata }). We re-put the retained still with the pass tag.
async function retainPassEvidence(env: Env, uid: string, sid: string, frameBufs: Uint8Array[], frames: FrameEvidence[]): Promise<string> {
  const retainedPrefix = auditPrefix(uid, sid);
  const thumbKey = retainedPrefix + "frame0.jpg";
  // Pick the sharpest measured frame as the thumbnail.
  let bestIdx = 0, bestSharp = -1;
  frames.forEach((f, i) => { if (f.normalized.sharpness > bestSharp) { bestSharp = f.normalized.sharpness; bestIdx = i; } });
  const thumb = frameBufs[bestIdx] ?? frameBufs[0];
  try {
    if (thumb) {
      await env.VERIFICATION.put(thumbKey, thumb, {
        customMetadata: { liveness_verdict: "pass", retain: "24h", ruleset: RULESET },
      });
    }
  } catch { /* best-effort */ }
  // [LIVE-RETAIN-1] (owner decision 2026-07-09) INVERTED retention: PASS clips
  // are KEPT (moved to the audit prefix) so a human can spot-review verified
  // accounts later; FAIL clips are deleted immediately (see the FAIL branch).
  // The old policy deleted the clip on pass and kept it 7d on fail — exactly
  // backwards for auditability, and it left rejected (possibly abusive) footage
  // sitting in R2.
  try {
    const raw = await env.VERIFICATION.get(videoKey(uid, sid)).catch(() => null);
    if (raw) {
      await env.VERIFICATION.put(retainedPrefix + "video.mp4", await raw.arrayBuffer(), {
        customMetadata: { liveness_verdict: "pass", retain: "review", ruleset: RULESET },
      });
    }
  } catch { /* best-effort — the thumb + verdict row still exist */ }
  // Delete the transient upload prefix + session KV (the retained copy lives
  // under the audit prefix now).
  await discardEvidence(env, uid, sid);
  return thumbKey;
}
// Delete every transient upload object for the session + clear session KV.
async function discardEvidence(env: Env, uid: string, sid: string): Promise<void> {
  try {
    const listing = await env.VERIFICATION.list({ prefix: uploadPrefix(uid, sid) });
    for (const o of listing.objects ?? []) { try { await env.VERIFICATION.delete(o.key); } catch { /* */ } }
  } catch { /* best-effort */ }
  try { await env.TOKENS.delete(sessionKvKey(uid, sid)); } catch { /* */ }
  try { await env.TOKENS.delete(deviceRepKvKey(uid, sid)); } catch { /* */ }
  try { await env.TOKENS.delete(edgeCtxKvKey(uid, sid)); } catch { /* */ }
  try { await env.TOKENS.delete(captureMetaKvKey(uid, sid)); } catch { /* */ }
  try { await env.TOKENS.delete(clientFramesKvKey(uid, sid)); } catch { /* */ }
}
// Fail/review: tag the video with the verdict retention window, THEN discard the
// transient copy. (For fail we could keep 7d for appeal; here we tag then rely on
// the R2 lifecycle rule to expire — see Specs/WRANGLER-ADDITIONS.md. We discard
// the transient upload prefix regardless to avoid unbounded growth at 1M/day.)
async function tagAndDiscard(env: Env, uid: string, sid: string, state: "fail" | "review"): Promise<void> {
  try {
    const key = videoKey(uid, sid);
    const obj = await env.VERIFICATION.get(key).catch(() => null);
    if (obj) {
      // Re-put with the retention tag so lifecycle expires it (fail 7d).
      await env.VERIFICATION.put(key, await obj.arrayBuffer(), {
        customMetadata: { liveness_verdict: state, retain: "7d", ruleset: RULESET },
      }).catch(() => {});
    }
  } catch { /* best-effort */ }
  // Clear session KV; leave the tagged video for the lifecycle rule to reap.
  try { await env.TOKENS.delete(sessionKvKey(uid, sid)); } catch { /* */ }
  try { await env.TOKENS.delete(deviceRepKvKey(uid, sid)); } catch { /* */ }
  try { await env.TOKENS.delete(edgeCtxKvKey(uid, sid)); } catch { /* */ }
  try { await env.TOKENS.delete(captureMetaKvKey(uid, sid)); } catch { /* */ }
  try { await env.TOKENS.delete(clientFramesKvKey(uid, sid)); } catch { /* */ }
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
