// L2 liveness — Workers AI provider (third provider beside Rekognition + Stripe;
// see PROPOSAL-PROGRESSIVE-IDENTITY.md §5). Random challenge → client records a
// 5–10 s selfie clip, captures challenge frames, uploads both → Workers AI
// verifies (vision per frame + Whisper on the clip audio for the spoken phrase).
// PASS → kyc_status('verified','workersai_liveness') exactly like Rekognition.
//
// OWNER DECISION 2026-07-03 (STREAM H, D15 — "STORE EVERYTHING"): this REVERSED
// the old delete-on-pass/fail behaviour. On pass we MOVE evidence into the
// retained audit prefix liveness/<uid>/<session>/ (R2 VERIFICATION bucket)
// instead of deleting it, and write a liveness_audit row (routes/liveness_audit.ts)
// with the request geo/IP + client device fingerprint. Fail still deletes
// everything (LIVE-STORAGE-1, 2026-07-04 — unlimited retries would grow R2
// unboundedly otherwise). Retry stays within the shared 24h budget.
//
// [LIVE-RETAIN-2] (2026-07-05, scaling): SUPERSEDES D15's "retain EVERY part" on
// the pass path specifically. We now retain ONLY the neutral still (frame0.jpg,
// keeps the green-tick thumbnail working), ONE profile still, and the clip —
// every other uploaded part (extra gesture stills, extra profile angles) is
// DELETED instead of moved. See retainEvidence() in runLivenessChecks.
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
//
// [LIVE-PURGE-1] account-deletion evidence purge: see purgeLivenessEvidence()
// in ./liveness_audit.ts, wired into routes/account.ts deleteAccount() (runs
// immediately at request time, not after the 30-day grace) + a defense-in-depth
// backstop in consumers/src/deletion.ts (30-day cascade).
//
// [LIVE-ATTEST-1] TODO: device_report.attestation_token (Play Integrity / App
// Attest) is currently only length/presence-logged in telemetry + the audit row
// (see deviceReportFromBody below). Real server-side attestation verification
// (Google Play Integrity API / Apple App Attest) is a LATER phase — do not treat
// presence of a token as proof of anything yet.
import type { Env } from "../types";
import { json } from "../util";
import { setVerifiedCache } from "../auth";
import { requireUser, isFail } from "../authz";
import { metaDb, metaSession } from "../db/shard";
import { trackUser, metric, brainFact } from "../hooks";
import { emailFor } from "../lib/identity";
import { notifyUser } from "../notify";
import { avaReasonRaw } from "../lib/ava_reason"; // One Brain B1: gateway for vision/STT
import { aiRunOpts } from "../lib/ai_gate";       // AI Gateway cost-logging opts
import { invalidateLevelCache } from "./ladder";
import { markGatePassed } from "./ava_guardian"; // U1-lite: flip pending verify gate on liveness pass (dark)
import { recordLivenessAudit, auditPrefix, deviceCtxFromBody } from "./liveness_audit";
import { readConfig } from "./config";
import { rekognitionConfigured, compareFaces } from "../aws/rekognition";

// [LIVE-RETRY-1] Owner decision 2026-07-04: users may retry until they pass —
// a legit user can need many takes (lighting, accent, gestures). 20/24h is an
// abuse/cost guard only (each verify ≤ MAX_LLAVA_CALLS model calls), not UX.
// Only COMPLETED verifies (pass/fail) count — abandoned starts don't burn budget.
const MAX_ATTEMPTS_24H = 20;
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

// [LIVE-LANG-1] localized challenge phrase pools. Each pool is 16 common,
// concrete, phonetically-distinct nouns — chosen so Whisper's multilingual
// model transcribes them reliably even with background noise/accent variance.
// English stays the fallback/default for any lang not listed.
const PHRASE_WORDS_EN = [
  "river", "orange", "window", "tiger", "cloud", "guitar", "marble", "rocket",
  "silver", "candle", "forest", "puzzle", "anchor", "velvet", "comet", "lantern",
];
const PHRASE_WORDS_ES = [
  "rio", "naranja", "ventana", "tigre", "nube", "guitarra", "marmol", "cohete",
  "plata", "vela", "bosque", "rompecabezas", "ancla", "terciopelo", "cometa", "farol",
];
const PHRASE_WORDS_FR = [
  "riviere", "orange", "fenetre", "tigre", "nuage", "guitare", "marbre", "fusee",
  "argent", "bougie", "foret", "puzzle", "ancre", "velours", "comete", "lanterne",
];
const PHRASE_WORDS_DE = [
  "fluss", "orange", "fenster", "tiger", "wolke", "gitarre", "marmor", "rakete",
  "silber", "kerze", "wald", "puzzle", "anker", "samt", "komet", "laterne",
];
const PHRASE_POOLS: Record<string, readonly string[]> = {
  en: PHRASE_WORDS_EN, es: PHRASE_WORDS_ES, fr: PHRASE_WORDS_FR, de: PHRASE_WORDS_DE,
};
const SUPPORTED_LANGS = new Set(["en", "es", "fr", "de"]);
const normalizeLang = (lang: unknown): string => {
  const l = String(lang ?? "").toLowerCase().slice(0, 2);
  return SUPPORTED_LANGS.has(l) ? l : "en";
};

/** [LIVE-LANG-1] strip diacritics/accents (é→e, ñ→n, ü→u, …) so fuzzy phrase
 * matching against Whisper's (often accent-flattened) transcript works for
 * non-English challenge words. */
const stripDiacritics = (s: string): string =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "");

interface Challenge { actions: string[]; phrase: string; lang: string; created_at: number; }

function workersAiEnabled(env: Env): Promise<boolean> {
  // Merge KV over code DEFAULTS (readConfig) — a raw KV read silently reports
  // "off" for any flag added after the KV blob was last written (2026-07-04 outage).
  return readConfig(env)
    .then((c) => c.workersAiLivenessEnabled === true)
    .catch(() => false);
}

// [LIVE-ATTEMPTS-KV-1] 24h attempt counter moved OFF the D1 hot-path COUNT query
// (that scan gets expensive at scale — 1M/day verifies). KV key
// liveness:att:<uid>:<yyyymmdd> (UTC calendar day), incremented ONLY when a
// verify COMPLETES (pass/fail) in runLivenessChecks — never on /start or an
// abandoned session, matching the old D1 semantics. We approximate the rolling
// 24h window by summing TODAY's + YESTERDAY's UTC-day buckets: this over-counts
// slightly near a day boundary (a user could see a slightly tighter budget for a
// few hours) but that's fine for an abuse/cost guard, not a UX promise. D1
// verification_attempts rows are still written for audit — just no longer
// COUNT-queried on the hot path.
const dayKey = (uid: string, ts: number): string => {
  const d = new Date(ts);
  const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  return `liveness:att:${uid}:${ymd}`;
};
const ATTEMPT_KV_TTL_S = 2 * 86_400; // 2 days — covers today+yesterday buckets with margin

async function attemptsLast24h(env: Env, uid: string): Promise<number> {
  try {
    const now = Date.now();
    const [today, yesterday] = await Promise.all([
      env.TOKENS.get(dayKey(uid, now)),
      env.TOKENS.get(dayKey(uid, now - DAY)),
    ]);
    return (Number(today) || 0) + (Number(yesterday) || 0);
  } catch {
    return 0; // KV unavailable — fail open (never block a verify on a counter read)
  }
}

/** [LIVE-ATTEMPTS-KV-1] increment today's UTC-day bucket by 1. Best-effort. */
async function bumpAttemptCounter(env: Env, uid: string): Promise<void> {
  try {
    const key = dayKey(uid, Date.now());
    const cur = Number(await env.TOKENS.get(key)) || 0;
    await env.TOKENS.put(key, String(cur + 1), { expirationTtl: ATTEMPT_KV_TTL_S });
  } catch { /* best-effort — a lost increment only slightly loosens the abuse guard */ }
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

  // [LIVE-LANG-1] optional {lang} in the start body — default "en". Any
  // unrecognized/missing value normalizes to "en" (normalizeLang).
  const startBody = (await req.json().catch(() => ({}))) as { lang?: string };
  const lang = normalizeLang(startBody.lang);

  const sid = crypto.randomUUID();
  const actions = pick(ACTIONS, 2).map((a) => a.id);
  const phrase = pick(PHRASE_POOLS[lang] ?? PHRASE_WORDS_EN, 3).join(" ");
  const challenge: Challenge = { actions, phrase, lang, created_at: Date.now() };
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
    "liveness_session_started", "avaid", { provider: "workersai", session_id: sid, lang });
  metric(env, "liveness_wai_session", [1]);
  // The challenge is only revealed now — recording starts immediately, so a
  // pre-prepared clip can't match the random actions + phrase.
  return json({
    session_id: sid,
    challenge: { actions, phrase, lang, max_seconds: 10 },
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
    const r: any = await avaReasonRaw(env, {
      role: "liveness", capability: "vision", trigger: "challenge", feature: "liveness_vision",
      verb: "see", model: VISION_MODEL,
      raw: { image: [...new Uint8Array(image)], prompt, max_tokens: 8 },
      aiRunOpts: aiRunOpts(env),
    });
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

// [LIVE-DEVAUTH-1] the on-device signal bundle the client MAY send with verify.
// checks.* are the client's own detector verdicts (ML Kit face detection +
// gesture/eye/occlusion heuristics already run on-device for UX gating); when
// livenessDeviceAuthoritative is ON and ALL of these are true, the server skips
// the equivalent (expensive) LLaVA calls. ml_kit carries raw scores for audit
// only — never used to gate the verdict server-side (that would trust the
// client with the pass/fail decision). attestation_token presence/length is
// recorded for telemetry now; real verification is [LIVE-ATTEST-1] (later).
export interface DeviceReport {
  checks?: { single_face?: boolean; occlusion_clear?: boolean; turn_left?: boolean; turn_right?: boolean; eyes_open?: boolean };
  ml_kit?: Record<string, number>;
  attestation_token?: string;
  platform?: "android" | "ios";
}
const deviceReportFromBody = (body: unknown): DeviceReport | undefined => {
  const b = (body ?? {}) as Record<string, unknown>;
  const dr = b.device_report as Record<string, unknown> | undefined;
  if (!dr || typeof dr !== "object") return undefined;
  const c = (dr.checks ?? {}) as Record<string, unknown>;
  return {
    checks: {
      single_face: c.single_face === true, occlusion_clear: c.occlusion_clear === true,
      turn_left: c.turn_left === true, turn_right: c.turn_right === true, eyes_open: c.eyes_open === true,
    },
    ml_kit: (dr.ml_kit && typeof dr.ml_kit === "object") ? (dr.ml_kit as Record<string, number>) : undefined,
    attestation_token: typeof dr.attestation_token === "string" ? dr.attestation_token.slice(0, 4096) : undefined,
    platform: dr.platform === "ios" ? "ios" : dr.platform === "android" ? "android" : undefined,
  };
};
const allDeviceChecksTrue = (d?: DeviceReport): boolean => {
  const c = d?.checks;
  if (!c) return false;
  return !!(c.single_face && c.occlusion_clear && c.turn_left && c.turn_right && c.eyes_open);
};

const resultKey = (uid: string, sid: string) => `liveness:result:${uid}:${sid}`;
const deviceReportKey = (uid: string, sid: string) => `liveness:devrep:${uid}:${sid}`;

// [LIVE-QUEUE-1] queue message shape for the self-consumed liveness-verify queue.
interface LivenessQueueMsg { uid: string; sid: string; }

// POST /api/id/liveness/verify {session_id, device_report?}
// LIVE-V2 P0: validate the session, then run the checks in the BACKGROUND and
// return 202 immediately. The client polls GET /api/id/liveness/result.
//
// [LIVE-QUEUE-1] preferred path: enqueue {uid, sid} onto LIVENESS_QUEUE, which
// THIS SAME worker self-consumes (src/index.ts queue handler) — avoids the
// forbidden cross-package import of runLivenessChecks into consumers/ (see the
// header comment + wrangler.toml). On ANY send() failure (binding not deployed
// yet, queue not created via `wrangler queues create liveness-verify`) we fall
// back to the original ctx.waitUntil(runLivenessChecks(...)) path so nothing
// breaks before that one-time infra step runs. The queue consumer calls the
// EXACT SAME exported runLivenessChecks with req=undefined (geo becomes null —
// already handled, see the device ctx comment inside runLivenessChecks).
export async function livenessVerify(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const auth = await requireUser(req, env);
  if (isFail(auth)) return json({ error: auth.error }, auth.status);

  const b = (await req.json().catch(() => ({}))) as { session_id?: string; device_report?: unknown };
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

  // [LIVE-DEVAUTH-1] stash the device_report (if any) alongside the challenge so
  // runLivenessChecks (queue OR waitUntil path — both read from KV, not the
  // request body) can pick it up. Best-effort; a lost report just means the
  // verify falls back to the full LLaVA pipeline (safe default).
  const deviceReport = deviceReportFromBody(b);
  if (deviceReport) {
    await env.TOKENS.put(deviceReportKey(auth.uid, sid), JSON.stringify(deviceReport), { expirationTtl: CHALLENGE_TTL_S }).catch(() => {});
  }

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

  // [LIVE-QUEUE-1] try the queue first; fall back to waitUntil on ANY error.
  let queueUsed = false;
  try {
    if (env.LIVENESS_QUEUE) {
      await env.LIVENESS_QUEUE.send({ uid: auth.uid, sid } as LivenessQueueMsg);
      queueUsed = true;
    }
  } catch (e) {
    // Binding missing / queue not yet created (`wrangler queues create
    // liveness-verify`) / send() transient error — fall through to waitUntil.
    console.error("[liveness] LIVENESS_QUEUE.send failed, falling back to waitUntil:", String(e));
    queueUsed = false;
  }

  // [LIVENESS-TEL-1] accepted marker + a crash marker on the background job:
  // if the pipeline throws, the client polls until its 90s cap with NO stored
  // result — this event is the only server-side breadcrumb for that hang.
  void trackUser(env, auth.uid, await emailFor(env, auth.uid).catch(() => null),
    "liveness_verify_accepted", "avaid", { session_id: sid, image_parts: imageParts.length, queue_used: queueUsed });

  if (!queueUsed) {
    // Fallback: kick off the real checks in the background via ctx.waitUntil,
    // exactly as before the queue existed.
    const work = runLivenessChecks(env, auth.uid, sid, req).catch(async (e) => {
      console.error("[liveness] background verify failed:", String(e));
      void trackUser(env, auth.uid, await emailFor(env, auth.uid).catch(() => null),
        "liveness_verify_error", "avaid", { session_id: sid, error: String(e).slice(0, 300) });
      metric(env, "liveness_verify_error", [1]);
    });
    if (ctx) ctx.waitUntil(work); else await work; // no ctx in tests → run inline
  }
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
    // [LIVE-STORAGE-1] delete any staged uploads for the dead session too.
    try {
      const listing = await env.VERIFICATION.list({ prefix: sessionPrefix(ctx.uid, sid) });
      for (const o of listing.objects ?? []) { try { await env.VERIFICATION.delete(o.key); } catch { /* */ } }
    } catch { /* best-effort */ }
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
    opts: {
      verified: boolean; level?: number;
      telemetry?: {
        llava_calls?: number; rekognition_used?: boolean;
        // [LIVE-DEVAUTH-1]
        device_authoritative?: boolean; audit_sampled?: boolean;
        // [LIVE-RETAIN-2]
        retained_parts?: number;
      };
    },
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
      device_authoritative: opts.telemetry?.device_authoritative ?? false,
      audit_sampled: opts.telemetry?.audit_sampled ?? false,
      ...(opts.telemetry?.retained_parts != null ? { retained_parts: opts.telemetry.retained_parts } : {}),
    });
    metric(env, "liveness_v2_verify", [1]);
    return result;
  };

  // [LIVE-RETAIN-2] Retention DIET on pass (2026-07-05 scaling change — supersedes
  // D15 "store everything" for the RETAIN step, fail-path discardEvidence()
  // unchanged: still delete-all). Every uploaded part used to be MOVED into the
  // retained audit prefix (frames + clip, up to 8 image parts). At 1M/day verifies
  // that's unbounded R2 growth for evidence nobody re-reviews beyond the neutral
  // still + one profile still. We now retain ONLY:
  //   - the neutral still (last non-profile still) → saved as frame0.jpg so the
  //     AvaIdentity green-tick thumbnail keeps working unchanged
  //   - ONE profile still (first profile_* alphabetically, if any present)
  //   - the clip (clip.bin)
  // Every other part (gesture stills, extra profile angles) is DELETED instead of
  // moved. Classification mirrors the neutral/profile logic used later in the
  // pipeline (stillParts/profileParts) but is computed independently here because
  // retainEvidence() can run BEFORE `parts` is loaded (the B8 early-fail path).
  const retainEvidence = async (): Promise<{ prefix: string; thumbKey: string; retainedParts: number }> => {
    const thumbKey = retainedPrefix + "frame0.jpg";
    let retainedParts = 0;
    try {
      const listing = await env.VERIFICATION.list({ prefix });
      const keys = (listing.objects ?? []).map((o) => o.key.slice(prefix.length)).filter(Boolean);
      const profiles = keys.filter((k) => k.startsWith("profile_")).sort();
      const stills = keys.filter((k) => k !== "clip" && !k.startsWith("profile_")).sort();
      const neutralPart = stills.length ? stills[stills.length - 1] : undefined;
      const keepProfile = profiles.length ? profiles[0] : undefined;
      const keepSet = new Set<string>(["clip"]);
      if (neutralPart) keepSet.add(neutralPart);
      if (keepProfile) keepSet.add(keepProfile);

      for (const part of keys) {
        const src = prefix + part;
        if (!keepSet.has(part)) {
          // Not one of the kept parts — delete instead of retaining (diet).
          try { await env.VERIFICATION.delete(src); } catch { /* best-effort */ }
          continue;
        }
        // Kept part: MOVE it into the retained audit prefix. The neutral still is
        // ALWAYS saved as frame0.jpg (green-tick thumbnail contract); the kept
        // profile still is saved under its own name; the clip as clip.bin.
        const dst = part === "clip"
          ? retainedPrefix + "clip.bin"
          : part === neutralPart
            ? retainedPrefix + "frame0.jpg"
            : `${retainedPrefix}${part}.jpg`;
        try {
          const obj = await env.VERIFICATION.get(src);
          if (!obj) continue;
          await env.VERIFICATION.put(dst, await obj.arrayBuffer());
          await env.VERIFICATION.delete(src); // remove the transient upload copy
          retainedParts++;
        } catch { /* best-effort per part */ }
      }
    } catch { /* best-effort listing */ }
    try { await env.TOKENS.delete(`liveness:ch:${ctx.uid}:${sid}`); } catch { /* */ }
    try { await env.TOKENS.delete(deviceReportKey(ctx.uid, sid)); } catch { /* */ }
    return { prefix: retainedPrefix, thumbKey, retainedParts };
  };

  // [LIVE-STORAGE-1] Owner decision 2026-07-04 (supersedes D15 "store everything"
  // for FAILS): a failed verify DELETES its evidence (frames + clip) instead of
  // retaining it. With retries now effectively unlimited (LIVE-RETRY-1), keeping
  // every failed take would grow R2 unboundedly — up to 20 clips/user/day.
  // Evidence is retained ONLY on pass (audit trail + green-tick thumbnail).
  const discardEvidence = async (): Promise<void> => {
    try {
      const listing = await env.VERIFICATION.list({ prefix });
      for (const o of listing.objects ?? []) {
        try { await env.VERIFICATION.delete(o.key); } catch { /* best-effort per part */ }
      }
    } catch { /* best-effort listing */ }
    try { await env.TOKENS.delete(`liveness:ch:${ctx.uid}:${sid}`); } catch { /* */ }
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
    const { prefix: rp, retainedParts } = await retainEvidence();
    await recordLivenessAudit(env, { uid: ctx.uid, provider: "workersai", status: "fail", req, device, r2Prefix: rp });
    await env.DB_META.prepare("UPDATE verification_attempts SET result='fail' WHERE uid=?1 AND session_id=?2").bind(ctx.uid, sid).run().catch(() => {});
    // [LIVE-ATTEMPTS-KV-1] a b8_session fail is still a COMPLETED verify (matches
    // the old D1 `result IN ('pass','fail')` semantics — 'fail' here, not pending).
    await bumpAttemptCounter(env, ctx.uid);
    return finalize(checks, { verified: false, telemetry: { llava_calls: budget.calls, rekognition_used: false, retained_parts: retainedParts } });
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

  // [LIVE-DEVAUTH-1] device-authoritative fast path (default OFF). When the
  // config flag is ON AND the client sent a device_report with ALL checks true,
  // we trust the on-device detector for B2/B3/B4/B7 (marked pass with an
  // `_device` id suffix so the audit trail is honest about what actually ran) and
  // only spend ONE LLaVA call — B1 realness on the neutral still alone (not the
  // usual ≤2-image B1). B6 (Whisper phrase) + B9 (clip sanity) still run for
  // everyone regardless of this flag — those are cheap/free and device-report
  // has no equivalent for "did they say the right words". A random
  // livenessAuditSampleRate fraction ALSO runs the FULL LLaVA pipeline anyway,
  // purely to measure disagreement (never changes the verdict served).
  let deviceAuthPath = false;
  let auditSampled = false;
  try {
    const cfg = await readConfig(env);
    const deviceReport = await env.TOKENS.get(deviceReportKey(ctx.uid, sid), "json").catch(() => null) as DeviceReport | null;
    if (cfg.livenessDeviceAuthoritative && allDeviceChecksTrue(deviceReport ?? undefined)) {
      deviceAuthPath = true;
      const rate = Math.min(1, Math.max(0, cfg.livenessAuditSampleRate ?? 0));
      const buf = new Uint32Array(1);
      crypto.getRandomValues(buf);
      auditSampled = (buf[0] / 0xffffffff) < rate;
      // [LIVE-ATTEST-1] TODO: attestation_token presence/length only, no real
      // verification yet (Play Integrity / App Attest is a later phase).
      void trackUser(env, ctx.uid, await emailFor(env, ctx.uid).catch(() => null),
        "liveness_device_report_seen", "avaid", {
        session_id: sid, platform: deviceReport?.platform ?? null,
        has_attestation_token: !!deviceReport?.attestation_token,
        attestation_token_len: deviceReport?.attestation_token?.length ?? 0,
      });
    }
  } catch { /* config/KV read failure → fall back to the full pipeline (safe default) */ }

  let b1ok: boolean;
  if (deviceAuthPath && !auditSampled) {
    // Fast path: ONE LLaVA call — realness on the neutral still only.
    b1ok = refFrame ? await visionYes(env, budget, refFrame, REALNESS_PROMPT) : false;
  } else {
    // Full pipeline (default OFF path, OR the sampled-audit run under devauth).
    b1ok = realTargets.length > 0;
    for (const t of realTargets.slice(0, 2)) b1ok = b1ok && (await visionYes(env, budget, t, REALNESS_PROMPT));
  }
  addCheck("b1_realness", b1ok);

  // B2 — exactly one person (LLaVA count on neutral). Device-authoritative fast
  // path: trust device_report.checks.single_face, mark pass as `b2_single_person`
  // with the SAME id (client rendering is unaffected) — the `_device` provenance
  // lives in the telemetry flag, not the check id, so old clients don't need
  // updating to understand a new id.
  let b2ok: boolean;
  if (deviceAuthPath && !auditSampled) {
    b2ok = true; // allDeviceChecksTrue() already required single_face === true
  } else {
    b2ok = refFrame ? ((await visionRun(env, budget, refFrame, COUNT_PROMPT))?.startsWith("1") ?? false) : false;
  }
  addCheck(deviceAuthPath && !auditSampled ? "b2_single_person_device" : "b2_single_person", b2ok);

  // B3 — mask / face covering on neutral (prompt asks YES if covered → invert).
  let b3ok: boolean;
  if (deviceAuthPath && !auditSampled) {
    b3ok = true; // occlusion_clear === true required by allDeviceChecksTrue()
  } else {
    b3ok = refFrame ? !(await visionYes(env, budget, refFrame, MASK_PROMPT)) : false;
  }
  addCheck(deviceAuthPath && !auditSampled ? "b3_mask_device" : "b3_mask", b3ok);

  // B4 — challenge gestures. Expression stills use the server-side ACTIONS prompts
  // (matched to the session's random actions when possible; else any ACTIONS prompt
  // whose gesture the frame satisfies). Then up to 2 profile frames are checked for
  // a clear head turn. At least ONE gesture OR profile must pass.
  let gestureResults: boolean[] = [];
  let profileResults: boolean[] = [];
  if (deviceAuthPath && !auditSampled) {
    // turn_left/turn_right already confirmed on-device (required true above).
    // The rollup addCheck below records the single "b4_challenge_device" id.
    gestureResults = [true];
  } else {
    for (let i = 0; i < gestureKeys.length; i++) {
      if (budget.calls >= MAX_LLAVA_CALLS) break;
      // Prefer the action id at this index; fall back to the first challenge action.
      const actionId = challenge.actions[i] ?? challenge.actions[0];
      const action = ACTIONS.find((a) => a.id === actionId) ?? ACTIONS.find((a) => a.id === "smile");
      const ok = action ? await visionYes(env, budget, parts[gestureKeys[i]], action.prompt) : false;
      gestureResults.push(ok);
      addCheck(`b4_challenge_${i}`, ok);
    }
    for (const pk of profileParts.slice(0, 2)) {
      if (budget.calls >= MAX_LLAVA_CALLS) break;
      const ok = await visionYes(env, budget, parts[pk], PROFILE_PROMPT);
      profileResults.push(ok);
      addCheck(`b4_profile_${pk.replace("profile_", "")}`, ok);
    }
  }
  const anyGesture = gestureResults.some(Boolean) || profileResults.some(Boolean);
  // A single rolled-up b4 flag drives the verdict + gives the client one message.
  addCheck(deviceAuthPath && !auditSampled ? "b4_challenge_device" : "b4_challenge", anyGesture);
  const profilesPresent = profileParts.length > 0;
  const profileTurnOk = (deviceAuthPath && !auditSampled) || !profilesPresent || profileResults.some(Boolean);

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
  // [LIVE-LANG-1] normalize accents/diacritics (é→e, ñ→n, ü→u, …) on BOTH the
  // Whisper transcript and the challenge phrase before matching — the old
  // `[^a-z0-9\s]` strip DROPPED accented characters entirely (a raw "é" isn't in
  // a-z0-9), which broke fuzzy matching for es/fr/de words outright. Folding to
  // base Latin letters first means the same fuzzy 2-of-3 logic works unchanged
  // for every supported language.
  let phraseOk: boolean | null = null;
  const clipObj = await env.VERIFICATION.get(prefix + "clip");
  if (clipObj) {
    try {
      const audio = await clipObj.arrayBuffer();
      const r: any = await avaReasonRaw(env, {
        role: "liveness", capability: "stt", trigger: "phrase_check", feature: "liveness_stt",
        verb: "transcribe", model: WHISPER_MODEL,
        raw: { audio: [...new Uint8Array(audio)] }, aiRunOpts: aiRunOpts(env),
      });
      const text = stripDiacritics(String(r?.text ?? "").toLowerCase()).replace(/[^a-z0-9\s]/g, " ");
      const heard = text.split(/\s+/).filter(Boolean);
      const words = stripDiacritics(challenge.phrase.toLowerCase()).split(" ");
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

  // B7 — eyes open on neutral. Device-authoritative: trust device_report's
  // eyes_open (required true by allDeviceChecksTrue()).
  let b7ok: boolean;
  if (deviceAuthPath && !auditSampled) {
    b7ok = true;
  } else {
    b7ok = refFrame ? await visionYes(env, budget, refFrame, EYES_OPEN_PROMPT) : false;
  }
  addCheck(deviceAuthPath && !auditSampled ? "b7_eyes_open_device" : "b7_eyes_open", b7ok);

  // ── Verdict (plan §5B / §D-P3): pass iff ALL of B1,B2,B3,B6,B8 pass AND ≥1 B4
  // gesture passes AND B7 passes AND (a profile turn passed OR profiles missing).
  const passed = b1ok && b2ok && b3ok && b6ok && b8ok && anyGesture && b7ok && profileTurnOk;
  const now = Date.now();

  // [LIVE-DEVAUTH-1] audit-sample disagreement telemetry. `auditSampled` verifies
  // ran the FULL LLaVA pipeline (never the device fast path) purely to compare
  // against what the fast path WOULD have decided (device_report was already
  // fully-true when this branch is taken, so the device-trusted verdict is
  // implicitly "would have passed B2/B3/B4/B7"). Never changes `passed` above.
  if (deviceAuthPath && auditSampled) {
    void trackUser(env, ctx.uid, await emailFor(env, ctx.uid).catch(() => null),
      "liveness_audit_sample", "avaid", {
      session_id: sid,
      device_would_pass: true, // reached this branch only when device checks were all true
      full_pipeline_pass: passed,
      agree: passed === true,
    });
  }

  await env.DB_META.prepare(
    "UPDATE verification_attempts SET result=?1 WHERE uid=?2 AND session_id=?3",
  ).bind(passed ? "pass" : "fail", ctx.uid, sid).run();
  // [LIVE-ATTEMPTS-KV-1] this verify just COMPLETED (pass or fail) — bump the KV
  // 24h counter here (NOT in finalize, which is also called on the B8 session-fail
  // early-exit above where the D1 row + counter are already accounted for).
  await bumpAttemptCounter(env, ctx.uid);

  if (!passed) {
    // [LIVE-STORAGE-1] fail → evidence deleted (audit row keeps the checks/geo,
    // r2_prefix stays NULL). Retention on pass only.
    await discardEvidence();
    await recordLivenessAudit(env, { uid: ctx.uid, provider: "workersai", status: "fail", req, device, r2Prefix: null });
    const failMap: Record<string, boolean> = {};
    for (const c of checks) failMap[c.id] = c.pass;
    await metaDb(env).prepare(
      "UPDATE verification_status SET status='rejected', failure_reason=?2, updated_at=?3 WHERE uid=?1",
    ).bind(ctx.uid, JSON.stringify(failMap), now).run();
    void trackUser(env, ctx.uid, await emailFor(env, ctx.uid).catch(() => null),
      "liveness_failed", "avaid", { provider: "workersai", checks: failMap, session_id: sid });
    metric(env, "liveness_wai_failed", [1]);
    return finalize(checks, {
      verified: false,
      telemetry: { llava_calls: budget.calls, rekognition_used: rekognitionUsed, device_authoritative: deviceAuthPath, audit_sampled: auditSampled },
    });
  }

  // PASS — [LIVE-RETAIN-2] retention DIET: only the neutral still (as frame0.jpg),
  // one profile still, and the clip are retained under liveness/<uid>/<session>/;
  // frame0 stays the AvaIdentity green-tick thumbnail (thumbKey points into the
  // audit prefix). Everything else uploaded for this session was deleted.
  const { prefix: retainedR2Prefix, thumbKey, retainedParts } = await retainEvidence();
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

  // U1-lite (Guardian gate): a live face check just PASSED → flip any pending
  // "Require verification" gate row for this user to 'passed'. Best-effort, detached,
  // and self-gated on guardianGateEnabled (markGatePassed no-ops when the flag is off,
  // so this is a zero-cost dark hook until U1 is turned on). Emits verify_human_passed.
  // TODO(liveness-wire): this is the ONE authoritative liveness-success call site.
  void markGatePassed(env, ctx.uid);

  brainFact(env, ctx.uid, "identity_verified", "identity", { method: kycProvider, at: now }, `${ctx.uid}:identity_verified`);
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

  return finalize(checks, {
    verified: true, level: 2,
    telemetry: {
      llava_calls: budget.calls, rekognition_used: rekognitionUsed, retained_parts: retainedParts,
      device_authoritative: deviceAuthPath, audit_sampled: auditSampled,
    },
  });
}
