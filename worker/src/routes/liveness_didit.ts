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
import { rateLimit } from "../money"; // shared KV rate limiter (abuse limits)
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

// [LIVE-DIDIT-4] Cached verdict pushed by the webhook (or stored by a poll that
// reached Didit). Result polls serve from THIS first, so a thousand phones
// polling every 3s cost Didit ZERO API calls — critical on the free tier
// (10 req/min general APIs; the earlier stuck-"Checking…" bug was our own
// per-poll decision reads tripping that limit).
const verdictKvKey = (uid: string) => `didit:verdict:${uid}`;
// Per-user throttle stamp for DIRECT decision reads when no verdict is cached.
const lastQueryKvKey = (uid: string) => `didit:lastq:${uid}`;
const DIRECT_QUERY_MIN_INTERVAL_MS = 15_000;

interface CachedVerdict { sid: string; status: string; ts: number; }

async function storeVerdict(env: Env, uid: string, sid: string, status: string): Promise<void> {
  try {
    await env.TOKENS.put(verdictKvKey(uid), JSON.stringify({ sid, status, ts: Date.now() } satisfies CachedVerdict),
      { expirationTtl: 86_400 });
  } catch { /* best-effort */ }
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
  // [LIVE-DIDIT-4] Global create-throttle: Didit caps session creation at
  // 600/min per API key (and free-tier general APIs at 10/min) — stay well
  // under so a launch spike degrades into friendly retries instead of a
  // provider-side block. The client treats 429 as "busy, retry shortly".
  const globalRl = await rateLimit(env, "didit_create_global", 300, 60);
  if (globalRl) {
    void track(env, ctx.uid, "didit_session_blocked", "platform", { reason: "create_throttle" });
    return json({ error: "busy — please try again in a moment", reason: "busy", retry_after_s: 20 }, 429);
  }
  // Per-user: nobody needs more than a few session creates per hour.
  const userRl = await rateLimit(env, `didit_create:${ctx.uid}`, 10, 3600);
  if (userRl) {
    return json({ error: "too many attempts — please wait a few minutes", reason: "user_throttle", retry_after_s: 300 }, 429);
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
  if (r.status === 429) {
    // Didit's own limiter — honor their Retry-After and tell the client to back off.
    const retryAfter = Number(r.headers.get("Retry-After")) || 30;
    void track(env, ctx.uid, "didit_session_blocked", "platform", { reason: "provider_rate_limited", retry_after_s: retryAfter });
    return json({ error: "busy — please try again in a moment", reason: "busy", retry_after_s: retryAfter }, 429);
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
  // A fresh attempt invalidates any cached verdict from a previous session —
  // otherwise a user who failed once would keep being served the stale FAIL.
  await env.TOKENS.delete(verdictKvKey(ctx.uid)).catch(() => {});
  void track(env, ctx.uid, "didit_session_created", "platform", { session_id: j.session_id, attempts_remaining: MAX_FAILS_MONTH - fails });
  metric(env, "didit_session_created", [1], ["didit"]);
  return json({ url: j.url, session_id: j.session_id, attempts_remaining: MAX_FAILS_MONTH - fails });
}

// ── POST /api/liveness/didit/webhook — Didit push (no auth header) ───────────
// [LIVE-DIDIT-4] Registered in the Didit console (destination 87fbf5f6…,
// status.updated, v3). SECURITY MODEL: the payload is treated as an UNTRUSTED
// HINT only — Didit's signing secret isn't retrievable via their API, so
// instead of HMAC we take the session_id from the payload and pull the
// decision from Didit's authenticated API ourselves. A forged webhook can
// therefore only make us re-read the truth (rate-limited), never mint a pass.
export async function diditWebhook(req: Request, env: Env): Promise<Response> {
  if (!diditConfigured(env)) return json({ ok: true });
  // Abuse guard: forged floods can't drain our Didit quota.
  const ip = req.headers.get("CF-Connecting-IP") || "0.0.0.0";
  const rl = await rateLimit(env, `didit_webhook:${ip}`, 240, 60);
  if (rl) return rl;
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const sid = String(
    (b.session_id as string) ?? ((b.data as Record<string, unknown> | undefined)?.session_id as string) ?? "",
  ).trim();
  // UUID shape only — anything else is noise.
  if (!/^[0-9a-f-]{36}$/i.test(sid)) return json({ ok: true });
  const key = (env as { DIDIT_API_KEY?: string }).DIDIT_API_KEY!;
  let d: { status?: string; vendor_data?: unknown } | null = null;
  try {
    const r = await fetch(`${DIDIT_BASE}/v3/session/${sid}/decision/`, {
      headers: { "x-api-key": key, Accept: "application/json" },
    });
    if (r.ok) d = await r.json() as { status?: string; vendor_data?: unknown };
  } catch { /* transient — the client poll fallback still works */ }
  if (!d) return json({ ok: true });
  const uid = String(d.vendor_data ?? "");
  const status = String(d.status ?? "");
  if (!uid.startsWith("user_") || !status) return json({ ok: true });
  await storeVerdict(env, uid, sid, status);
  if (status === "Approved") {
    await applyDiditPass(env, uid, sid);
    await env.TOKENS.delete(sessKvKey(uid)).catch(() => {});
    metric(env, "didit_verdict", [1], ["pass_webhook"]);
  } else if (status === "Declined" || status === "Abandoned" || status === "Expired") {
    await bumpMonthlyFail(env, uid, sid);
    await env.TOKENS.delete(sessKvKey(uid)).catch(() => {});
    metric(env, "didit_verdict", [1], ["fail_webhook"]);
  }
  void track(env, uid, "didit_webhook_received", "platform", { session_id: sid, status });
  return json({ ok: true });
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
  // [LIVE-DIDIT-4] Serve the webhook-pushed verdict from KV FIRST — zero Didit
  // API calls for the common case. Client polls every 3s; on the free tier
  // (10 req/min) per-poll decision reads were tripping Didit's limiter, which
  // is how the 2026-07-10 "stuck on Checking…" happened.
  const cachedRaw = await env.TOKENS.get(verdictKvKey(ctx.uid));
  if (cachedRaw) {
    try {
      const cached = JSON.parse(cachedRaw) as CachedVerdict;
      if (cached.status === "Approved") {
        return json({ verdict: "PASS", attempts_remaining: Math.max(0, MAX_FAILS_MONTH - (await failsThisMonth(env, ctx.uid))) });
      }
      if (cached.status === "Declined" || cached.status === "Abandoned" || cached.status === "Expired") {
        return json({ verdict: "FAIL", didit_status: cached.status, attempts_remaining: Math.max(0, MAX_FAILS_MONTH - (await failsThisMonth(env, ctx.uid))) });
      }
    } catch { /* corrupt cache → fall through */ }
  }
  // No cached verdict → direct read, throttled to one Didit round-trip per
  // user per 15s (the webhook normally lands first; this is the safety net).
  try {
    const lastQ = Number(await env.TOKENS.get(lastQueryKvKey(ctx.uid))) || 0;
    if (Date.now() - lastQ < DIRECT_QUERY_MIN_INTERVAL_MS) {
      return json({ pending: true, reason: "throttled" });
    }
    await env.TOKENS.put(lastQueryKvKey(ctx.uid), String(Date.now()), { expirationTtl: 120 });
  } catch { /* throttle bookkeeping is best-effort */ }
  const key = (env as { DIDIT_API_KEY?: string }).DIDIT_API_KEY!;
  const kvSid = await env.TOKENS.get(sessKvKey(ctx.uid));
  let sid = kvSid || "";
  let status = "";
  if (sid) {
    try {
      const r = await fetch(`${DIDIT_BASE}/v3/session/${sid}/decision/`, {
        headers: { "x-api-key": key, Accept: "application/json" },
      });
      if (r.ok) status = String(((await r.json()) as { status?: string }).status || "");
    } catch { /* fall through to the vendor_data scan */ }
  }
  // [LIVE-DIDIT-3] (2026-07-10) Self-healing fallback: the 2026-07-10 00:08
  // session for hdavy2002 was APPROVED on Didit yet the phone sat on
  // "Checking…" forever — the KV pointer / decision read path failed silently
  // and the pass was never claimed. Sessions carry vendor_data = uid, so when
  // the pointed-at session isn't decisively resolved, scan the account's
  // recent sessions directly and claim the newest decisive one.
  const decisive = (s: string) => s === "Approved" || s === "Declined" || s === "Abandoned" || s === "Expired";
  if (!decisive(status)) {
    try {
      const r = await fetch(`${DIDIT_BASE}/v3/sessions/?vendor_data=${encodeURIComponent(ctx.uid)}`, {
        headers: { "x-api-key": key, Accept: "application/json" },
      });
      if (r.ok) {
        const list = (await r.json()) as { results?: Array<{ session_id?: string; status?: string; created_at?: string }> };
        const dayAgo = Date.now() - 86_400_000;
        const candidates = (list.results ?? [])
          .filter((s) => decisive(String(s.status || "")) && Date.parse(String(s.created_at || "")) > dayAgo)
          .sort((a, b) => Date.parse(String(b.created_at || "")) - Date.parse(String(a.created_at || "")));
        // Prefer an Approved session over a failed one — a user who failed once
        // and then passed must resolve as PASS regardless of ordering quirks.
        const approved = candidates.find((s) => s.status === "Approved");
        const pick = approved ?? candidates[0];
        if (pick?.session_id) {
          sid = String(pick.session_id);
          status = String(pick.status || "");
          void track(env, ctx.uid, "didit_result_fallback", "platform", { session_id: sid, status });
        }
      }
    } catch { /* keep whatever we had */ }
  }
  if (!sid) return json({ error: "no active session", reason: "no_session" }, 404);
  if (!status) return json({ pending: true, reason: "provider_unreachable" }); // client keeps polling
  // Cache whatever we learned so subsequent polls stop hitting Didit.
  if (status === "Approved" || status === "Declined" || status === "Abandoned" || status === "Expired") {
    await storeVerdict(env, ctx.uid, sid, status);
  }
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
