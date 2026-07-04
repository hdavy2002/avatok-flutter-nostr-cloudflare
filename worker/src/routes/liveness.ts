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
import { track, metric, brainFact } from "../hooks";
import { notifyUser } from "../notify";
import { invalidateLevelCache } from "./ladder";
import { recordLivenessAudit, auditPrefix, deviceCtxFromBody } from "./liveness_audit";

const MAX_ATTEMPTS_24H = 3;             // shared budget with the other providers
const DAY = 86_400_000;
const CHALLENGE_TTL_S = 900;            // 15 min to finish a session
const MAX_FRAME_BYTES = 1_500_000;      // ~1.5 MB JPEG
const MAX_CLIP_BYTES = 16_000_000;      // ~16 MB clip
const VISION_MODEL = "@cf/llava-hf/llava-1.5-7b-hf";
const WHISPER_MODEL = "@cf/openai/whisper";
const RESULT_TTL_S = 3600;              // LIVE-V2 P0: verify outcome cached in KV 1h
const VERIFY_PROVIDER = "workersai";

// LIVE-V2 P0: human-readable message for each structured check id (plan §5B).
// The client renders the FIRST failing check's user_message as the fail reason.
const CHECK_MESSAGES: Record<string, string> = {
  realness: "This looks like a photo of a screen or picture. Use your live camera.",
  phrase: "We couldn't hear the phrase clearly.",
  turn_left: "We couldn't see you complete the movements.",
  turn_right: "We couldn't see you complete the movements.",
  smile: "We couldn't see you complete the movements.",
  sad_face: "We couldn't see you complete the movements.",
  mouth_open: "We couldn't see you complete the movements.",
  eyebrows_raised: "We couldn't see you complete the movements.",
  missing_frames: "We didn't receive the challenge photos — try again.",
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

const PHRASE_WORDS = [
  "river", "orange", "window", "tiger", "cloud", "guitar", "marble", "rocket",
  "silver", "candle", "forest", "puzzle", "anchor", "velvet", "comet", "lantern",
];

interface Challenge { actions: string[]; phrase: string; created_at: number; }

function workersAiEnabled(env: Env): Promise<boolean> {
  return env.TOKENS.get("platform_config", "json")
    .then((c: any) => c?.workersAiLivenessEnabled === true)
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
    return json({ error: "workers-ai liveness disabled", reason: "flag_off" }, 503);
  }
  if (await attemptsLast24h(env, ctx.uid) >= MAX_ATTEMPTS_24H) {
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

  track(env, ctx.uid, "liveness_session_started", "avaid", { provider: "workersai" });
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
  if (!/^(frame[0-2]|clip)$/.test(part)) return json({ error: "bad part" }, 400);
  const ch = await env.TOKENS.get(`liveness:ch:${ctx.uid}:${sid}`);
  if (!ch) return json({ error: "session expired" }, 410);

  const body = await req.arrayBuffer();
  const cap = part === "clip" ? MAX_CLIP_BYTES : MAX_FRAME_BYTES;
  if (body.byteLength === 0 || body.byteLength > cap) return json({ error: "bad size" }, 413);

  await env.VERIFICATION.put(sessionPrefix(ctx.uid, sid) + part, body);
  return json({ ok: true, part, bytes: body.byteLength });
}

async function visionYes(env: Env, image: ArrayBuffer, prompt: string): Promise<boolean> {
  try {
    const r: any = await env.AI.run(VISION_MODEL as any, {
      image: [...new Uint8Array(image)],
      prompt,
      max_tokens: 8,
    } as any);
    const text = String(r?.description ?? r?.response ?? "").trim().toUpperCase();
    return text.startsWith("YES");
  } catch {
    return false;
  }
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
  if (!chRaw) return json({ error: "session expired — start again" }, 410);

  // Idempotency: if this session was already verified, return the stored outcome
  // as done (a client double-tap / re-poll must not re-run LLaVA or re-charge).
  const existing = await env.TOKENS.get(resultKey(auth.uid, sid), "json").catch(() => null);
  if (existing) return json({ status: "done", ...(existing as LivenessResult) }, 200);

  // Required parts present? (Same gate as the old sync path — frame0 + frame1.)
  const prefix = sessionPrefix(auth.uid, sid);
  const [f0, f1] = await Promise.all([
    env.VERIFICATION.head(prefix + "frame0"),
    env.VERIFICATION.head(prefix + "frame1"),
  ]);
  if (!f0 || !f1) {
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
  const work = runLivenessChecks(env, auth.uid, sid, req).catch((e) => {
    console.error("[liveness] background verify failed:", String(e));
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

  // LIVE-V2 P0: build the structured checks[] (plan §5B) + legacy map from a flat
  // id→bool map, store the outcome in KV, and return it. Central exit for the
  // background run so both fail and pass persist the poll-able result.
  const finalize = async (map: Record<string, boolean>, opts: { verified: boolean; level?: number }): Promise<LivenessResult> => {
    const checksArr = Object.entries(map).map(([id, pass]) => ({ id, pass, user_message: pass ? "" : checkMessage(id) }));
    const result: LivenessResult = {
      verified: opts.verified,
      checks: checksArr,
      checks_map: map,
      attempts_remaining: Math.max(0, MAX_ATTEMPTS_24H - (await attemptsLast24h(env, ctx.uid))),
      ...(opts.level != null ? { level: opts.level } : {}),
    };
    await env.TOKENS.put(resultKey(ctx.uid, sid), JSON.stringify(result), { expirationTtl: RESULT_TTL_S }).catch(() => {});
    track(env, ctx.uid, "liveness_verify_result", "avaid", {
      pass: opts.verified,
      failed_checks: checksArr.filter((c) => !c.pass).map((c) => c.id),
      duration_ms: Date.now() - startedAt,
      provider: VERIFY_PROVIDER,
    });
    return result;
  };

  // D15 (2026-07-03): STORE EVERYTHING. On BOTH pass and fail, MOVE every part
  // (frames + clip) from the upload prefix into the retained audit prefix instead
  // of deleting. `keepThumbAt` names the frame0 copy that also stays the
  // AvaIdentity green-tick thumbnail. Returns the retained prefix + thumb key.
  const retainEvidence = async (): Promise<{ prefix: string; thumbKey: string }> => {
    const thumbKey = retainedPrefix + "frame0.jpg";
    const parts: Array<[string, string]> = [
      ["frame0", "frame0.jpg"],
      ["frame1", "frame1.jpg"],
      ["frame2", "frame2.jpg"],
      ["clip", "clip.bin"],
    ];
    for (const [src, dst] of parts) {
      try {
        const obj = await env.VERIFICATION.get(prefix + src);
        if (!obj) continue;
        await env.VERIFICATION.put(retainedPrefix + dst, await obj.arrayBuffer());
        await env.VERIFICATION.delete(prefix + src); // remove the transient upload copy
      } catch { /* best-effort per part */ }
    }
    try { await env.TOKENS.delete(`liveness:ch:${ctx.uid}:${sid}`); } catch { /* */ }
    return { prefix: retainedPrefix, thumbKey };
  };

  // Frames: frame0+frame1 = the two challenge actions, frame2 = neutral realness shot.
  const frames: (ArrayBuffer | null)[] = [];
  for (const p of ["frame0", "frame1", "frame2"]) {
    const obj = await env.VERIFICATION.get(prefix + p);
    frames.push(obj ? await obj.arrayBuffer() : null);
  }
  if (!frames[0] || !frames[1]) {
    const { prefix: rp } = await retainEvidence();
    await recordLivenessAudit(env, { uid: ctx.uid, provider: "workersai", status: "fail", req, device, r2Prefix: rp });
    return finalize({ missing_frames: false }, { verified: false });
  }

  const checks: Record<string, boolean> = {};

  // 1. Per-action gesture checks.
  for (let i = 0; i < challenge.actions.length; i++) {
    const action = ACTIONS.find((a) => a.id === challenge.actions[i]);
    checks[challenge.actions[i]] = action ? await visionYes(env, frames[i]!, action.prompt) : false;
  }
  // 2. Realness (anti photo-of-screen) on every frame we have.
  let real = true;
  for (const f of frames) if (f) real = real && (await visionYes(env, f, REALNESS_PROMPT));
  checks.realness = real;

  // 3. Spoken phrase via Whisper on the clip (SOFT in v1 — transcription of
  //    mobile codecs varies; gesture + realness are the hard gates, and the
  //    random phrase still defeats pre-recorded clips because the user must
  //    start recording after seeing it).
  let phraseOk: boolean | null = null;
  const clipObj = await env.VERIFICATION.get(prefix + "clip");
  if (clipObj) {
    try {
      const audio = await clipObj.arrayBuffer();
      const r: any = await env.AI.run(WHISPER_MODEL as any, { audio: [...new Uint8Array(audio)] } as any);
      const text = String(r?.text ?? "").toLowerCase();
      const words = challenge.phrase.split(" ");
      phraseOk = words.filter((w) => text.includes(w)).length >= 2; // 2 of 3 words
    } catch {
      phraseOk = null; // transcription unavailable — soft pass
    }
  }
  checks.phrase = phraseOk !== false;

  const gesturesOk = challenge.actions.every((a) => checks[a]);
  const passed = gesturesOk && checks.realness && checks.phrase;
  const now = Date.now();

  await env.DB_META.prepare(
    "UPDATE verification_attempts SET result=?1 WHERE uid=?2 AND session_id=?3",
  ).bind(passed ? "pass" : "fail", ctx.uid, sid).run();

  if (!passed) {
    const { prefix: rp } = await retainEvidence(); // D15: keep evidence on fail too
    await recordLivenessAudit(env, { uid: ctx.uid, provider: "workersai", status: "fail", req, device, r2Prefix: rp });
    await metaDb(env).prepare(
      "UPDATE verification_status SET status='rejected', failure_reason=?2, updated_at=?3 WHERE uid=?1",
    ).bind(ctx.uid, JSON.stringify(checks), now).run();
    track(env, ctx.uid, "liveness_failed", "avaid", { provider: "workersai", checks });
    metric(env, "liveness_wai_failed", [1]);
    return finalize(checks, { verified: false });
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
  track(env, ctx.uid, "id_verified", "avaid", { provider: kycProvider });
  metric(env, "liveness_wai_verified", [1]);
  try {
    await notifyUser(env, ctx.uid, {
      type: "system", title: "You're verified ✓",
      body: "Creator features and verified apps are now unlocked.",
      data: { deeplink: "/identity" },
    });
  } catch { /* best-effort */ }

  return finalize(checks, { verified: true, level: 2 });
}
