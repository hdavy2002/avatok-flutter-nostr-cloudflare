// AvaIdentity — Phase 3. Stripe Identity (document + matching-selfie KYC) as a
// SECOND provider behind the SAME AvaID gateway (routes/id.ts). Rekognition
// liveness stays as the lightweight tier; Stripe is the strong doc-KYC the
// gating matrix (universal §5) requires for creator/payout actions.
//
//   POST /api/id/session {provider:'stripe'}  → handled here via stripeKycSession
//                                               (id.ts branches on body.provider)
//   POST /webhooks/stripe-identity            → verification_session.* events
//   GET/POST /api/agreements/*                → A1 compliance: versioned doc
//                                               acceptance (creator agreement)
//
// We NEVER store document images — Stripe holds them; we keep only the
// VerificationReport id (kyc_status.report_id). Flag-gated: no STRIPE_SECRET_KEY
// ⇒ 503, everything else still works.
import type { Env } from "../types";
import { json } from "../util";
import { setVerifiedCache } from "../auth";
import { requireUser, isFail, type UserCtx } from "../authz";
import { metaDb, metaSession } from "../db/shard";
import { track, metric, brainFact } from "../hooks";
import { notifyUser } from "../notify";
import { verifyStripeSig } from "./wallet";

export function stripeIdentityConfigured(env: Env): boolean {
  return !!env.STRIPE_SECRET_KEY;
}

const STRIPE_VERSION = "2024-06-20"; // pinned for ephemeral keys (mobile SDK)

async function stripe<T = any>(env: Env, path: string, form: Record<string, string>, extraHeaders: Record<string, string> = {}): Promise<T> {
  const res = await fetch("https://api.stripe.com" + path, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded", ...extraHeaders },
    body: new URLSearchParams(form).toString(),
  });
  const j = (await res.json()) as any;
  if (!res.ok) throw new Error(`stripe ${path} ${res.status}: ${j?.error?.message ?? "error"}`);
  return j as T;
}

// Called from id.ts idSession when body.provider === 'stripe'. Shares the same
// 3-attempts/24h budget as the Rekognition path (caller enforces it).
export async function stripeKycSession(ctx: UserCtx, env: Env): Promise<Response> {
  if (!stripeIdentityConfigured(env)) {
    return json({ error: "verification unavailable", reason: "stripe_unconfigured" }, 503);
  }

  let vs: { id: string; client_secret: string; url?: string };
  try {
    vs = await stripe(env, "/v1/identity/verification_sessions", {
      type: "document",
      "options[document][require_matching_selfie]": "true",
      "options[document][require_live_capture]": "true",
      "metadata[uid]": ctx.uid,
    });
  } catch (e: any) {
    metric(env, "avaid_stripe_session_error", [1]);
    return json({ error: "stripe identity session failed", detail: String(e?.message ?? e) }, 502);
  }

  // Ephemeral key for the native mobile SDK (web fallback uses vs.url).
  let ephemeralKey: string | null = null;
  try {
    const ek = await stripe<{ secret: string }>(env, "/v1/ephemeral_keys",
      { verification_session: vs.id }, { "Stripe-Version": STRIPE_VERSION });
    ephemeralKey = ek.secret;
  } catch { /* hosted-page fallback still works without it */ }

  const now = Date.now();
  await metaDb(env).batch([
    metaDb(env).prepare(
      `INSERT INTO verification_status (uid, status, method, session_id, failure_reason, updated_at)
       VALUES (?1,'pending','stripe_identity',?2,NULL,?3)
       ON CONFLICT(uid) DO UPDATE SET status='pending', method='stripe_identity', session_id=?2, failure_reason=NULL, updated_at=?3`,
    ).bind(ctx.uid, vs.id, now),
    metaDb(env).prepare(
      "INSERT INTO verification_attempts (uid, session_id, result, provider, created_at) VALUES (?1,?2,'pending','stripe',?3)",
    ).bind(ctx.uid, vs.id, now),
  ]);

  track(env, ctx.uid, "id_session_started", "avaid", { provider: "stripe", session_id: vs.id });
  metric(env, "avaid_stripe_session", [1]);
  return json({ provider: "stripe", session_id: vs.id, client_secret: vs.client_secret, ephemeral_key: ephemeralKey, url: vs.url ?? null });
}

// POST /webhooks/stripe-identity — identity.verification_session.* events.
// Updates verification_status + kyc_status exactly like the Rekognition path.
export async function stripeIdentityWebhook(req: Request, env: Env): Promise<Response> {
  const payload = await req.text();
  const sig = req.headers.get("stripe-signature");
  if (env.STRIPE_IDENTITY_WEBHOOK_SECRET) {
    if (!(await verifyStripeSig(payload, sig, env.STRIPE_IDENTITY_WEBHOOK_SECRET))) {
      return json({ error: "bad signature" }, 400);
    }
  }
  let evt: any;
  try { evt = JSON.parse(payload); } catch { return json({ error: "bad payload" }, 400); }
  const type = String(evt?.type || "");
  if (!type.startsWith("identity.verification_session.")) return json({ received: true, ignored: type });

  const vs = evt?.data?.object ?? {};
  const sessionId = String(vs.id || "");
  if (!sessionId) return json({ received: true });

  // uid from session metadata; fall back to our own row (anti-spoof: we only
  // act on sessions we created and recorded).
  let uid: string | null = vs?.metadata?.uid ? String(vs.metadata.uid) : null;
  const row = await metaSession(env)
    .prepare("SELECT uid FROM verification_status WHERE session_id=?1")
    .bind(sessionId).first<{ uid: string }>();
  if (!row) return json({ received: true, ignored: "unknown session" });
  if (!uid || uid !== row.uid) uid = row.uid;

  const now = Date.now();

  if (type === "identity.verification_session.verified") {
    const reportId = vs.last_verification_report ? String(vs.last_verification_report) : null;
    await metaDb(env).batch([
      metaDb(env).prepare(
        "UPDATE verification_status SET status='verified', method='stripe_identity', failure_reason=NULL, verified_at=?2, updated_at=?2 WHERE uid=?1",
      ).bind(uid, now),
      metaDb(env).prepare(
        `INSERT INTO kyc_status (uid, status, provider, session_id, report_id, verified_at, updated_at)
         VALUES (?1,'verified','stripe_identity',?2,?3,?4,?4)
         ON CONFLICT(uid) DO UPDATE SET status='verified', provider='stripe_identity', session_id=?2, report_id=?3, verified_at=?4, updated_at=?4`,
      ).bind(uid, sessionId, reportId, now),
      metaDb(env).prepare(
        "UPDATE verification_attempts SET result='pass' WHERE uid=?1 AND session_id=?2",
      ).bind(uid, sessionId),
    ]);
    await setVerifiedCache(env, uid, true);
    brainFact(env, uid, "identity_verified", "avaid", { method: "stripe_identity", at: now });
    track(env, uid, "id_verified", "avaid", { provider: "stripe" });
    metric(env, "avaid_stripe_verified", [1]);
    try { await notifyUser(env, uid, { type: "system", title: "You're verified ✓", body: "Creator features are now unlocked.", data: { deeplink: "/identity" } }); } catch { /* best-effort */ }
    return json({ received: true, status: "verified" });
  }

  if (type === "identity.verification_session.requires_input") {
    const reason = vs?.last_error?.reason ? String(vs.last_error.reason) : "requires_input";
    await metaDb(env).batch([
      metaDb(env).prepare(
        "UPDATE verification_status SET status='pending_input', failure_reason=?2, updated_at=?3 WHERE uid=?1",
      ).bind(uid, reason.slice(0, 200), now),
      metaDb(env).prepare(
        "UPDATE verification_attempts SET result='fail' WHERE uid=?1 AND session_id=?2",
      ).bind(uid, sessionId),
    ]);
    track(env, uid, "id_verification_failed", "avaid", { provider: "stripe", reason });
    return json({ received: true, status: "pending_input" });
  }

  if (type === "identity.verification_session.canceled") {
    await metaDb(env).prepare(
      "UPDATE verification_status SET status='rejected', failure_reason='canceled', updated_at=?2 WHERE uid=?1",
    ).bind(uid, now).run();
    return json({ received: true, status: "canceled" });
  }

  return json({ received: true, ignored: type });
}

// ─────────────────────────────────────────────────────────────────────────────
// A1 — agreement acceptance (versioned docs in R2 BLOBS under agreements/).
// Current versions come from env (CSV "doc_id:version,..."), default v1.
// ─────────────────────────────────────────────────────────────────────────────

export function currentAgreementVersion(env: Env, docId: string): string {
  const csv = env.AGREEMENT_VERSIONS ?? "";
  for (const pair of csv.split(",")) {
    const [d, v] = pair.split(":").map((s) => s.trim());
    if (d === docId && v) return v;
  }
  return "1";
}

export async function agreementAccepted(env: Env, uid: string, docId: string): Promise<boolean> {
  const v = currentAgreementVersion(env, docId);
  const r = await metaSession(env)
    .prepare("SELECT 1 AS ok FROM agreement_acceptances WHERE uid=?1 AND doc_id=?2 AND version=?3")
    .bind(uid, docId, v).first<{ ok: number }>();
  return !!r;
}

// GET /api/agreements/status?doc_id=creator-agreement
export async function agreementStatus(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const docId = (new URL(req.url).searchParams.get("doc_id") || "creator-agreement").trim();
  const version = currentAgreementVersion(env, docId);
  const accepted = await agreementAccepted(env, ctx.uid, docId);
  return json({ doc_id: docId, current_version: version, accepted });
}

// GET /api/agreements/doc?doc_id= — versioned markdown served from R2.
export async function agreementDoc(req: Request, env: Env): Promise<Response> {
  const docId = (new URL(req.url).searchParams.get("doc_id") || "creator-agreement").trim();
  if (!/^[a-z0-9-]{1,40}$/.test(docId)) return json({ error: "bad doc_id" }, 400);
  const version = currentAgreementVersion(env, docId);
  const obj = await env.BLOBS.get(`agreements/${docId}/v${version}.md`);
  if (!obj) return json({ error: "doc not found", doc_id: docId, version }, 404);
  return new Response(obj.body, { headers: { "Content-Type": "text/markdown; charset=utf-8", "X-Doc-Version": version } });
}

// POST /api/agreements/accept {doc_id, version}
export async function agreementAccept(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  const docId = String(b.doc_id || "").trim();
  const version = String(b.version || "").trim();
  if (!docId || !version) return json({ error: "doc_id and version required" }, 400);
  const current = currentAgreementVersion(env, docId);
  if (version !== current) return json({ error: "stale version", current_version: current }, 409);

  const ip = req.headers.get("CF-Connecting-IP") ?? null;
  await metaDb(env).prepare(
    "INSERT OR IGNORE INTO agreement_acceptances (id, uid, doc_id, version, accepted_at, ip) VALUES (?1,?2,?3,?4,?5,?6)",
  ).bind(crypto.randomUUID(), ctx.uid, docId, version, Date.now(), ip).run();

  track(env, ctx.uid, "agreement_accepted", "compliance", { doc_id: docId, version });
  return json({ ok: true, doc_id: docId, version });
}
