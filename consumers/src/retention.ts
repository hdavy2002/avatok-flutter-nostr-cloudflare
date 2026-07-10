// [AVA-IDGATE-1] Biometric retention after account deletion.
// Spec: Specs/SPEC-2026-07-10-identity-gating.md §10
//
// Owner intent: keep enough to answer a government request after a user deletes
// their account. Implemented as three tracks, because a single blanket rule does not
// survive contact with either BIPA or the CSAM preservation duty.
//
//   Track A — 'extended'   : deleted account, CONFIRMED non-IL/TX resident.
//                            Liveness video RETAINED 256 days. Metadata retained 256d.
//   Track B — 'protective' : IL/TX resident, OR residency UNKNOWN.
//                            Video DELETED at account deletion. Metadata retained 256d.
//   Track C — legal hold   : nothing deleted, ever. Handled in deletion.ts, not here.
//
// WHY UNKNOWN FAILS PROTECTIVE:
// Illinois BIPA (740 ILCS 14) protects Illinois RESIDENTS regardless of where AvaTok is
// incorporated, and it is the only biometric statute with a PRIVATE RIGHT OF ACTION —
// $1,000 per negligent violation, $5,000 per intentional. IP geolocation tells you where
// a DEVICE is, not where a PERSON resides. An Illinois resident on holiday in Florida is
// still protected. One misgeolocated Illinois resident whose face video we kept is a live
// claim. Retaining a video we should have deleted is unrecoverable; deleting a video we
// could have kept costs us a file we would almost certainly never have used. So ambiguity
// resolves toward deletion, always.
//
// WHY METADATA IS ALWAYS KEPT:
// A lawful request asks: did this account exist, who was it, when was it verified, how.
// That is answered by metadata. The face video adds almost nothing to the answer and
// carries all of the legal exposure. Keep the record, drop the face.
import type { Env } from "./types";

/** Owner decision 2026-07-10 (revised from 584). Days after deletion. */
export const RETENTION_DAYS = 256;
const RETENTION_MS = RETENTION_DAYS * 86_400_000;

export interface RetentionDecision {
  track: "extended" | "protective";
  /** True ⇒ deletion.ts must NOT wipe the liveness/didit R2 prefixes. */
  keepVideo: boolean;
}

/**
 * Snapshot what we are allowed to keep, and record it, BEFORE the cascade destroys
 * the rows it reads from. Called at the top of handleDeletion(), after the legal-hold
 * check.
 *
 * Fails PROTECTIVE on any error: if we cannot read the user's retention track, we do
 * not get to assume the permissive one.
 */
export async function recordDeletionRetention(env: Env, uid: string): Promise<RetentionDecision> {
  const now = Date.now();
  try {
    // `users` stores email_hash, never a raw email — a deliberate privacy choice, and
    // exactly what we want to retain after deletion. A hash lets us confirm "yes, that
    // address held an account" for a lawful request, without us keeping the address.
    const u = await env.DB_META.prepare(
      "SELECT email_hash, retention_track, created_at FROM users WHERE uid=?1",
    ).bind(uid).first<{ email_hash: string | null; retention_track: string | null; created_at: number | null }>();

    // Liveness lives in identity_proofs, NOT clerk_account_link (legacy, being dropped).
    // provider = 'didit' | 'grandfathered'.
    const l = await env.DB_META.prepare(
      "SELECT verified_at, provider, evidence_ref FROM identity_proofs WHERE uid=?1 AND proof='liveness'",
    ).bind(uid).first<{ verified_at: number | null; provider: string | null; evidence_ref: string | null }>();

    // Anything other than an explicit 'extended' ⇒ protective. A null, an unexpected
    // string, a missing row: all mean "we do not have positive evidence", and that is
    // exactly the case the protective track exists for.
    const track: "extended" | "protective" = u?.retention_track === "extended" ? "extended" : "protective";
    const keepVideo = track === "extended";

    await env.DB_META.prepare(
      `INSERT OR REPLACE INTO deleted_account_retention
         (uid, email_hash, liveness_passed_at, liveness_source, liveness_ref,
          retention_track, video_retained, created_at, deleted_at, purge_after)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`,
    ).bind(
      uid,
      u?.email_hash ?? null,
      l?.verified_at ?? null,
      l?.provider ?? null,      // 'didit' | 'grandfathered' — never conflate
      l?.evidence_ref ?? null,
      track,
      keepVideo ? 1 : 0,
      u?.created_at ?? null,
      now,
      now + RETENTION_MS,
    ).run();

    return { track, keepVideo };
  } catch (e) {
    console.error("retention: snapshot failed — defaulting to PROTECTIVE (delete video)", uid, String(e));
    return { track: "protective", keepVideo: false };
  }
}

async function deleteR2Prefix(bucket: R2Bucket, prefix: string): Promise<number> {
  let cursor: string | undefined, n = 0;
  do {
    const list = await bucket.list({ prefix, cursor, limit: 1000 });
    const keys = list.objects.map((o) => o.key);
    if (keys.length) { await bucket.delete(keys); n += keys.length; }
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  return n;
}

/**
 * The drain. Runs on the 6-hourly cron. Hard-deletes retention rows past
 * `purge_after`, and wipes any liveness video that was held on the extended track.
 *
 * Bounded (200/run) so a backlog cannot blow the cron's CPU budget; it simply catches
 * up on the next tick. Idempotent: a row is deleted only after its video is gone, so a
 * mid-run failure retries cleanly rather than orphaning bytes in R2.
 *
 * NEVER touches an account under legal hold — those rows are never inserted here,
 * because handleDeletion() refuses to run at all while `legal_hold = 1`.
 */
export async function sweepRetention(env: Env): Promise<{ rows: number; videos: number }> {
  const now = Date.now();
  let rows = 0, videos = 0;

  const due = await env.DB_META.prepare(
    "SELECT uid, video_retained FROM deleted_account_retention WHERE purge_after <= ?1 LIMIT 200",
  ).bind(now).all<{ uid: string; video_retained: number }>();

  for (const r of (due.results ?? [])) {
    try {
      if (Number(r.video_retained) === 1 && env.VERIFICATION) {
        // Order matters: bytes first, row second. If we delete the row and then fail
        // on R2, the video is orphaned and retained FOREVER with no record of why —
        // the worst possible outcome for a biometric.
        videos += await deleteR2Prefix(env.VERIFICATION, `liveness/${r.uid}/`);
        videos += await deleteR2Prefix(env.VERIFICATION, `didit/${r.uid}/`);
      }
      await env.DB_META.prepare("DELETE FROM deleted_account_retention WHERE uid=?1").bind(r.uid).run();
      rows++;
      try {
        env.ANALYTICS?.writeDataPoint({
          blobs: ["liveness_video_deleted", "sweep_256d", String(r.video_retained)],
          doubles: [1], indexes: ["retention"],
        });
      } catch { /* metrics best-effort */ }
    } catch (e) {
      // Leave the row in place. It is past purge_after, so the next tick retries it.
      console.error("retention sweep: failed to purge", r.uid, String(e));
    }
  }

  if (rows) {
    try {
      env.ANALYTICS?.writeDataPoint({
        blobs: ["retention_sweep_ran"], doubles: [rows, videos], indexes: ["retention"],
      });
    } catch { /* metrics best-effort */ }
  }
  return { rows, videos };
}
