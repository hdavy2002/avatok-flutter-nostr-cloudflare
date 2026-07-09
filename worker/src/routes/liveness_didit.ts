// ── Liveness powered by didit.me (owner decision 2026-07-09, [LIVE-DIDIT-1]) ──
// REPLACES the home-grown V2/V3 capture + Rekognition pipeline as the LIVE
// liveness path (v2/v3 code is retired behind the diditLivenessEnabled flag).
//
// Flow:
//   POST /api/liveness/didit/session  (auth) → creates a Didit verification
//        session (workflow = LIVENESS-only, configured via DIDIT_WORKFLOW_ID),
//        stores session_id in KV keyed by uid, returns {url} for the client to
//        open (Didit's hosted capture UI — their SDK does the camera work).
//   GET  /api/liveness/didit/result   (auth) → polls Didit's decision endpoint.
//        Approved → applies the SAME ladder wiring as v3 (verification_status,
//        kyc_status, identity_proofs, verified KV, level-cache invalidation,
//        Guardian gate signal) and returns {verdict:"PASS"}.
//        Declined → bumps the monthly fail counter, returns {verdict:"FAIL"}.
//        Anything else (Not Started / In Progress / In Review…) → {pending:true}.
//
// Policy (owner 2026-07-09, same as [LIVE-NO-REVIEW-1]): binary verdicts, and
// 5 FAILED attempts per calendar month; session creation 429s after that.
//
// Secrets: DIDIT_API_KEY is a Wrangler secret (never in the repo, never on the
// client). DIDIT_WORKFLOW_ID identifies the "AvaTOK Liveness" workflow.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { setVerifiedCache } from "../auth";
import { metaDb } from "../db/shard";
import { track, metric, brainFact } from "../hooks";
import { notifyUser } from "../notify";
import { invalidateLevelCache } from "./ladder";
import { markGatePassed } from "./ava_guardian";

const DIDIT_BASE = "https://verification.didit.me";
const SESSION_TTL_S = 3600;
const MAX_FAILS_MONTH = 5;

const sessKvKey = (uid: string) => `didit:sess:${uid}`;
const monthKey = (uid: string, ts: number): string => {
  const d = new Date(ts);
  return `didit:failm:${uid}:${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};
// A Declined Didit session must only burn ONE monthly try even if the client
// polls the result endpoint repeatedly — dedupe on the session id.
const failCountedKey = (uid: string, sid: string) => `didit:failct:${uid}:${sid}`;

async function failsThisMonth(env: Env, uid: string): Promise<number> {
  try { return Number(await env.TOKENS.get(monthKey(uid, Date.now()))) || 0; } catch { return 0; }
}
async function bumpMonthlyFail(env: Env, uid: string, sid: string): Promise<boolean> {
  try {
    const dedupe = failCountedKey(uid, sid);
    if (await env.TOKENS.get(dedupe)) return false; // already counted
    await env.TOKENS.put(dedupe, "1", { expirationTtl: 32 * 86_400 });
    const key = monthKey(uid, Date.now());
    const cur = Number(await env.TOKENS.get(key)) || 0;
    await env.TOKENS.put(key, String(cur + 1), { expirationTtl: 32 * 86_400 });
    return true;
  } catch { return false; }
}

function diditConfigured(env: Env): boolean {
  return Boolean((env as { DIDIT_API_KEY?: string }).DIDIT_API_KEY && (env as { DIDIT_WORKFLOW_ID?: string }).DIDIT_WORKFLOW_ID);
}

// ── POST /api/liveness/didit/session ─────────────────────────────────────────
export async function diditSession(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  if (!diditConfigured(env)) {
    void track(env, ctx.uid, "didit_session_blocked", "platform", { reason: "not_configured" });
    return json({ error: "liveness unavailable", reason: "not_configured" }, 503);
  }
  const fails = await failsThisMonth(env, ctx.uid);
  if (fails >= MAX_FAILS_MONTH) {
    void track(env, ctx.uid, "didit_session_blocked", "platform", { reason: "monthly_limit", fails });
    return json({
      error: "You've used all 5 tries for this month. Please try again next month.",
      reason: "monthly_limit",
      attempts_remaining: 0,
    }, 429);
  }
  const key = (env as { DIDIT_API_KEY?: string }).DIDIT_API_KEY!;
  const workflowId = (env as { DIDIT_WORKFLOW_ID?: string }).DIDIT_WORKFLOW_ID!;
  let r: Response;
  try {
    // [LIVE-DIDIT-2] callback: the client renders the Didit flow in an IN-APP
    // WebView (owner decision 2026-07-10 — must feel native) and intercepts
    // navigation to this URL to know the flow finished. The route below also
    // serves a friendly fallback page in case interception ever misses.
    const callback = `${new URL(req.url).origin}/api/liveness/didit/done`;
    r = await fetch(`${DIDIT_BASE}/v3/session/`, {
      method: "POST",
      headers: { "x-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        workflow_id: workflowId,
        vendor_data: ctx.uid,
        callback,
        callback_method: "both",
      }),
    });
  } catch (e) {
    void track(env, ctx.uid, "didit_session_error", "platform", { reason: "fetch_failed", detail: String(e).slice(0, 200) });
    return json({ error: "liveness provider unreachable", reason: "provider_unreachable" }, 502);
  }
  if (!r.ok) {
    const body = (await r.text().catch(() => "")).slice(0, 300);
    void track(env, ctx.uid, "didit_session_error", "platform", { reason: "provider_status", status: r.status, body });
    return json({ error: "could not start the check", reason: "provider_error" }, 502);
  }
  const j = await r.json() as { session_id?: string; url?: string };
  if (!j.session_id || !j.url) {
    void track(env, ctx.uid, "didit_session_error", "platform", { reason: "bad_response" });
    return json({ error: "could not start the check", reason: "provider_error" }, 502);
  }
  await env.TOKENS.put(sessKvKey(ctx.uid), j.session_id, { expirationTtl: SESSION_TTL_S });
  void track(env, ctx.uid, "didit_session_created", "platform", { session_id: j.session_id, attempts_remaining: MAX_FAILS_MONTH - fails });
  metric(env, "didit_session_created", [1], ["didit"]);
  return json({ url: j.url, session_id: j.session_id, attempts_remaining: MAX_FAILS_MONTH - fails });
}

// ── GET /api/liveness/didit/done — WebView callback landing (no auth) ────────
// The in-app WebView intercepts navigation to this URL BEFORE it loads; this
// page only renders if interception missed (e.g. an OS webview quirk), so it
// just tells the user to return to the app. Nothing sensitive is exposed.
export function diditDone(): Response {
  return new Response(
    `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<title>AvaTOK</title></head>
<body style="font-family:sans-serif;background:#062D2A;color:#F9F7ED;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center"><h2>All done ✓</h2><p>You can head back to AvaTOK now.</p></div>
</body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

// ── GET /api/liveness/didit/result ───────────────────────────────────────────
export async function diditResult(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  if (!diditConfigured(env)) return json({ error: "liveness unavailable", reason: "not_configured" }, 503);
  const sid = await env.TOKENS.get(sessKvKey(ctx.uid));
  if (!sid) return json({ error: "no active session", reason: "no_session" }, 404);
  const key = (env as { DIDIT_API_KEY?: string }).DIDIT_API_KEY!;
  let r: Response;
  try {
    r = await fetch(`${DIDIT_BASE}/v3/session/${sid}/decision/`, {
      headers: { "x-api-key": key, Accept: "application/json" },
    });
  } catch {
    return json({ pending: true, reason: "provider_unreachable" }); // client keeps polling
  }
  if (!r.ok) return json({ pending: true, reason: `provider_${r.status}` });
  const d = await r.json() as { status?: string };
  const status = String(d.status || "");
  if (status === "Approved") {
    await applyDiditPass(env, ctx.uid, sid);
    await env.TOKENS.delete(sessKvKey(ctx.uid)).catch(() => {});
    void track(env, ctx.uid, "didit_verdict", "platform", { session_id: sid, verdict: "PASS" });
    metric(env, "didit_verdict", [1], ["pass"]);
    return json({ verdict: "PASS", attempts_remaining: Math.max(0, MAX_FAILS_MONTH - (await failsThisMonth(env, ctx.uid))) });
  }
  if (status === "Declined" || status === "Abandoned" || status === "Expired") {
    await bumpMonthlyFail(env, ctx.uid, sid);
    await env.TOKENS.delete(sessKvKey(ctx.uid)).catch(() => {});
    const remaining = Math.max(0, MAX_FAILS_MONTH - (await failsThisMonth(env, ctx.uid)));
    void track(env, ctx.uid, "didit_verdict", "platform", { session_id: sid, verdict: "FAIL", didit_status: status, attempts_remaining: remaining });
    metric(env, "didit_verdict", [1], ["fail"]);
    return json({ verdict: "FAIL", didit_status: status, attempts_remaining: remaining });
  }
  // Not Started / In Progress / In Review / anything unknown → keep polling.
  // (LIVENESS-only workflows auto-decide; In Review is transient here.)
  return json({ pending: true, didit_status: status });
}

// Same ladder wiring as v3's applyPassToLadder, with provider 'didit'.
async function applyDiditPass(env: Env, uid: string, sid: string): Promise<void> {
  const now = Date.now();
  try {
    await metaDb(env).batch([
      metaDb(env).prepare("UPDATE verification_status SET status='verified', verified_at=?2, updated_at=?2 WHERE uid=?1").bind(uid, now),
      metaDb(env).prepare(
        `INSERT INTO kyc_status (uid, status, provider, verified_at, updated_at)
         VALUES (?1,'verified','didit',?2,?2)
         ON CONFLICT(uid) DO UPDATE SET status='verified', provider='didit', verified_at=?2, updated_at=?2`,
      ).bind(uid, now),
      metaDb(env).prepare(
        `INSERT INTO identity_proofs (uid, proof, status, provider, evidence_ref, verified_at, updated_at)
         VALUES (?1,'liveness','verified','didit',?2,?3,?3)
         ON CONFLICT(uid, proof) DO UPDATE SET status='verified', provider='didit', evidence_ref=?2, verified_at=?3, updated_at=?3`,
      ).bind(uid, `didit:${sid}`, now),
    ]);
  } catch { /* best-effort — Didit's session record is the source of truth */ }
  await setVerifiedCache(env, uid, true).catch(() => {});
  await invalidateLevelCache(env, uid).catch(() => {});
  void markGatePassed(env, uid);
  brainFact(env, uid, "identity_verified", "avaid", { method: "didit", at: now });
  try {
    await notifyUser(env, uid, { type: "system", title: "You're verified ✓", body: "Your identity check passed.", data: { deeplink: "/identity" } });
  } catch { /* best-effort */ }
}
