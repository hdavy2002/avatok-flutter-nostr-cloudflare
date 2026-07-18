// ── brainIngest — the ONE server-lane entry point for the brain (SPEC §3) ────
//
// Every server-side producer enters the brain through here. In one place this
// guarantees:
//   • registry-resolved consent key + scope (callers NEVER send scope — §2.1);
//   • a consent check that FAILS CLOSED (any error → drop, never ingest);
//   • device_private domains HARD-REJECTED at the server edge (a buggy/compromised
//     producer cannot upload content by mislabelling it — §2.1);
//   • one canonical Q_BRAIN envelope with a stable idempotencyKey so the consumer's
//     unique index on (uid, idempotency_key) makes ingestion effectively-once (§3.2).
//
// It is fire-and-forget for callers (returns a Promise they may `void` or
// `waitUntil`). A telemetry failure or queue hiccup never breaks the request.

import type { Env } from "../types";
import { track, metric } from "../hooks";
import {
  BRAIN_DOMAINS,
  type BrainDomain,
  type BrainConsentKey,
  type BrainScope,
} from "./brain_domains";

export interface BrainIngestInput {
  /** Envelope version. Defaults to 1. */
  v?: 1;
  /** Account id (AccountScope) — never a device id. */
  uid: string;
  /** Registered brain domain (unknown domains fail at the type level). */
  domain: BrainDomain;
  /** Event kind within the domain, e.g. 'listing_published'. */
  kind: string;
  /**
   * Stable id of the producing row/event. Combined with (uid, domain, kind) into
   * the idempotency key so queue redelivery / client retry / multi-device
   * double-fire collapse to one row. Strongly recommended.
   */
  sourceId?: string;
  /** Precomputed idempotency key (rare — normally derived from sourceId). */
  idempotencyKey?: string;
  /** Human-readable one-liner for embedding/recall. */
  text?: string;
  /** Structured metadata for the event. */
  meta?: Record<string, unknown>;
  /** Event time (client clock). serverTs is assigned on ingest. */
  ts?: number;
  /** Optional raw email so dropped-event telemetry is pullable by support. */
  email?: string | null;
}

export interface BrainIngestResult {
  ok: boolean;
  dropped?: boolean;
  reason?: "device_private" | "no_consent" | "consent_error" | "queue_error" | "acl_safety";
}

// FNV-1a (32-bit) → hex. Deterministic, synchronous, bounded length. The
// idempotency key needs only to be stable + collision-resistant per (uid,domain,
// kind,sourceId) — not cryptographic. crypto.subtle is avoided (async).
function fnv1aHex(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function idempotencyKeyFor(uid: string, domain: string, kind: string, sourceId?: string): string {
  // hash(uid, domain, kind, sourceId) per §3.2. When no sourceId is supplied we
  // fall back to a random suffix so distinct events never collide (at-least-once
  // dedup simply won't apply to those — acceptable for low-volume producers).
  const src = sourceId != null && sourceId !== "" ? sourceId : `rnd:${crypto.randomUUID()}`;
  return fnv1aHex(`${uid}\x00${domain}\x00${kind}\x00${src}`);
}

// Consent capability names that MAY still hold a stored opt-out row from BEFORE
// the B0 key migration. A user who opted out under a LEGACY capability (e.g.
// avatok_messages / group_chats / voicemails / <app>_files) must STILL be honoured
// even though the registry now uses a single new key. Mirrors the consumer's
// legacyAliasesFor() in consumers/src/brain.ts — keep the two in sync. Keyed by
// NEW consent key.
function legacyAliasesFor(consentKey: string): string[] {
  switch (consentKey) {
    case "messages":  return ["avatok_messages", "group_chats"];
    case "voicemail": return ["voicemails"];
    case "files":     return ["avatok_files", "avalibrary_files", "avastorage_files"];
    default:          return [];
  }
}

/**
 * Consent check — FAILS CLOSED. Returns true only when the master switch AND the
 * domain's consent key (AND any LEGACY alias of that key) are all un-disabled
 * (absence of a row = default ON / opt-out). Legacy aliases are checked so a user
 * who opted out under a pre-B0 capability name is not silently re-ingested. Any D1
 * error → false (drop the event). This is the exact inverse of the old fail-OPEN
 * behaviour that let a consent-store outage leak data.
 */
async function consentAllows(env: Env, uid: string, consentKey: BrainConsentKey): Promise<boolean> {
  const keys = ["master", consentKey, ...legacyAliasesFor(consentKey)];
  try {
    const ph = keys.map((_, i) => `?${i + 2}`).join(",");
    const rs = await env.DB_BRAIN.prepare(
      `SELECT capability, enabled FROM brain_consent WHERE uid=?1 AND capability IN (${ph})`,
    ).bind(uid, ...keys).all();
    for (const r of (rs.results ?? []) as Array<{ enabled: number }>) {
      if (Number(r.enabled) === 0) return false;
    }
    return true;
  } catch {
    return false; // FAIL CLOSED
  }
}

/**
 * The single server-lane brain ingestion entry point. Scope is derived from the
 * registry; device_private is rejected; consent fails closed; one canonical
 * envelope is enqueued to Q_BRAIN with a stable idempotency key.
 */
export async function brainIngest(env: Env, input: BrainIngestInput): Promise<BrainIngestResult> {
  const { uid, domain, kind } = input;
  if (!uid || !domain || !kind) return { ok: false, dropped: true, reason: "no_consent" };

  // §10.3 ACL — the legal-basis `safety` store is NEVER written through this public
  // lane. It is a separate store (guardian_events) written directly, and only, by
  // lib/guardian/. A producer (or a spoofed one) cannot inject a safety record by
  // labelling an event domain:'safety' — reject it at the edge (basis:'legal' has
  // no consent key to gate on anyway). This also keeps `def.consent` a real
  // capability string below, since the only null-consent domain is excluded here.
  if (domain === "safety") {
    try {
      metric(env, "brain_ingest_rejected_acl_safety", [1], [domain, kind]);
      void track(env, uid, "ingest_rejected_acl_safety", "avabrain", {
        domain, kind, ...(input.email ? { email: input.email } : {}),
      });
    } catch { /* telemetry best-effort */ }
    return { ok: false, dropped: true, reason: "acl_safety" };
  }

  const def = BRAIN_DOMAINS[domain];
  const scope: BrainScope = def.scope;
  // Non-null: the only null-consent domain ('safety') was rejected above, so every
  // domain reaching here is consent-based (§10.1). The cast strips the `null` the
  // registry union contributes for legal-basis rows.
  const consentKey: BrainConsentKey = def.consent as BrainConsentKey;

  // 1. HARD-REJECT device_private at the server edge. Content indexed on-device
  //    (§2.1) must use the device-only API; it can never enter the server brain,
  //    no matter what a producer claims.
  if (scope === "device_private") {
    try {
      metric(env, "brain_ingest_rejected_device_private", [1], [domain, kind]);
      void track(env, uid, "ingest_rejected_device_private", "avabrain", {
        domain, kind, consent_key: consentKey, ...(input.email ? { email: input.email } : {}),
      });
    } catch { /* telemetry best-effort */ }
    return { ok: false, dropped: true, reason: "device_private" };
  }

  // 2. Consent — fail CLOSED.
  let allowed: boolean;
  try {
    allowed = await consentAllows(env, uid, consentKey);
  } catch {
    allowed = false;
  }
  if (!allowed) {
    try {
      metric(env, "brain_ingest_dropped_no_consent", [1], [domain, kind]);
      void track(env, uid, "ingest_dropped_no_consent", "avabrain", {
        domain, kind, consent_key: consentKey, ...(input.email ? { email: input.email } : {}),
      });
    } catch { /* telemetry best-effort */ }
    return { ok: false, dropped: true, reason: "no_consent" };
  }

  // 3. Enqueue ONE canonical envelope. New consumers read {v,domain,kind,
  //    idempotencyKey,...}; the legacy mirror fields (event_type/source_app/
  //    payload/capability/scope) keep the CURRENT consumer working until it is
  //    rewritten (Agent B). Dedup on insert (unique (uid, idempotency_key)) is the
  //    consumer's job; we only guarantee the key is present + stable.
  const now = Date.now();
  const idempotencyKey = input.idempotencyKey || idempotencyKeyFor(uid, domain, kind, input.sourceId);
  const meta = input.meta ?? {};
  const envelope = {
    v: input.v ?? 1,
    uid,
    domain,
    kind,
    idempotencyKey,
    idempotency_key: idempotencyKey, // snake_case mirror for the D1 column
    text: input.text ?? "",
    meta,
    ts: input.ts ?? now,
    serverTs: now,
    scope,
    consentKey,
    // ── legacy BrainMsg compatibility (transitional) ──
    event_type: kind,
    source_app: domain,
    payload: meta,
    capability: consentKey,
  };

  try {
    await env.Q_BRAIN.send(envelope);
    return { ok: true };
  } catch {
    try { metric(env, "brain_ingest_queue_error", [1], [domain, kind]); } catch { /* noop */ }
    return { ok: false, dropped: true, reason: "queue_error" };
  }
}
