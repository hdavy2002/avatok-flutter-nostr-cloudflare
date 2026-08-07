// [SPEC-SEND-2 / WS-33] Speculative-upload sweep.
//
// [SPEC-SEND-1 / WS-30a] gave `user_media` an "uncommitted" state: the chat
// composer stages attachment BYTES to R2 the moment a file is picked, so the
// send itself is instant. If the user then changes their mind — closes the
// composer, kills the app, picks a different photo — nothing ever commits that
// row, and both the R2 object and the D1 row sit there forever. Nothing else in
// the system collects them: uncommitted rows are deliberately EXCLUDED from the
// storage quota SUM (worker/src/storage.ts dedupUsage), so the user is never
// billed for them and never sees them in AvaLibrary, which means no user action
// will ever clean them up either. This sweep is the only collector.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE THING THAT MAKES THIS DANGEROUS: R2 KEYS ARE SHARED ACROSS ROWS,
// AND ACROSS USERS.
//
// A `user_media` row is a REFERENCE to an R2 object, not an owner of it. Several
// paths in worker/src/routes/media.ts deliberately create a second row pointing
// at the SAME key:
//
//   • libraryRecord()             — inserts a row for the RECIPIENT of a DM
//                                   carrying the SENDER's key u/<senderUid>/dm/<hash>
//   • copyMediaRow()              — copies src.key verbatim into a new row
//   • libraryCopy() / libraryFolderCopy() (recursive)
//   • registerExistingObjectMedia() — a row pointing at a key its producer chose
//
// Content-addressing makes this the NORMAL case, not the exotic one: the key is
// u/<uid>/<lane>/<sha256>, so re-picking the same photo re-uses the same key.
//
// Nothing else in this codebase checks for other referencing rows before
// deleting bytes — and that has been harmless only because, until this file,
// nothing deleted bytes on a schedule. So this sweep does the check itself, and
// it is the whole reason the per-row path below looks more careful than
// retention.ts's: deleting one speculative row must never blank the photo
// sitting in someone else's chat.
//
// STRUCTURE is otherwise retention.ts:117-156, which is the correct sweep shape:
// bytes first then row (so a mid-run failure orphans nothing, it just retries),
// bounded batch, and the row is LEFT IN PLACE on any error so the next tick
// picks it up again.
//
// NO QUOTA RECOMPUTE is needed after a delete here, unlike libraryDelete():
// uncommitted bytes were never counted in the first place (see dedupUsage's
// `COALESCE(uncommitted,0)=0` filter), so removing them changes no total.
import type { Env } from "./types";

/**
 * How long a staged-but-never-sent upload is kept before collection.
 *
 * 24h, chosen to be far longer than any plausible compose session while still
 * bounding the leak. The bytes are invisible to the user (excluded from quota
 * and from AvaLibrary), so a long TTL costs storage silently; a SHORT TTL is
 * the actually dangerous direction — a user who stages a video, backgrounds the
 * app, and sends it the next morning must still find their bytes there. A day
 * covers "picked it last night, sent it at breakfast" and nothing legitimate
 * outlives that, because a committed send flips uncommitted=0 immediately
 * (promoteIfUncommitted / POST /api/media/commit).
 */
export const UNCOMMITTED_TTL_MS = 24 * 60 * 60 * 1000;

/** Bounded per run, like sweepRetention — a backlog catches up on the next tick. */
const SWEEP_BATCH = 200;

export interface MediaSweepResult {
  /** Rows found due this run. */
  scanned: number;
  /** Rows hard-deleted from user_media. */
  rows: number;
  /** R2 objects deleted (≤ rows — shared keys delete a row but no bytes). */
  objects: number;
  /** Rows whose bytes were SPARED because another row still references the key. */
  sharedSkipped: number;
  /** Rows left in place for the next tick after an error. */
  failed: number;
}

interface DueRow {
  id: string;
  uid: string;
  key: string;
  storage: string | null;
  visibility: string | null;
  encrypted: number | null;
  size_bytes: number | null;
  original_app: string | null;
  category: string | null;
  uncommitted_at: number | null;
}

/** PostHog via the analytics queue — same shape as listing_expiry.ts / auto_reply.ts. */
async function track(env: Env, uid: string, event: string, props: Record<string, unknown>): Promise<void> {
  try {
    await env.Q_ANALYTICS?.send({
      event, uid, ts: Date.now(),
      props: { ...props, app_name: "avastorage", service_name: "avatok-consumers", worker: true, account_id: uid },
    });
  } catch { /* best-effort — telemetry never affects the sweep */ }
}

/**
 * Which bucket the row's bytes actually live in.
 *
 * This MUST match worker/src/routes/media.ts's upload lanes, because an R2
 * delete against the wrong bucket is a SILENT no-op: the row disappears, the
 * bytes stay, and nothing ever looks at them again.
 *
 *   uploadPublic()  → env.BLOBS,   row storage='blossom' (public posts/avatars)
 *   uploadPrivate() encrypted DM   → env.BLOBS,   row storage='blossom'
 *                   (ciphertext is opaque, so the public bucket is safe)
 *   uploadPrivate() plaintext      → env.DIGITAL, row storage='digital'
 *                   (server-readable, so it must NOT be in the public bucket)
 *
 * The `storage` column is therefore the authoritative discriminator — NOT
 * visibility/encrypted, both of which are 'private'/varied on BOTH sides of the
 * BLOBS/DIGITAL split. Anything unrecognised is treated as unroutable rather
 * than guessed at (see the caller), because guessing wrong leaks bytes forever.
 */
function bucketFor(env: Env, storage: string | null): R2Bucket | undefined {
  const s = (storage || "").toLowerCase();
  if (s === "digital") return env.DIGITAL;
  if (s === "blossom") return env.BLOBS;
  return undefined;
}

/**
 * Count OTHER rows pointing at the same R2 key.
 *
 * Split live/soft-deleted on purpose. The brief only requires sparing bytes for
 * LIVE references (deleted_at IS NULL), but a soft-deleted row is not proof the
 * bytes are unwanted: libraryDelete() only stamps deleted_at and never touches
 * R2, and callrec.ts's lane explicitly REVIVES a soft-deleted row when the same
 * content is re-uploaded. Freeing bytes out from under such a row would leave a
 * revivable reference pointing at nothing. So this sweep spares bytes for
 * either kind and reports the breakdown, which is strictly more conservative
 * than the requirement.
 */
async function countOtherRefs(env: Env, key: string, selfId: string): Promise<{ live: number; soft: number }> {
  const r = await env.DB_MEDIA.prepare(
    `SELECT
       SUM(CASE WHEN deleted_at IS NULL     THEN 1 ELSE 0 END) AS live,
       SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS soft
     FROM user_media WHERE key = ?1 AND id != ?2`,
  ).bind(key, selfId).first<{ live: number | null; soft: number | null }>();
  return { live: Number(r?.live ?? 0), soft: Number(r?.soft ?? 0) };
}

/**
 * The sweep. Runs on the 6-hourly cron tick (consumers/src/index.ts).
 *
 * Idempotent and restartable: bytes are deleted before the row, so a crash in
 * between leaves a still-due row that retries cleanly next tick. R2 delete is
 * itself idempotent, so a retry of an already-deleted object is a no-op.
 *
 * Never throws — a per-row failure is logged, counted and skipped, and a
 * fatal/setup failure resolves to a zeroed result so the caller's other
 * 6-hourly jobs are unaffected.
 */
export async function sweepUncommittedMedia(env: Env): Promise<MediaSweepResult> {
  const out: MediaSweepResult = { scanned: 0, rows: 0, objects: 0, sharedSkipped: 0, failed: 0 };
  const cutoff = Date.now() - UNCOMMITTED_TTL_MS;

  let due: D1Result<DueRow>;
  try {
    // `uncommitted = 1` rather than `COALESCE(uncommitted,0) = 1`: identical in
    // meaning (NULL coalesces to 0, never 1) but it matches the PARTIAL index
    // predicate of idx_media_uncommitted, which SQLite will only use when the
    // WHERE clause implies it. The COALESCE form would silently full-scan
    // user_media every 6 hours.
    due = await env.DB_MEDIA.prepare(
      `SELECT id, uid, key, storage, visibility, encrypted, size_bytes, original_app, category, uncommitted_at
         FROM user_media
        WHERE uncommitted = 1 AND uncommitted_at IS NOT NULL AND uncommitted_at < ?1
        LIMIT ${SWEEP_BATCH}`,
    ).bind(cutoff).all<DueRow>();
  } catch (e) {
    // A Worker deploy and a D1 migration are two separate deliberate steps
    // (see worker/src/storage.ts's dedupUsage fallback for the same window).
    // Before migrations/media_uncommitted.sql lands in an environment, the
    // column does not exist — which also means nothing can be uncommitted, so
    // "no work" is the CORRECT answer, not an error worth alerting on.
    const msg = String(e);
    if (/no such column/i.test(msg)) return out;
    console.error("[media-sweep] query failed", msg);
    await track(env, "server", "media_sweep_failed", { stage: "query", error: msg.slice(0, 300) });
    return out;
  }

  const rows = due.results ?? [];
  out.scanned = rows.length;

  for (const r of rows) {
    try {
      const bucket = bucketFor(env, r.storage);
      if (!bucket) {
        // Unknown storage lane, or the binding is absent in this environment
        // (env.DIGITAL is optional). Deleting the row now would strand the
        // bytes with no record they exist. Leave it; the next tick retries,
        // and the telemetry says which lane is unroutable.
        out.failed++;
        console.error("[media-sweep] unroutable storage lane", r.id, r.storage);
        await track(env, r.uid, "media_sweep_failed", {
          stage: "bucket", media_id: r.id, storage: r.storage, key: r.key,
          reason: r.storage === "digital" ? "digital_binding_missing" : "unknown_storage",
        });
        continue;
      }

      // ── THE SAFETY CHECK ── never delete bytes another row still points at.
      const refs = await countOtherRefs(env, r.key, r.id);
      const shared = refs.live > 0 || refs.soft > 0;

      if (shared) {
        out.sharedSkipped++;
        await track(env, r.uid, "media_sweep_shared_key_skipped", {
          media_id: r.id, key: r.key, storage: r.storage, visibility: r.visibility,
          bytes: r.size_bytes ?? 0, category: r.category, source_app: r.original_app,
          other_live_refs: refs.live, other_deleted_refs: refs.soft,
          age_ms: r.uncommitted_at ? Date.now() - Number(r.uncommitted_at) : null,
        });
      } else {
        // Bytes FIRST, row second (retention.ts's ordering). The reverse loses
        // the only pointer to the object and leaks it permanently.
        await bucket.delete(r.key);
        out.objects++;
      }

      await env.DB_MEDIA.prepare("DELETE FROM user_media WHERE id = ?1 AND uncommitted = 1").bind(r.id).run();
      out.rows++;

      try {
        env.ANALYTICS?.writeDataPoint({
          blobs: ["media_sweep_row", shared ? "shared" : "deleted", String(r.storage ?? "")],
          doubles: [Number(r.size_bytes ?? 0)], indexes: ["media_sweep"],
        });
      } catch { /* metrics best-effort */ }
    } catch (e) {
      // Leave the row in place — it is still past its TTL, so the next tick
      // retries it. Never let one bad row abort the batch.
      out.failed++;
      console.error("[media-sweep] row failed", r.id, String(e));
      await track(env, r.uid, "media_sweep_failed", {
        stage: "delete", media_id: r.id, key: r.key, storage: r.storage,
        bytes: r.size_bytes ?? 0, error: String(e).slice(0, 300),
      });
    }
  }

  if (out.scanned) {
    await track(env, "server", "media_sweep_run", {
      scanned: out.scanned, rows_deleted: out.rows, objects_deleted: out.objects,
      shared_key_skipped: out.sharedSkipped, failed: out.failed,
      ttl_hours: UNCOMMITTED_TTL_MS / 3_600_000, batch_limit: SWEEP_BATCH,
      // A full batch means there is more waiting — the next tick continues.
      more_pending: out.scanned >= SWEEP_BATCH,
    });
    try {
      env.ANALYTICS?.writeDataPoint({
        blobs: ["media_sweep_run"],
        doubles: [out.scanned, out.rows, out.objects, out.sharedSkipped, out.failed],
        indexes: ["media_sweep"],
      });
    } catch { /* metrics best-effort */ }
  }
  return out;
}
