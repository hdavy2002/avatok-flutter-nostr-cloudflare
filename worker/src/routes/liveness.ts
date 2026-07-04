// L2 liveness — Workers AI provider (third provider beside Rekognition + Stripe;
// see PROPOSAL-PROGRESSIVE-IDENTITY.md §5). Random challenge → client records a
// 5–10 s selfie clip, captures challenge frames, uploads both → Workers AI
// verifies (vision per frame + Whisper on the clip audio for the spoken phrase).
// PASS → kyc_status('verified','workersai_liveness') exactly like Rekognition.
//
// OWNER DECISION 2026-07-03 (STREAM H, D15 — "STORE EVERYTHING"): this REVERSES
// the old delete-on-pass/fail behaviour. On BOTH pass and fail we now MOVE the
// frames + clip into the retained audit prefix liveness/<uid>/<session>/ (R2
// VERIFICATION bucket) instead of deleting them, and write a liveness_audit row
// (routes/liveness_audit.ts) with the request geo/IP + client device fingerprint.
// Evidence is retained for safety review; the "Why are we asking?" popup carries
// the honest retention sentence. Retry stays within the shared 3/24h budget.
//
//   POST /api/id/liveness/start            → {session_id, challenge}
//   POST /api/id/liveness/upload?session=&part=frame0|frame1|frame2|clip  (raw body)
//   POST /api/id/liveness/verify {session_id} → 202 {status:"pending", session_id}
//   GET  /api/id/liveness/result?session=<sid> → {status:"pending"} | done result
//
// LIVE-V2 P0 (2026-07-04, ASYNC VERIFY HOTFIX): /verify no longer runs LLaVA×3 +
// Whisper inside the HTTP request (that exceeded the client timeout → users saw a
// false "Network error" and burned the 3/24h budget). It now validates the session
// and kicks off the SAME checks in the background (runLivenessChecks), returning
// 202 immediately; the client polls GET /result until the outcome is stored in KV
// (key liveness:result:<uid>:<sid>, TTL 1h). Same checks, same pass/fail rules,
// same D15 evidence retention — just async.
//
// Flag-gated by platform_config.workersAiLivenessEnabled — OFF by default;
// Rekognition remains the default L2 provider until this is tuned.
import type { Env } from "../types";
import { json } from "../util";
import { setVerifiedCache } from "../auth";
import { requireUser, isFail } from "../authz";
import { metaDb, metaSession } from "../db/shard";
import { trackUser, metric, brainFact } from "../hooks";
import { emailFor } from "../lib/identity";
import { notifyUser } from "../notify";
import { invalidateLevelCache } from "./ladder";
import { recordLivenessAudit, auditPrefix, deviceCtxFromBody } from "./liveness_audit";
import { readConfig } from "./config";
import { rekognitionConfigured, compareFaces } from "../aws/rekognition";

const MAX_ATTEMPTS_24H = 3;             // shared budget with the other providers
const DAY = 86_400_000;
const CHALLENGE_TTL_S = 900;            // 15 min to finish a session
const MAX_FRAME_BYTES = 1_500_000;      // ~1.5 MB JPEG
const MAX_CLIP_BYTES = 16_000_000;      // ~16 MB clip
const MAX_IMAGE_PARTS = 8;              // LIVE-V2 P3: cap image parts per session
const MIN_CLIP_BYTES = 200_000;         // LIVE-V2 P3 (B9): a real clip is > 200 KB
const MAX_LLAVA_CALLS = 8;              // LIVE-V2 P3: budget guard per verify
const VISION_MODEL = "@cf/llava-hf/llava-1.5-7b-hf";
const WHISPER_MODEL = "@cf/openai/whisper";
const RESULT_TTL_S = 3600;              // LIVE-V2 P0: verify outcome cached in KV 1h
const VERIFY_PROVIDER = "workersai";

// LIVE-V2 P0: human-readable message for each structured check id (plan §5B).
// The client renders the FIRST failing check's user_message as the fail reason.
const CHECK_MESSAGES: Record<string, string> = {
  // V1 flat ids (kept so old sessions/clients render unchanged).
  realness: "This looks like a photo of a screen or picture. Use your live camera.",
  phrase: "We couldn't hear the phrase clearly.",
  turn_left: "We couldn't see you complete the movements.",
  turn_right: "We couldn't see you complete the movements.",
  smile: "We couldn't see you complete the movements.",
  sad_face: "We couldn't see you complete the movements.",
  mouth_open: "We couldn't see you complete the movements.",
  eyebrows_raised: "We couldn't see you complete the movements.",
  missing_frames: "We didn't receive the challenge photos — try again.",
  // LIVE-V2 P3: structured B-check ids (plan §5B wording).
  b1_realness: "This looks like a photo of a screen or picture. Use your live camera.",
  b2_single_person: "More than one person was detected.",
  b3_mask: "Your face was covered.",
  b4_challenge: "We couldn't see you complete the movements.",
  b4_profile: "We couldn't see you complete the movements.",
  b5_same_person: "Different faces appeared during the video.",
  b5_skipped: "",
  b6_phrase: "We couldn't hear the phrase clearly.",
  b7_eyes_open: "Your eyes were closed.",
  b8_session: "Verification failed — please try again.",
  b9_clip: "The video was too short.",
};
const checkMessage = (id: string): string =>
  CHECK_MESSAGES[id] ?? "Verification failed — please try again.";

const ACTIONS = [
  { id: "turn_left", prompt: "Is the person's head clearly turned to their left or right (face in profile or semi-profile, not facing the camera straight on)? Answer only YES or NO." },
  { id: "turn_right", prompt: "Is the person's head clearly turned to their left or right (face in profile or semi-profile, not facing the camera straight on)? Answer only YES or NO." },
  { id: "smile", prompt: "Is the person clearly smiling? Answer only YES or NO." },
  { id: "sad_face", prompt: "Does the person have a sad or frowning expression (NOT smiling)? Answer only YES or NO." },
  { id: "mouth_open", prompt: "Is the person's mouth clearly open? Answer only YES or NO." },
  { id: "eyebrows_raised", prompt: "Are the person's eyebrows clearly raised? Answer only YES or NO." },
] as const;

const REALNESS_PROMPT =
  "Look carefully at this photo. Is it a live photo of exactly one real human " +
  "person taken with a front camera (NOT a photo of a screen, monitor, printed " +
  "photo, or another photograph)? Answer only YES or NO.";

// LIVE-V2 P3: single-check LLaVA prompts (plan §6.4 prompt hardening).
const COUNT_PROMPT = "How many people are visible in this photo? Answer with a number only.";
const MASK_PROMPT = "Is the person's face covered by a mask or object over the nose or mouth? Answer only YES or NO.";
const PROFILE_PROMPT = "Is the person's head clearly turned or tilted away from facing straight at the camera (in profile or looking up/down/sideways)? Answer only YES or NO.";
const EYES_OPEN_PROMPT = "Are the person's eyes open? Answer only YES or NO.";

const PHRASE_WORDS = [
  "river", "orange", "window", "tiger", "cloud", "guitar", "marble", "rocket",
  "silver", "candle", "forest", "puzzle", "anchor", "velvet", "comet", "lantern",
];

interface Challenge { actions: string[]; phrase: string; created_at: number; }

function workersAiEnabled(env: Env): Promise<boolean> {
  // Merge KV over code DEFAULTS (readConfig) — a raw KV read silently reports
  // "off" for any flag added after the KV blob was last written (2026-07-04 outage).
  return readConfig(env)
    .then((c) => c.workersAiLivenessEnabled === true)
    .catch(() => false);
}

async function attemptsLast24h(env: Env, uid: string): Promise<number> {
  const row = await metaSession(env)
    .prepare("SELECT COUNT(*) AS n FROM verification_attempts WHERE uid=?1 AND created_at > ?2")
    .bind(uid, Date.now() - DAY).first<{ n: number }>();
  return row?.n ?? 0;
}

function pick<T>(arr: readonly T[], n: number): T[] {
  const pool = [...arr];
  const out: T[] = [];
  while (out.length < n && pool.length) {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    out.push(pool.splice(buf[0] % pool.length, 1)[0]);
  }
  return out;
}

const sessionPrefix = (uid: string, sid: string) => `u/${uid}/liveness/${sid}/`;

// POST /api/id/liveness/start
export async function livenessStart(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  if (!(await workersAiEnabled(env))) {
    // [LIVENESS-TEL-1] Server-side telemetry for start failures — the 2026-07-04
    // flag_off outage was invisible in PostHog except via client api_error events.
    // Email-stamped so support can pull incidents by email.
    void trackUser(env, ctx.uid, await emailFor(env, ctx.uid).catch(() => null),
      "liveness_start_blocked", "avaid", { reason: "flag_off", status: 503, provider: "workersai" });
    metric(env, "liveness_start_blocked", [1], ["flag_off"]);
    return json({ error: "workers-ai liveness disabled", reason: "flag_off" }, 503);
  }
  if (await attemptsLast24h(env, ctx.uid) >= MAX_ATTEMPTS_24H) {
    void trackUser(env, ctx.uid, await emailFor(env, ctx.uid).catch(() => null),
      "liveness_start_blocked", "avaid", { reason: "rate_limited", status: 429, provider: "workersai" });
    metric(env, "liveness_start_blocked", [1], ["rate_limited"]);
    return json({ error: "too many attempts", retry_after_hours: 24 }, 429);
  }

  const sid = crypto.randomUUID();
  const actions = pick(ACTIONS, 2).map((a) => a.id);
  const phrase = pick(PHRASE_WORDS, 3).join(" ");
  const challenge: Challenge = { actions, phrase, created_at: Date.now() };
  await env.TOKENS.put(`liveness:ch:${ctx.uid}:${sid}`, JSON.stringify(challenge), { expirationTtl: CHALLENGE_TTL_S });

  const now = Date.now();
  await metaDb(env).batch([
    metaDb(env).prepare(
      `INSERT INTO verification_status (uid, status, method, session_id, updated_at)
       VALUES (?1,'pending','workersai_liveness',?2,?3)
       ON CONFLICT(uid) DO UPDATE SET status='pending', method='workersai_liveness', session_id=?2, updated_at=?3`,
    ).bind(ctx.uid, sid, now),
    metaDb(env).prepare(
      "INSERT INTO verification_attempts (uid, session_id, result, provider, created_at) VALUES (?1,?2,'pending','workersai',?3)",
    ).bind(ctx.uid, sid, now),
  ]);

  void trackUser(env, ctx.uid, await emailFor(env, ctx.uid).catch(() => null),
    "liveness_session_started", "avaid", { provider: "workersai", session_id: sid });
  metric(env, "liveness_wai_session", [1]);
  // The challenge is only revealed now — recording starts immediately, so a
  // pre-prepared clip can't match the random actions + phrase.
  return json({
    session_id: sid,
    challenge: { actions, phrase, max_seconds: 10 },
  });
}

// POST /api/id/liveness/upload?session=<sid>&part=frame0|frame1|frame2|clip
export async function livenessUpload(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);

  const u = new URL(req.url);
  const sid = u.searchParams.get("session") || "";
  const part = u.searchParams.get("part") || "";
  if (!/^[0-9a-f-]{36}$/.test(sid)) return json({ error: "bad session" }, 400);
  // LIVE-V2 P3: accept the richer V2 evidence set (head-circle profiles + extra
  // expression peaks) alongside the V1 frame0/frame1/frame2 layout. Parts:
  //   frame<n>            — V1 challenge/neutral stills (kept for back-compat)
  //   extra<n>            — V2 additional stills (expression peaks etc.)
  //   profile_left/right/up/down — V2 head-circle auto-captures
  //   clip               — the selfie recording
  // Cap total IMAGE parts at 8 per session (clip is separate); same size caps.
  if (!/^(frame\d|extra\d|profile_(left|right|up|down)|clip)$/.test(part)) {
    return json({ error: "bad part" }, 400);
  }
  const ch = await env.TOKENS.get(`liveness:ch:${ctx.uid}:${sid}`);
  if (!ch) {
    // [LIVENESS-TEL-1] upload against a dead session — usually a client that sat
    // on the challenge past CHALLENGE_TTL_S, or an app restart mid-flow.
    void trackUser(env, ctx.uid, await emailFor(env, ctx.uid).catch(() => null),
      "liveness_upload_rejected", "avaid", { reason: "session_expired", status: 410, part, session_id: sid });
    return json({ error: "session expired" }, 410);
  }

  // LIVE-V2 P3: enforce the ≤8 image-parts cap. Only counts NEW image keys — an
  // overwrite of an already-uploaded part does not add to the total.
  if (part !== "clip") {
    const prefix = sessionPrefix(ctx.uid, sid);
    const [existing, already] = await Promise.all([
      env.VERIFICATION.list({ prefix }),
      env.VERIFICATION.head(prefix + part),
    ]);
    const imageCount = (existing.objects ?? []).filter((o) => !o.key.endsWith("clip")).length;
    if (!already && imageCount >= MAX_IMAGE_PARTS) {
      return json({ error: "too many parts" }, 413);
    }
  }

  const body = await req.arrayBuffer();
  const cap = part === "clip" ? MAX_CLIP_BYTES : MAX_FRAME_BYTES;
  if (body.byteLength === 0 || body.byteLength > cap) return json({ error: "bad size" }, 413);

  await env.VERIFICATION.put(sessionPrefix(ctx.uid, sid) + part, body);
  return json({ ok: true, part, bytes: body.byteLength });
}

// LIVE-V2 P3: a tiny budget object threaded through the pipeline so total LLaVA
// calls per verify never exceed MAX_LLAVA_CALLS (cost guard). `visionRun` returns
// the raw uppercased text; `visionYes` is the YES/NO convenience on top of it.
interface LlavaBudget { calls: number; }

async function visionRun(env: Env, budget: LlavaBudget, image: ArrayBuffer, prompt: string): Promise<string | null> {
  if (budget.calls >= MAX_LLAVA_CALLS) return null; // over budget — caller treats as "unknown"
  budget.calls++;
  try {
    const r: any = await env.AI.run(VISION_MODEL as any, {
      image: [...new Uint8Array(image)],
      prompt,
      max_tokens: 8,
    } as any);
    return String(r?.description ?? r?.response ?? "").trim().toUpperCase();
  } catch {
    return null;
  }
}

async function visionYes(env: Env, budget: LlavaBudget, image: ArrayBuffer, prompt: string): Promise<boolean> {
  const text = await visionRun(env, budget, image, prompt);
  return !!text && text.startsWith("YES");
}

// LIVE-V2 P0: the structured outcome we cache in KV + return to the polling client.
export interface LivenessResult {
  verified: boolean;
  // Structured, human-readable checks (plan §5B). The client renders the first
  // failing user_message as the specific reason.
  checks: Array<{ id: string; pass: boolean; user_message: string }>;
  // Legacy id→bool map so the pre-V2 client keeps working unchanged.
  checks_map: Record<string, boolean>;
  attempts_remaining: number;
  level?: number;
}

const resultKey = (uid: string, sid: string) => `liveness:result:${uid}:${sid}`;

// POST /api/id/liveness/verify {session_id}
// LIVE-V2 P0: validate the session, then run the checks in the BACKGROUND and
// return 202 immediately. The client polls GET /api/id/liveness/result.
//
// LIVE-V2 NOTE (queue vs waitUntil): the plan prefers enqueuing onto the existing
// consumers queue, but avatok-api has NO liveness queue producer and avatok-consumers
// has no liveness consumer binding — wiring one needs new infra (`wrangler queues
// create liveness-verify` + a [[queues.consumers]] entry + cross-package import of
// runLivenessChecks, which the worker↔consumers package split forbids, exactly as
// noted for liveness_sweep.ts). So we take the plan's sanctioned fallback (b):
// ctx.waitUntil(runLivenessChecks(...)) keeps the request alive past the response
// while the checks run, storing the outcome in KV. A future queue can call the SAME
// exported runLivenessChecks. See consumers/src/liveness_verify.ts for the stub.
export async function livenessVerify(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const auth = await requireUser(req, env);
  if (isFail(auth)) return json({ error: auth.error }, auth.status);

  const b = (await req.json().catch(() => ({}))) as { session_id?: string };
  const sid = String(b.session_id || "");
  const chRaw = await env.TOKENS.get(`liveness:ch:${auth.uid}:${sid}`);
  if (!chRaw) {
    // [LIVENESS-TEL-1] verify against a dead session — challenge TTL elapsed
    // between recording and submit (slow upload, backgrounded app, retry loop).
    void trackUser(env, auth.uid, await emailFor(env, auth.uid).catch(() => null),
      "liveness_verify_rejected", "avaid", { reason: "session_expired", status: 410, session_id: sid });
    metric(env, "liveness_verify_rejected", [1], ["session_expired"]);
    return json({ error: "session expired — start again" }, 410);
  }

  // Idempotency: if this session was already verified, return the stored outcome
  // as done (a client double-tap / re-poll must not re-run LLaVA or re-charge).
  const existing = await env.TOKENS.get(resultKey(auth.uid, sid), "json").catch(() => null);
  if (existing) return json({ status: "done", ...(existing as LivenessResult) }, 200);

  // Required parts present? LIVE-V2 P3: the strict per-check required-parts logic
  // now lives in runLivenessChecks (B8, layout-aware for V1 frame0/frame1 AND V2
  // profile_*/extra layouts). Here we only short-circuit the obvious "nothing was
  // uploaded" case (no image parts at all) so we don't spin up the worker for an
  // empty session. Any real upload flows through to the full pipeline.
  const prefix = sessionPrefix(auth.uid, sid);
  const listed = await env.VERIFICATION.list({ prefix }).catch(() => null);
  const imageParts = (listed?.objects ?? []).filter((o) => !o.key.endsWith("clip"));
  if (imageParts.length === 0) {
    // Store + return a done fail immediately — no need to spin up the worker.
    const result: LivenessResult = {
      verified: false,
      checks: [{ id: "missing_frames", pass: false, user_message: checkMessage("missing_frames") }],
      checks_map: { missing_frames: false },
      attempts_remaining: Math.max(0, MAX_ATTEMPTS_24H - (await attemptsLast24h(env, auth.uid))),
    };
    // Run the audit/DB fail-path in the background; respond right away.
    const runFail = runLivenessChecks(env, auth.uid, sid, req).catch(() => {});
    if (ctx) ctx.waitUntil(runFail); else await runFail;
    return json({ status: "done", ...result }, 200);
  }

  // Kick off the real checks in the background; the client polls /result.
  // [LIVENESS-TEL-1] accepted marker + a crash marker on the background job:
  // if the pipeline throws, the client polls until its 90s cap with NO stored
  // result — this event is the only server-side breadcrumb for that hang.
  void trackUser(env, auth.uid, await emailFor(env, auth.uid).catch(() => null),
    "liveness_verify_accepted", "avaid", { session_id: sid, image_parts: imageParts.length });
  const work = runLivenessChecks(env, auth.uid, sid, req).catch(async (e) => {
    console.error("[liveness] background verify failed:", String(e));
    void trackUser(env, auth.uid, await emailFor(env, auth.uid).catch(() => null),
      "liveness_verify_error", "avaid", { session_id: sid, error: String(e).slice(0, 300) });
    metric(env, "liveness_verify_error", [1]);
  });
  if (ctx) ctx.waitUntil(work); else await work; // no ctx in tests → run inline
  return json({ status: "pending", session_id: sid }, 202);
}

// GET /api/id/liveness/result?session=<sid>
// LIVE-V2 P0: poll target. {status:"pending"} until runLivenessChecks stores the
// outcome in KV, then the full result with status:"done".
export async function livenessResult(req: Request, env: Env): Promise<Response> {
  const auth = await requireUser(req, env);
  if (isFail(auth)) return json({ error: auth.error }, auth.status);
  const u = new URL(req.url);
  const sid = u.searchParams.get("session") || "";
  if (!/^[0-9a-f-]{36}$/.test(sid)) return json({ error: "bad session" }, 400);
  const stored = await env.TOKENS.get(resultKey(auth.uid, sid), "json").catch(() => null);
  if (!stored) return json({ status: "pending" }, 200);
  return json({ status: "done", ...(stored as LivenessResult) }, 200);
}

// LIVE-V2 P0: the actual verification — extracted so BOTH the background waitUntil
// path AND a future queue consumer call the SAME logic. Runs the LLaVA frame checks
// + Whisper phrase check, moves evidence to the retained audit prefix (D15), writes
// the pass/fail DB rows, updates caches/notifies on pass, and stores the structured
// outcome in KV (key liveness:result:<uid>:<sid>). Never throws to the caller.
export async function runLivenessChecks(
  env: Env,
  uid: string,
  sid: string,
  req?: Request,
): Promise<LivenessResult> {
  const startedAt = Date.now();
  const ctx = { uid }; // local alias to minimise diff below
  const chRaw = await env.TOKENS.get(`liveness:ch:${ctx.uid}:${sid}`);
  if (!chRaw) {
    // Session expired between verify and the background run — record a soft fail.
    const result: LivenessResult = {
      verified: false,
      checks: [{ id: "b8_session", pass: false, user_message: "Verification failed — please try again." }],
      checks_map: {},
      attempts_remaining: Math.max(0, MAX_ATTEMPTS_24H - (await attemptsLast24h(env, ctx.uid))),
    };
    await env.TOKENS.put(resultKey(ctx.uid, sid), JSON.stringify(result), { expirationTtl: RESULT_TTL_S }).catch(() => {});
    return result;
  }
  const challenge = JSON.parse(chRaw) as Challenge;

  const prefix = sessionPrefix(ctx.uid, sid);
  const retainedPrefix = auditPrefix(ctx.uid, sid); // liveness/<uid>/<session>/
  // LIVE-V2 P0: the device fingerprint used to ride the verify JSON body; the
  // async path no longer has it here, so audit keeps the edge geo/IP (from req)
  // and an empty device ctx. (Client can be extended to persist it later.)
  const device = deviceCtxFromBody({});

  // LIVE-V2 P0/P3: build the structured checks[] (plan §5B) + legacy id→bool map,
  // store the outcome in KV, and return it. Central exit for the background run so
  // both fail and pass persist the poll-able result. Accepts a structured array
  // (V2) OR a flat map (V1 back-compat); the map form derives messages via
  // checkMessage(). `telemetry` carries the P3 extras (llava_calls, rekognition_used).
  const finalize = async (
    checksInput: Array<{ id: string; pass: boolean; user_message?: string }> | Record<string, boolean>,
    opts: { verified: boolean; level?: number; telemetry?: { llava_calls?: number; rekognition_used?: boolean } },
  ): Promise<LivenessResult> => {
    const checksArr = Array.isArray(checksInput)
      ? checksInput.map((c) => ({ id: c.id, pass: c.pass, user_message: c.pass ? "" : (c.user_message ?? checkMessage(c.id)) }))
      : Object.entries(checksInput).map(([id, pass]) => ({ id, pass, user_message: pass ? "" : checkMessage(id) }));
    const map: Record<string, boolean> = {};
    for (const c of checksArr) map[c.id] = c.pass;
    const result: LivenessResult = {
      verified: opts.verified,
      checks: checksArr,
      checks_map: map,
      attempts_remaining: Math.max(0, MAX_ATTEMPTS_24H - (await attemptsLast24h(env, ctx.uid))),
      ...(opts.level != null ? { level: opts.level } : {}),
    };
    await env.TOKENS.put(resultKey(ctx.uid, sid), JSON.stringify(result), { expirationTtl: RESULT_TTL_S }).catch(() => {});
    const failed = checksArr.filter((c) => !c.pass).map((c) => c.id);
    // [LIVENESS-TEL-1] email-stamped so support can pull outcomes by email.
    void trackUser(env, ctx.uid, await emailFor(env, ctx.uid).catch(() => null),
      "liveness_verify_result", "avaid", {
      pass: opts.verified,
      failed_checks: failed,
      session_id: sid,
      duration_ms: Date.now() - startedAt,
      provider: VERIFY_PROVIDER,
      llava_calls: opts.telemetry?.llava_calls ?? 0,
      rekognition_used: opts.telemetry?.rekognition_used ?? false,
    });
    metric(env, "liveness_v2_verify", [1]);
    return result;
  };

  // D15 (2026-07-03): STORE EVERYTHING. On BOTH pass and fail, MOVE every part
  // (frames + clip) from the upload prefix into the retained audit prefix instead
  // of deleting. `keepThumbAt` names the frame0 copy that also stays the
  // AvaIdentity green-tick thumbnail. Returns the retained prefix + thumb key.
  // LIVE-V2 P3: retain EVERY uploaded part, not just the fixed V1 set — the V2 flow
  // uploads profile_* + extra<n> stills too. We list the whole session prefix and
  // move each object across, so the audit trail keeps 100% of the evidence (D15).
  // frame0 stays the AvaIdentity green-tick thumbnail when present.
  const retainEvidence = async (): Promise<{ prefix: string; thumbKey: string }> => {
    const thumbKey = retainedPrefix + "frame0.jpg";
    try {
      const listing = await env.VERIFICATION.list({ prefix });
      for (const o of listing.objects ?? []) {
        const src = o.key;
        const part = src.slice(prefix.length); // e.g. "frame0", "profile_left", "clip"
        if (!part) continue;
        const dst = part === "clip" ? retainedPrefix + "clip.bin" : `${retainedPrefix}${part}.jpg`;
        try {
          const obj = await env.VERIFICATION.get(src);
          if (!obj) continue;
          await env.VERIFICATION.put(dst, await obj.arrayBuffer());
          await env.VERIFICATION.delete(src); // remove the transient upload copy
        } catch { /* best-effort per part */ }
      }
    } catch { /* best-effort listing */ }
    try { await env.TOKENS.delete(`liveness:ch:${ctx.uid}:${sid}`); } catch { /* */ }
    return { prefix: retainedPrefix, thumbKey };
  };

  // ── LIVE-V2 P3: multi-frame verify pipeline (plan §5B). ────────────────────
  // Evidence layout is layout-agnostic so BOTH old V1 sessions AND new V2 sessions
  // verify correctly:
  //   V1 session:  frame0 = gesture A, frame1 = gesture B, frame2 = neutral, clip
  //   V2 session:  extra<n>/frame<n> = expression peaks, profile_* = head-circle
  //                turns, one neutral still, clip
  // We load every image part, then classify: profiles (profile_*), and a "neutral"
  // = the last non-profile still (V1 frame2 or V2's neutral). Cheap checks run first
  // and expensive LLaVA calls short-circuit when evidence is missing. Total LLaVA
  // calls are capped by the shared `budget`.
  const budget: LlavaBudget = { calls: 0 };
  const checks: Array<{ id: string; pass: boolean; user_message?: string }> = [];
  const addCheck = (id: string, pass: boolean) =>
    checks.push({ id, pass, user_message: pass ? "" : checkMessage(id) });

  // Load all uploaded image parts (skip the clip) as {part -> bytes}.
  const parts: Record<string, ArrayBuffer> = {};
  try {
    const listing = await env.VERIFICATION.list({ prefix });
    for (const o of listing.objects ?? []) {
      const part = o.key.slice(prefix.length);
      if (!part || part === "clip") continue;
      const obj = await env.VERIFICATION.get(o.key);
      if (obj) parts[part] = await obj.arrayBuffer();
    }
  } catch { /* best-effort */ }

  const profileParts = Object.keys(parts).filter((p) => p.startsWith("profile_")).sort();
  const stillParts = Object.keys(parts).filter((p) => !p.startsWith("profile_")).sort();
  // Neutral = the last non-profile still (V1 frame2, else V2 neutral, else frame0).
  const neutralKey = stillParts.length ? stillParts[stillParts.length - 1] : undefined;
  const neutral = neutralKey ? parts[neutralKey] : null;
  // Expression/gesture stills = every non-profile still EXCEPT the neutral one.
  const gestureKeys = stillParts.filter((p) => p !== neutralKey);

  // B8 — session integrity. TTL is implied (challenge KV still present). Required
  // parts: for V2 we want ≥1 gesture still + neutral + clip; for V1 (frame0+frame1)
  // the frame0/frame1 layout is treated as valid (frame0=gesture, frame1 doubles as
  // gesture+neutral). Single-verify is enforced by the idempotency guard in verify.
  const clipHead = await env.VERIFICATION.head(prefix + "clip");
  const isV1Layout = !profileParts.length && !!parts["frame0"] && !!parts["frame1"];
  const b8ok = isV1Layout
    ? (!!parts["frame0"] && !!parts["frame1"])
    : (gestureKeys.length >= 1 && !!neutral && !!clipHead);
  addCheck("b8_session", b8ok);
  if (!b8ok) {
    const { prefix: rp } = await retainEvidence();
    await recordLivenessAudit(env, { uid: ctx.uid, provider: "workersai", status: "fail", req, device, r2Prefix: rp });
    await env.DB_META.prepare("UPDATE verification_attempts SET result='fail' WHERE uid=?1 AND session_id=?2").bind(ctx.uid, sid).run().catch(() => {});
    return finalize(checks, { verified: false, telemetry: { llava_calls: budget.calls, rekognition_used: false } });
  }

  // B9 — clip sanity: size 200KB–16MB. (Duration/audio-track probing isn't available
  // in Workers — LIVE-V2 NOTE: we approximate via byte size; a real clip that
  // contains a few seconds of video+audio always clears 200KB.)
  const clipSize = clipHead?.size ?? 0;
  const b9ok = clipSize >= MIN_CLIP_BYTES && clipSize <= MAX_CLIP_BYTES;
  addCheck("b9_clip", b9ok);

  // Pick the reference frame for the LLaVA vision checks: neutral if present, else
  // the first gesture still (V1 frame0). Everything short-circuits to a fail if we
  // somehow have no still at all.
  const refFrame = neutral ?? (gestureKeys.length ? parts[gestureKeys[0]] : null);

  // B1 — realness on neutral + one profile (≤2 calls, plan §6). If no profile, run
  // realness on neutral + first gesture still instead.
  const realTargets: ArrayBuffer[] = [];
  if (refFrame) realTargets.push(refFrame);
  if (profileParts.length) realTargets.push(parts[profileParts[0]]);
  else if (gestureKeys.length && parts[gestureKeys[0]] !== refFrame) realTargets.push(parts[gestureKeys[0]]);
  let b1ok = realTargets.length > 0;
  for (const t of realTargets.slice(0, 2)) b1ok = b1ok && (await visionYes(env, budget, t, REALNESS_PROMPT));
  addCheck("b1_realness", b1ok);

  // B2 — exactly one person (LLaVA count on neutral).
  const b2ok = refFrame ? ((await visionRun(env, budget, refFrame, COUNT_PROMPT))?.startsWith("1") ?? false) : false;
  addCheck("b2_single_person", b2ok);

  // B3 — mask / face covering on neutral (prompt asks YES if covered → invert).
  const b3ok = refFrame ? !(await visionYes(env, budget, refFrame, MASK_PROMPT)) : false;
  addCheck("b3_mask", b3ok);

  // B4 — challenge gestures. Expression stills use the server-side ACTIONS prompts
  // (matched to the session's random actions when possible; else any ACTIONS prompt
  // whose gesture the frame satisfies). Then up to 2 profile frames are checked for
  // a clear head turn. At least ONE gesture OR profile must pass.
  const gestureResults: boolean[] = [];
  for (let i = 0; i < gestureKeys.length; i++) {
    if (budget.calls >= MAX_LLAVA_CALLS) break;
    // Prefer the action id at this index; fall back to the first challenge action.
    const actionId = challenge.actions[i] ?? challenge.actions[0];
    const action = ACTIONS.find((a) => a.id === actionId) ?? ACTIONS.find((a) => a.id === "smile");
    const ok = action ? await visionYes(env, budget, parts[gestureKeys[i]], action.prompt) : false;
    gestureResults.push(ok);
    addCheck(`b4_challenge_${i}`, ok);
  }
  const profileResults: boolean[] = [];
  for (const pk of profileParts.slice(0, 2)) {
    if (budget.calls >= MAX_LLAVA_CALLS) break;
    const ok = await visionYes(env, budget, parts[pk], PROFILE_PROMPT);
    profileResults.push(ok);
    addCheck(`b4_profile_${pk.replace("profile_", "")}`, ok);
  }
  const anyGesture = gestureResults.some(Boolean) || profileResults.some(Boolean);
  // A single rolled-up b4 flag drives the verdict + gives the client one message.
  addCheck("b4_challenge", anyGesture);
  const profilesPresent = profileParts.length > 0;
  const profileTurnOk = !profilesPresent || profileResults.some(Boolean);

  // B5 — same person. LLaVA image-comparison is unreliable → only run when the
  // livenessUseRekognition flag is ON *and* AWS creds exist, via CompareFaces
  // (standard image API, NOT Face Liveness). Otherwise mark skipped=pass (never
  // fail a user on a check we cannot run).
  let rekognitionUsed = false;
  let b5ok = true;
  let b5id = "b5_skipped";
  try {
    const cfg = await readConfig(env);
    const compareTarget = gestureKeys.length ? parts[gestureKeys[0]] : (profileParts.length ? parts[profileParts[0]] : null);
    if (cfg.livenessUseRekognition && rekognitionConfigured(env) && neutral && compareTarget) {
      rekognitionUsed = true;
      b5id = "b5_same_person";
      const { similarity } = await compareFaces(env, new Uint8Array(neutral), new Uint8Array(compareTarget), 80);
      b5ok = similarity >= 90;
    }
  } catch {
    // CompareFaces error → don't punish the user; treat as skipped.
    b5ok = true;
    b5id = "b5_skipped";
    rekognitionUsed = false;
  }
  checks.push({ id: b5id, pass: b5ok, user_message: b5ok ? "" : checkMessage(b5id) });

  // B6 — spoken phrase via Whisper (fuzzy ≥2/3 words, prefix-match tolerant).
  let phraseOk: boolean | null = null;
  const clipObj = await env.VERIFICATION.get(prefix + "clip");
  if (clipObj) {
    try {
      const audio = await clipObj.arrayBuffer();
      const r: any = await env.AI.run(WHISPER_MODEL as any, { audio: [...new Uint8Array(audio)] } as any);
      const text = String(r?.text ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ");
      const heard = text.split(/\s+/).filter(Boolean);
      const words = challenge.phrase.toLowerCase().split(" ");
      // Fuzzy: a word matches if the heard transcript contains it, OR shares a
      // ≥4-char prefix with any heard token (tolerates minor misspelling).
      const matched = words.filter((w) => {
        if (text.includes(w)) return true;
        const p = w.slice(0, 4);
        return p.length >= 4 && heard.some((h) => h.startsWith(p) || w.startsWith(h.slice(0, 4)));
      }).length;
      phraseOk = matched >= 2; // 2 of 3
    } catch {
      phraseOk = null; // transcription unavailable — soft pass (don't hard-fail)
    }
  }
  const b6ok = phraseOk !== false;
  addCheck("b6_phrase", b6ok);

  // B7 — eyes open on neutral.
  const b7ok = refFrame ? await visionYes(env, budget, refFrame, EYES_OPEN_PROMPT) : false;
  addCheck("b7_eyes_open", b7ok);

  // ── Verdict (plan §5B / §D-P3): pass iff ALL of B1,B2,B3,B6,B8 pass AND ≥1 B4
  // gesture passes AND B7 passes AND (a profile turn passed OR profiles missing).
  const passed = b1ok && b2ok && b3ok && b6ok && b8ok && anyGesture && b7ok && profileTurnOk;
  const now = Date.now();

  await env.DB_META.prepare(
    "UPDATE verification_attempts SET result=?1 WHERE uid=?2 AND session_id=?3",
  ).bind(passed ? "pass" : "fail", ctx.uid, sid).run();

  if (!passed) {
    const { prefix: rp } = await retainEvidence(); // D15: keep evidence on fail too
    await recordLivenessAudit(env, { uid: ctx.uid, provider: "workersai", status: "fail", req, device, r2Prefix: rp });
    const failMap: Record<string, boolean> = {};
    for (const c of checks) failMap[c.id] = c.pass;
    await metaDb(env).prepare(
      "UPDATE verification_status SET status='rejected', failure_reason=?2, updated_at=?3 WHERE uid=?1",
    ).bind(ctx.uid, JSON.stringify(failMap), now).run();
    void trackUser(env, ctx.uid, await emailFor(env, ctx.uid).catch(() => null),
      "liveness_failed", "avaid", { provider: "workersai", checks: failMap, session_id: sid });
    metric(env, "liveness_wai_failed", [1]);
    return finalize(checks, { verified: false, telemetry: { llava_calls: budget.calls, rekognition_used: rekognitionUsed } });
  }

  // PASS — D15: retain ALL evidence under liveness/<uid>/<session>/; frame0 stays
  // the AvaIdentity green-tick thumbnail (thumbKey now points into the audit prefix).
  const { prefix: retainedR2Prefix, thumbKey } = await retainEvidence();
  await recordLivenessAudit(env, { uid: ctx.uid, provider: "workersai", status: "pass", req, device, r2Prefix: retainedR2Prefix });

  // F5: if this user ALSO passed the AWS Rekognition selfie-liveness step
  // (id.ts), the combined proof is stronger than either alone — record the
  // provider as `rekognition+challenges`. Otherwise keep the plain gesture
  // provider. We look for any prior passing rekognition attempt.
  const rekog = await metaSession(env)
    .prepare("SELECT 1 AS ok FROM verification_attempts WHERE uid=?1 AND provider='rekognition' AND result='pass' LIMIT 1")
    .bind(ctx.uid).first<{ ok: number }>();
  const kycProvider = rekog ? "rekognition+challenges" : "workersai_liveness";

  await metaDb(env).batch([
    metaDb(env).prepare(
      "UPDATE verification_status SET status='verified', verified_at=?2, updated_at=?2 WHERE uid=?1",
    ).bind(ctx.uid, now),
    metaDb(env).prepare(
      `INSERT INTO kyc_status (uid, status, provider, verified_at, updated_at)
       VALUES (?1, 'verified', ?3, ?2, ?2)
       ON CONFLICT(uid) DO UPDATE SET status='verified', provider=?3, verified_at=?2, updated_at=?2`,
    ).bind(ctx.uid, now, kycProvider),
    metaDb(env).prepare(
      `INSERT INTO identity_proofs (uid, proof, status, provider, evidence_ref, verified_at, updated_at)
       VALUES (?1,'liveness','verified','workersai',?2,?3,?3)
       ON CONFLICT(uid, proof) DO UPDATE SET status='verified', provider='workersai', evidence_ref=?2, verified_at=?3, updated_at=?3`,
    ).bind(ctx.uid, thumbKey, now),
  ]);
  await setVerifiedCache(env, ctx.uid, true);
  await invalidateLevelCache(env, ctx.uid);

  brainFact(env, ctx.uid, "identity_verified", "avaid", { method: kycProvider, at: now });
  void trackUser(env, ctx.uid, await emailFor(env, ctx.uid).catch(() => null),
    "id_verified", "avaid", { provider: kycProvider, session_id: sid });
  metric(env, "liveness_wai_verified", [1]);
  try {
    await notifyUser(env, ctx.uid, {
      type: "system", title: "You're verified ✓",
      body: "Creator features and verified apps are now unlocked.",
      data: { deeplink: "/identity" },
    });
  } catch { /* best-effort */ }

  return finalize(checks, { verified: true, level: 2, telemetry: { llava_calls: budget.calls, rekognition_used: rekognitionUsed } });
}
