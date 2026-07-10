// [AVA-IDGATE-1] Just-in-time identity gating.
// Spec: Specs/SPEC-2026-07-10-identity-gating.md
//
// ONE JOB: before a user's first PUBLIC interaction, require a valid Didit liveness
// pass. Consumers (people who only watch/read) are never gated. Signup is never
// gated. Payout/KYC is a SEPARATE project and is not touched here.
//
// WHY THIS SHAPE:
//   • Deterrence lands at the moment of intent. A camera weeks earlier, during a
//     signup the user has forgotten, deters nobody. The camera immediately before
//     the first public post is the deterrent.
//   • requireVerifiedKV() (auth.ts) is ALREADY a liveness gate — it reads
//     clerk_account_link.tier, which applyDiditPass() sets. It never touched the
//     phone. We layer a 90-day expiry on top rather than reinventing it.
//
// EXPIRY IS READ FROM `liveness_passed_at`, NEVER FROM `tier`.
// kyc.ts sets the same tier='verified' boolean. Expiring `tier` would silently
// revoke the tier of users who passed a full KYC and re-gate their payouts.
// `tier` is write-only and additive. See spec §3.4.
import type { Env } from "../types";
import { json } from "../util";
import { metaDb } from "../db/shard";
import { readConfig } from "../routes/config";
import { trackUserContact } from "../hooks";

const APP = "avatok";
const DAY_MS = 86_400_000;

/** Public actions that require a valid liveness pass. Spec §3.1. */
export type PublicAction =
  | "post"
  | "listing"
  | "comment"
  | "live"
  | "dm_stranger"
  | "group_post"
  | "upload";

export type GateReason = "never_passed" | "expired" | "grandfather_expired";

interface LivenessRow {
  liveness_passed_at: number | null;
  liveness_source: string | null;
  tier: string | null;
}

/**
 * Resolve a user's liveness state. Returns null on a DB error so the caller can
 * FAIL CLOSED — a post can wait; a bad actor must not slip through on an infra
 * hiccup.
 */
async function readLiveness(env: Env, uid: string): Promise<LivenessRow | null> {
  try {
    return await metaDb(env)
      .prepare("SELECT liveness_passed_at, liveness_source, tier FROM clerk_account_link WHERE uid=?1")
      .bind(uid)
      .first<LivenessRow>();
  } catch {
    return null;
  }
}

/**
 * Best-effort email lookup. Project rule: EVERY telemetry event carries the user's
 * email so support can pull a person's whole history in PostHog by email alone.
 * Never throws; a missing email degrades telemetry, it must never block a request.
 */
export async function emailOf(env: Env, uid: string): Promise<string | null> {
  try {
    const r = await metaDb(env).prepare("SELECT email FROM users WHERE uid=?1").bind(uid).first<{ email: string }>();
    return r?.email ?? null;
  } catch { return null; }
}

/** Days elapsed since the pass, or null if never passed. */
function daysSince(passedAt: number | null | undefined): number | null {
  if (!passedAt) return null;
  return Math.floor((Date.now() - passedAt) / DAY_MS);
}

export interface LivenessState {
  valid: boolean;
  reason?: GateReason;
  daysSincePass: number | null;
  source: string | null;
}

/**
 * The canonical check. `validityDays` comes from the `livenessValidityDays` flag
 * (default 90) so the window can be widened from KV without a redeploy — which is
 * the contingency if Didit's per-call cost bites (spec §9).
 */
export async function livenessState(env: Env, uid: string): Promise<LivenessState> {
  let validityDays = 90;
  try {
    const cfg = await readConfig(env);
    if (typeof cfg.livenessValidityDays === "number" && cfg.livenessValidityDays > 0) {
      validityDays = cfg.livenessValidityDays;
    }
  } catch { /* DEFAULTS is the source of truth; 90 is the documented default */ }

  const row = await readLiveness(env, uid);
  if (row === null) {
    // DB error. Caller fails closed. Distinguished from "no row" below by the
    // identity_gate_error event the caller emits.
    return { valid: false, reason: "never_passed", daysSincePass: null, source: null };
  }

  const d = daysSince(row.liveness_passed_at);
  if (d === null) {
    return { valid: false, reason: "never_passed", daysSincePass: null, source: null };
  }
  if (d >= validityDays) {
    // A grandfathered user hitting expiry is a different story from a real user
    // re-verifying: they have NEVER faced a camera. Worth its own reason string
    // so the day-30..90 wave is legible in PostHog.
    const reason: GateReason =
      row.liveness_source === "grandfathered" ? "grandfather_expired" : "expired";
    return { valid: false, reason, daysSincePass: d, source: row.liveness_source };
  }
  return { valid: true, daysSincePass: d, source: row.liveness_source };
}

/**
 * Gate a public action. Returns a 403 Response to short-circuit, or null to proceed.
 *
 * NAMED `gatePublicAction`, NOT `requireLiveness` — `authz.ts` already exports a
 * DIFFERENT `requireLiveness()` (the old `livenessOnboardingGate`, which reads
 * kyc_status and returns an AuthFail). Two functions with one name, opposite return
 * types and different flags is how a gate silently stops gating. Keep them distinct.
 *
 * The 403 contract is `{ error: "identity_required", reason, action }`. The client
 * intercepts it, opens the liveness flow, and RETRIES the original request — see
 * app/lib/features/identity/identity_gate.dart. This pattern already existed for
 * `phone_required`; we generalised it rather than inventing a new one.
 *
 * FAIL CLOSED on any error. An unverified user posting because D1 blipped is a
 * worse outcome than a verified user seeing one spurious camera prompt.
 */
export async function gatePublicAction(
  env: Env,
  uid: string,
  email: string | null | undefined,
  action: PublicAction,
): Promise<Response | null> {
  let on = false;
  try {
    on = (await readConfig(env)).identityGatingEnabled === true;
  } catch {
    on = false; // flag unreadable ⇒ gate off. The gate is new; do not brick the app.
  }
  if (!on) {
    void trackUserContact(env, uid, email, null, "identity_gate_flag_off", APP, { action });
    return null;
  }

  let st: LivenessState;
  try {
    st = await livenessState(env, uid);
  } catch (e) {
    void trackUserContact(env, uid, email, null, "identity_gate_error", APP, {
      action, err: String(e).slice(0, 200),
    });
    return json({ error: "identity_required", reason: "never_passed", action }, 403);
  }

  if (st.valid) {
    void trackUserContact(env, uid, email, null, "identity_gate_passed", APP, {
      action, days_since_pass: st.daysSincePass, liveness_source: st.source,
    });
    return null;
  }

  void trackUserContact(env, uid, email, null, "identity_gate_hit", APP, {
    action, reason: st.reason, days_since_pass: st.daysSincePass, liveness_source: st.source,
  });
  if (st.reason === "expired" || st.reason === "grandfather_expired") {
    void trackUserContact(env, uid, email, null, "liveness_expired_recheck", APP, {
      action, days_since_pass: st.daysSincePass,
      was_grandfathered: st.source === "grandfathered",
    });
  }
  return json({ error: "identity_required", reason: st.reason, action }, 403);
}

/**
 * Record a real Didit liveness pass. Called from applyDiditPass().
 *
 * Writes `tier='verified'` for backward compatibility with every existing reader
 * of requireVerifiedKV(), and `liveness_passed_at` as the expiry source of truth.
 * NEVER clears `tier` — see the header note.
 */
export async function recordLivenessPass(
  env: Env, uid: string, sessionId: string,
): Promise<void> {
  const now = Date.now();
  await metaDb(env)
    .prepare(
      `UPDATE clerk_account_link
          SET liveness_passed_at = ?2,
              liveness_source    = 'didit',
              liveness_ref       = ?3,
              tier               = 'verified'
        WHERE uid = ?1`,
    )
    .bind(uid, now, `didit:${sessionId}`)
    .run();
}

/**
 * BIPA §15(b): informed written consent BEFORE capture, and a publicly available
 * retention schedule. Both are required; without them ANY retention period is
 * exposed regardless of length. Spec §10.4.
 *
 * RETENTION TRACK — spec §10.2. `extended` (584-day video retention) applies ONLY
 * where we have positive evidence the user is not an IL/TX resident. Unknown or
 * missing residency ⇒ `protective`, always. IP geolocation tells you where a
 * DEVICE is, not where a PERSON resides; BIPA protects Illinois residents wherever
 * they happen to be standing, carries a private right of action, and statutory
 * damages of $1k-$5k per violation. One misgeolocated Illinois resident whose face
 * video we kept is a live claim. Resolving ambiguity toward retention is the one
 * direction that cannot be undone.
 */
const PROTECTED_STATES = new Set(["IL", "TX"]);

export function retentionTrackFor(residencyState: string | null | undefined): "extended" | "protective" {
  if (!residencyState) return "protective";              // unknown ⇒ protective
  const s = residencyState.trim().toUpperCase();
  if (s.length !== 2) return "protective";               // unparseable ⇒ protective
  if (PROTECTED_STATES.has(s)) return "protective";
  return "extended";
}

export async function recordBiometricConsent(
  env: Env,
  uid: string,
  email: string | null | undefined,
  policyVersion: string,
  residencyState: string | null,
): Promise<"extended" | "protective"> {
  const track = retentionTrackFor(residencyState);
  const now = Date.now();
  await metaDb(env)
    .prepare(
      `UPDATE users
          SET biometric_consent_at = ?2,
              biometric_consent_version = ?3,
              residency_state = ?4,
              retention_track = ?5
        WHERE uid = ?1`,
    )
    .bind(uid, now, policyVersion, residencyState ?? null, track)
    .run();

  void trackUserContact(env, uid, email, null, "biometric_consent_recorded", APP, {
    policy_version: policyVersion, residency_state: residencyState ?? null, retention_track: track,
    $set: { biometric_consent_version: policyVersion, residency_state: residencyState ?? null, retention_track: track },
  });
  void trackUserContact(env, uid, email, null, "retention_track_assigned", APP, {
    track, basis: residencyState ? "self_declared" : "unknown_default",
  });
  return track;
}

/**
 * POST /api/liveness/consent
 * Body: { consent: true, residency_state?: "CA" }
 *
 * MUST be called before a Didit session is created. BIPA §15(b) requires informed
 * written consent BEFORE biometric capture — an electronic signature satisfies
 * "written" (Public Act 103-0769, effective 2024-08-02). A pre-ticked box, an
 * inferred consent, or a buried ToS link does not satisfy the statute.
 *
 * `consent: false` is a legitimate answer: the user does not pass the gate, and
 * NOTHING is captured. Never treat a refusal as an error.
 */
export async function biometricConsent(req: Request, env: Env, uid: string, email: string | null): Promise<Response> {
  const b = (await req.json().catch(() => ({}))) as { consent?: boolean; residency_state?: string };
  if (b.consent !== true) {
    void trackUserContact(env, uid, email, null, "liveness_consent_declined", APP, {});
    return json({ ok: false, reason: "consent_declined" }, 200);
  }
  let version = "2026-07-10-v1";
  try {
    const cfg = await readConfig(env);
    if (typeof cfg.biometricConsentVersion === "string") version = cfg.biometricConsentVersion;
  } catch { /* documented default */ }

  const state = (b.residency_state ?? "").trim().toUpperCase() || null;
  const track = await recordBiometricConsent(env, uid, email, version, state);
  void trackUserContact(env, uid, email, null, "liveness_consent_granted", APP, {
    policy_version: version, residency_state: state, retention_track: track,
  });
  return json({ ok: true, policy_version: version, retention_track: track });
}

/**
 * Has this user given biometric consent under the CURRENT policy version?
 * A bumped policy version (new disclosure text, changed retention period) invalidates
 * prior consent — that is the point of versioning it. Re-consent before re-capture.
 */
export async function hasCurrentConsent(env: Env, uid: string): Promise<boolean> {
  try {
    let version = "2026-07-10-v1";
    try {
      const cfg = await readConfig(env);
      if (typeof cfg.biometricConsentVersion === "string") version = cfg.biometricConsentVersion;
    } catch { /* documented default */ }
    const r = await metaDb(env)
      .prepare("SELECT biometric_consent_at, biometric_consent_version FROM users WHERE uid=?1")
      .bind(uid).first<{ biometric_consent_at: number | null; biometric_consent_version: string | null }>();
    return !!r?.biometric_consent_at && r.biometric_consent_version === version;
  } catch {
    return false; // fail closed: no proof of consent ⇒ do not capture biometrics
  }
}

/**
 * Legal hold (spec §10.5). While set, deletion and evidence-purge paths MUST refuse.
 * Destroying liveness evidence on an account under a filed CSAM report may
 * constitute spoliation — and Cloudflare's own CSAM guidance says preserve for one
 * year, not six months.
 */
export async function isLegalHold(env: Env, uid: string): Promise<boolean> {
  try {
    const r = await metaDb(env)
      .prepare("SELECT legal_hold FROM users WHERE uid=?1")
      .bind(uid).first<{ legal_hold: number }>();
    return Number(r?.legal_hold ?? 0) === 1;
  } catch {
    // Fail CLOSED: if we cannot tell whether a hold exists, do not delete.
    // Deleting evidence we were obliged to keep is unrecoverable; retaining data
    // one extra day is not.
    return true;
  }
}
