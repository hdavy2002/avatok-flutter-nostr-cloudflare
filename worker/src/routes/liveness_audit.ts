// STREAM H (AI Messenger Batch) — [LIVE-GATE-1/2] shared liveness audit trail.
//
// Owner decision 2026-07-03 (D15): STORE EVERYTHING for BOTH pass and fail
// (reverses the old delete-on-pass/fail behaviour). Every verification ATTEMPT
// — pass, fail, or abandoned — writes one row into `liveness_audit` (DB_META),
// capturing the request geo/IP + client device fingerprint + the R2 prefix where
// the clip + audit frames are retained for safety review.
//
// Consumers: id.ts (Rekognition), liveness.ts (Workers AI), and the abandoned
// sweep (a cron entry — see the eng report; index.ts has no `scheduled` handler
// yet, so the sweep is dark until a cron trigger is wired).
import type { Env } from "../types";
import { metaDb } from "../db/shard";

export interface DeviceCtx { device_model?: string; os?: string; app_version?: string; }

/** Pull the device fingerprint the client sends in a verify body (best-effort). */
export function deviceCtxFromBody(body: unknown): DeviceCtx {
  const b = (body ?? {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" && v ? v.slice(0, 120) : undefined);
  return { device_model: s(b.device_model), os: s(b.os), app_version: s(b.app_version) };
}

/** Cloudflare edge geo/network context for the current request (never client-set). */
export function edgeCtx(req: Request): { ip: string | null; country: string | null; city: string | null; colo: string | null; asn: string | null } {
  const cf = ((req as any).cf ?? {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" && v ? v : null);
  const ip = req.headers.get("cf-connecting-ip");
  const country = s(cf.country) ?? req.headers.get("cf-ipcountry");
  const asn = cf.asn != null ? String(cf.asn) : null;
  return { ip: ip || null, country: country || null, city: s(cf.city), colo: s(cf.colo), asn };
}

/**
 * Insert one audit row. Best-effort — a failure here must NEVER break a verify
 * (the gate decision has already been made by the caller). `r2Prefix` is the
 * `liveness/<uid>/<session>/` key prefix where evidence now lives.
 */
export async function recordLivenessAudit(env: Env, args: {
  uid: string;
  provider: "rekognition" | "workersai";
  status: "pass" | "fail" | "abandoned";
  confidence?: number | null;
  req?: Request | null;
  device?: DeviceCtx;
  r2Prefix?: string | null;
}): Promise<void> {
  try {
    const geo = args.req ? edgeCtx(args.req) : { ip: null, country: null, city: null, colo: null, asn: null };
    const d = args.device ?? {};
    await metaDb(env).prepare(
      `INSERT INTO liveness_audit
        (id, uid, provider, status, confidence, ip, country, city, colo, asn,
         device_model, os, app_version, r2_prefix, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)`,
    ).bind(
      crypto.randomUUID(), args.uid, args.provider, args.status,
      args.confidence ?? null, geo.ip, geo.country, geo.city, geo.colo, geo.asn,
      d.device_model ?? null, d.os ?? null, d.app_version ?? null,
      args.r2Prefix ?? null, Date.now(),
    ).run();
  } catch { /* audit is best-effort — never block a verify */ }
}

/** Canonical R2 prefix (D15): liveness/<uid>/<session>/  in the VERIFICATION bucket. */
export const auditPrefix = (uid: string, session: string) => `liveness/${uid}/${session}/`;

const ABANDON_STALE_MS = 15 * 60_000; // 15 min — a 'pending' session older than this is abandoned.

/**
 * [LIVE-GATE-1] Abandoned-session sweep. Marks verification attempts that were
 * started but never verified (still 'pending' after 15 min) as 'abandoned' and
 * writes a liveness_audit row for each. Idempotent: an already-audited session is
 * skipped (we only audit attempts with no existing 'abandoned' audit row).
 *
 * NOTE: index.ts currently exports only `fetch` + `queue` — there is NO
 * `scheduled` handler and wrangler.toml declares no `[triggers] crons`. This
 * function is therefore DORMANT until a cron entry point calls it (see the eng
 * report). It can also be invoked manually from an admin route if needed.
 */
export async function sweepAbandonedLiveness(env: Env): Promise<{ swept: number }> {
  const cutoff = Date.now() - ABANDON_STALE_MS;
  let swept = 0;
  try {
    const rows = await metaDb(env).prepare(
      `SELECT va.uid AS uid, va.session_id AS session_id, va.provider AS provider
         FROM verification_attempts va
        WHERE va.result = 'pending' AND va.created_at < ?1
          AND NOT EXISTS (
            SELECT 1 FROM liveness_audit la
             WHERE la.uid = va.uid AND la.status = 'abandoned'
               AND la.r2_prefix = 'liveness/' || va.uid || '/' || va.session_id || '/')
        LIMIT 200`,
    ).bind(cutoff).all<{ uid: string; session_id: string; provider: string }>();
    for (const r of rows.results ?? []) {
      const provider = r.provider === "rekognition" ? "rekognition" : "workersai";
      await recordLivenessAudit(env, {
        uid: r.uid, provider, status: "abandoned",
        r2Prefix: auditPrefix(r.uid, r.session_id),
      });
      try {
        await metaDb(env).prepare(
          "UPDATE verification_attempts SET result='abandoned' WHERE uid=?1 AND session_id=?2 AND result='pending'",
        ).bind(r.uid, r.session_id).run();
      } catch { /* best-effort */ }
      swept++;
    }
  } catch { /* best-effort sweep */ }
  return { swept };
}

/**
 * [LIVE-PURGE-1] Best-effort deletion of ALL liveness evidence for a user, called
 * from the account-deletion path so "your video is erased the moment you close
 * your account" (the UI promise) is actually true, not just a 30-day-grace
 * D1 row flip. Covers BOTH R2 prefixes liveness.ts writes to:
 *   - u/<uid>/liveness/<sid>/       — transient in-flight upload prefix
 *   - liveness/<uid>/<sid>/         — D15 retained audit prefix (pass evidence)
 * Also drops the identity_proofs 'liveness' row (evidence_ref pointed at the now-
 * deleted thumbnail) so no dangling R2 reference remains in D1. Paginated via
 * cursor (R2 list caps at 1000/page) — safe for a user with many sessions.
 * NEVER throws: this runs inside a teardown flow that must not be blocked by a
 * single missing bucket/binding.
 */
export async function purgeLivenessEvidence(env: Env, uid: string): Promise<{ deleted: number }> {
  let deleted = 0;
  const wipe = async (prefix: string) => {
    try {
      let cursor: string | undefined;
      do {
        const list: any = await env.VERIFICATION.list({ prefix, cursor, limit: 1000 });
        const keys: string[] = (list.objects ?? []).map((o: { key: string }) => o.key);
        for (const k of keys) {
          try { await env.VERIFICATION.delete(k); deleted++; } catch { /* best-effort per key */ }
        }
        cursor = list.truncated ? list.cursor : undefined;
      } while (cursor);
    } catch { /* best-effort — bucket/list failure never blocks account teardown */ }
  };
  await wipe(`u/${uid}/liveness/`);
  await wipe(`liveness/${uid}/`);
  try { await metaDb(env).prepare("DELETE FROM identity_proofs WHERE uid=?1 AND proof='liveness'").bind(uid).run(); } catch { /* best-effort */ }
  return { deleted };
}

/**
 * Copy the Rekognition audit images from GetFaceLivenessSessionResults into R2
 * under liveness/<uid>/<session>/audit<i>.jpg and return the prefix. Rekognition
 * returns AuditImages[].Bytes as base64 (JSON-1.1). Best-effort per image.
 */
export async function storeRekognitionAuditImages(
  env: Env,
  uid: string,
  session: string,
  auditImages: Array<{ Bytes?: string }> | undefined,
  referenceImage?: { Bytes?: string },
): Promise<string> {
  const prefix = auditPrefix(uid, session);
  const b64ToBytes = (b64: string): Uint8Array => {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };
  const puts: Promise<unknown>[] = [];
  (auditImages ?? []).forEach((img, i) => {
    if (img?.Bytes) {
      try { puts.push(env.VERIFICATION.put(`${prefix}audit${i}.jpg`, b64ToBytes(img.Bytes))); } catch { /* skip */ }
    }
  });
  if (referenceImage?.Bytes) {
    try { puts.push(env.VERIFICATION.put(`${prefix}reference.jpg`, b64ToBytes(referenceImage.Bytes))); } catch { /* skip */ }
  }
  try { await Promise.all(puts); } catch { /* best-effort */ }
  return prefix;
}
