// AvaID — Phase 1 (§10.4). Selfie-video liveness via AWS Rekognition.
//   POST /api/id/session  → start a liveness session (returns SessionId for the
//                           native Amplify Face Liveness UI; rate-limited 3/24h)
//   POST /api/id/result   → fetch Rekognition result; ≥90% confidence auto-verifies
//                           (sets tier='verified', KV cache, brain hook); else reject
//   GET  /api/id/status   → caller's current verification status
//
// Dual auth on all (NIP-98 + Clerk). Rekognition is flag-gated (src/aws/rekognition
// .ts): unset AWS creds → 503 "verification unavailable", everything else still works.
import type { Env } from "../types";
import { json } from "../util";
import { authenticate, isErr, setVerifiedCache } from "../auth";
import { metaDb, metaSession } from "../db/shard";
import { createLivenessSession, getLivenessResults, rekognitionConfigured } from "../aws/rekognition";
import { track, metric, brainFact } from "../hooks";
import { notifyUser } from "../notify";

const MIN_CONFIDENCE = 90;        // §10.4 auto-approve threshold
const MAX_ATTEMPTS_24H = 3;       // §10.4 retry cap
const DAY = 86_400_000;

async function attemptsLast24h(env: Env, npub: string): Promise<number> {
  const row = await metaSession(env)
    .prepare("SELECT COUNT(*) AS n FROM verification_attempts WHERE npub=?1 AND created_at > ?2")
    .bind(npub, Date.now() - DAY).first<{ n: number }>();
  return row?.n ?? 0;
}

// POST /api/id/session
export async function idSession(req: Request, env: Env): Promise<Response> {
  const auth = await authenticate(req, env);
  if (isErr(auth)) return json({ error: auth.error }, auth.status);
  if (!rekognitionConfigured(env)) return json({ error: "verification unavailable", reason: "aws_unconfigured" }, 503);

  if (await attemptsLast24h(env, auth.npub) >= MAX_ATTEMPTS_24H) {
    return json({ error: "too many attempts", retry_after_hours: 24 }, 429);
  }

  let session: { SessionId: string };
  try {
    session = await createLivenessSession(env, { auditImagesLimit: 2 });
  } catch (e: any) {
    metric(env, "avaid_session_error", [1]);
    return json({ error: "liveness session failed", detail: String(e?.message ?? e) }, 502);
  }

  const now = Date.now();
  await metaDb(env).batch([
    metaDb(env).prepare(
      `INSERT INTO verification_status (npub, status, method, session_id, updated_at)
       VALUES (?1,'pending','rekognition_liveness',?2,?3)
       ON CONFLICT(npub) DO UPDATE SET status='pending', session_id=?2, updated_at=?3`,
    ).bind(auth.npub, session.SessionId, now),
    metaDb(env).prepare(
      "INSERT INTO verification_attempts (npub, session_id, result, created_at) VALUES (?1,?2,'pending',?3)",
    ).bind(auth.npub, session.SessionId, now),
  ]);

  track(env, auth.npub, "id_session_started", "avaid", { session_id: session.SessionId });
  metric(env, "avaid_session", [1]);
  return json({ session_id: session.SessionId });
}

// POST /api/id/result  { session_id }
export async function idResult(req: Request, env: Env): Promise<Response> {
  const auth = await authenticate(req, env);
  if (isErr(auth)) return json({ error: auth.error }, auth.status);
  if (!rekognitionConfigured(env)) return json({ error: "verification unavailable", reason: "aws_unconfigured" }, 503);

  const b = (await req.json().catch(() => ({}))) as any;
  const sessionId = String(b.session_id || "");
  if (!sessionId) return json({ error: "session_id required" }, 400);

  // The session must belong to this caller (anti-replay: bind to the row we wrote).
  const owned = await metaSession(env)
    .prepare("SELECT 1 AS ok FROM verification_status WHERE npub=?1 AND session_id=?2")
    .bind(auth.npub, sessionId).first<{ ok: number }>();
  if (!owned) return json({ error: "session not found for this account" }, 404);

  let result: { Status: string; Confidence?: number };
  try {
    result = await getLivenessResults(env, sessionId);
  } catch (e: any) {
    return json({ error: "liveness result failed", detail: String(e?.message ?? e) }, 502);
  }

  const confidence = Number(result.Confidence ?? 0);
  const passed = result.Status === "SUCCEEDED" && confidence >= MIN_CONFIDENCE;
  const now = Date.now();

  await env.DB_META.prepare(
    "UPDATE verification_attempts SET result=?1, confidence=?2 WHERE npub=?3 AND session_id=?4",
  ).bind(passed ? "pass" : "fail", confidence, auth.npub, sessionId).run();

  if (!passed) {
    await metaDb(env).prepare(
      "UPDATE verification_status SET status='rejected', confidence=?2, updated_at=?3 WHERE npub=?1",
    ).bind(auth.npub, confidence, now).run();
    track(env, auth.npub, "id_verification_failed", "avaid", { confidence, status: result.Status });
    const remaining = Math.max(0, MAX_ATTEMPTS_24H - (await attemptsLast24h(env, auth.npub)));
    return json({ verified: false, confidence, status: result.Status, attempts_remaining: remaining });
  }

  // PASS → verified. Flip status + tier, cache in KV, learn it, notify.
  await metaDb(env).batch([
    metaDb(env).prepare(
      "UPDATE verification_status SET status='verified', confidence=?2, verified_at=?3, updated_at=?3 WHERE npub=?1",
    ).bind(auth.npub, confidence, now),
    metaDb(env).prepare(
      `INSERT INTO clerk_nostr_link (npub, clerk_user_id, tier, created_at)
       VALUES (?1, ?2, 'verified', ?3)
       ON CONFLICT(npub) DO UPDATE SET tier='verified'`,
    ).bind(auth.npub, auth.clerkUserId ?? "", now),
  ]);
  await setVerifiedCache(env, auth.npub, true);

  brainFact(env, auth.npub, "identity_verified", "avaid", { method: "rekognition_liveness", confidence, at: now });
  track(env, auth.npub, "id_verified", "avaid", { confidence });
  metric(env, "avaid_verified", [1, confidence]);
  try { await notifyUser(env, auth.npub, { type: "system", title: "You're verified ✓", body: "Tier-2 apps are now unlocked.", data: { deeplink: "/profile" } }); } catch { /* best-effort */ }

  return json({ verified: true, confidence, tier: "verified" });
}

// GET /api/id/status
export async function idStatus(req: Request, env: Env): Promise<Response> {
  const auth = await authenticate(req, env);
  if (isErr(auth)) return json({ error: auth.error }, auth.status);
  const row = await metaSession(env)
    .prepare("SELECT status, confidence, verified_at FROM verification_status WHERE npub=?1")
    .bind(auth.npub).first<{ status: string; confidence: number | null; verified_at: number | null }>();
  return json({
    npub: auth.npub,
    status: row?.status ?? "unverified",
    confidence: row?.confidence ?? null,
    verified_at: row?.verified_at ?? null,
    tier: auth.tier,
    rekognition_configured: rekognitionConfigured(env),
  });
}
