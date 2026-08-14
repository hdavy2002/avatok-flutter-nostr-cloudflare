// Two upload paths + AvaLibrary + ICE. Reads are served by blossom.avatok.ai
// (public R2 bucket) — never through this Worker. Worker handles WRITES only.
import type { Env } from "../types";
import { json, sha256Hex, CORS } from "../util";
import { mediaSession, moderationSession } from "../db/shard";
import { requireUser, isFail } from "../authz";
import { walletOp } from "./wallet";
import { checkUploadAllowed, afterRegisterFile } from "../storage";
import { track } from "../hooks";
import { brainIngest } from "../lib/brain_ingest";
import { shouldFail } from "../lib/fault_inject";
// [AVA-MEDIA-JOB-2 / B3] Private-object presign — same SigV4 query-URL scheme
// routes/olx.ts already uses for avatok-digital downloads (avatok-digital
// bucket, S3-compatible R2 API). Imported (not re-implemented) so there is
// exactly one signing implementation in the codebase.
import { presignGetUrl } from "../aws/sigv4";
// [B2 / B3 fix / AVA-MEDIA-AUTHZ-1] isConvMember — same conversation-membership
// check lib/ai_media_jobs.ts uses, imported here for libraryRecord()'s
// forged-key authorization fix below (one implementation, not a second copy).
import { type ArtifactSensitivity, isConvMember } from "../lib/ai_media_jobs";
// [P1 fix / AVA-MEDIA-AUTHZ-1] voiceNoteEncryptionEnabled must be enforced
// SERVER-SIDE in uploadPrivate() below, not just read client-side — see the
// fix note there.
import { readConfig } from "./config";
// [AVA-IDGATE-1] identity_gate import removed — /upload/public is no longer gated
// (avatars must upload during onboarding; the public ACTION is gated at its endpoint).

// ---------------------------------------------------------------------------
// [SPEC-SEND-1 / WS-30a] SPECULATIVE ("uncommitted") UPLOADS
//
// The client stages chat media BEFORE the user hits Send, so the send itself is
// instant. Those bytes must not eat the user's AvaStorage quota until they are
// actually sent — an attachment that was picked and then abandoned would
// otherwise count forever and can push an account read-only for a file nobody
// ever received.
//
// Wire contract (fixed — another agent's sweeper depends on it EXACTLY):
//   • upload with header `x-uncommitted: 1`  → row inserted uncommitted=1,
//     uncommitted_at=<now ms>. Header ABSENT → uncommitted=0, i.e. byte-for-byte
//     today's behaviour for every shipped client.
//   • POST /api/media/commit {media_id}      → uncommitted=0, uncommitted_at=NULL
//     + afterRegisterFile() so the quota recomputes. Idempotent.
//   • recomputeStorage() (worker/src/storage.ts) excludes uncommitted rows.
// ---------------------------------------------------------------------------

/** True when the caller asked for a speculative (not-yet-sent) upload. */
function wantsUncommitted(req: Request): boolean {
  const v = (req.headers.get("x-uncommitted") || "").trim().toLowerCase();
  return v === "1" || v === "true";
}

// Runtime self-migration for the two columns, cached per isolate. D1/SQLite has
// no "ADD COLUMN IF NOT EXISTS", so this is the same try/swallow guard
// do/inbox.ts uses for its own additive columns: the first run adds them, every
// later run errors harmlessly and is ignored. migrations/media_uncommitted.sql
// is still the canonical schema change — this only removes the ordering hazard
// of "worker deployed, D1 migration not applied yet" turning every speculative
// upload into a 500.
let uncommittedColumnsReady = false;
async function ensureUncommittedColumns(env: Env): Promise<void> {
  if (uncommittedColumnsReady) return;
  const mdb = mediaSession(env);
  try { await mdb.prepare("ALTER TABLE user_media ADD COLUMN uncommitted INTEGER DEFAULT 0").run(); } catch { /* already present */ }
  try { await mdb.prepare("ALTER TABLE user_media ADD COLUMN uncommitted_at INTEGER").run(); } catch { /* already present */ }
  try {
    await mdb.prepare(
      "CREATE INDEX IF NOT EXISTS idx_media_uncommitted ON user_media(uncommitted, uncommitted_at) WHERE uncommitted = 1",
    ).run();
  } catch { /* already present */ }
  uncommittedColumnsReady = true;
}

// Dedup collision handler. The upload routes short-circuit when a row already
// exists for this content key — but if that row is SPECULATIVE and this upload
// is a real (committed) one, the row must end up COMMITTED, or the user's bytes
// stay uncounted forever and a stale-draft sweeper could delete media they
// actually sent. Promotion is one-way: a committed row is NEVER demoted by a
// later speculative upload of the same content.
//
// No checkUploadAllowed() gate on the promotion path, deliberately, and for the
// same reason registerExistingObjectMedia() has none: the bytes are already in
// R2 by the time we get here, so refusing the flip frees nothing — it would only
// leave the account undercounted while still paying for the storage. The bytes
// ARE counted from here on, so an over-quota account still goes read-only on its
// next voluntary upload.
async function promoteIfUncommitted(
  env: Env, mdb: ReturnType<typeof mediaSession>, uid: string, row: { id: string; uncommitted?: number | null },
): Promise<boolean> {
  if (!Number(row?.uncommitted ?? 0)) return false;
  await ensureUncommittedColumns(env);
  return markCommitted(mdb, uid, row.id);
}

// [SPEC-SEND-3] The ONE write that flips a row uncommitted→committed, and the
// ONE place that decides whether THIS caller performed the transition.
//
// The `AND COALESCE(uncommitted,0)=1` guard plus the rows-changed check is what
// makes the deferred side effects below fire EXACTLY ONCE. The read-then-write
// pattern that preceded it ("row said 1, so update and return true") is racy:
// two concurrent real uploads of the same bytes, or a client retrying
// /api/media/commit while the first call is still in flight, both read
// uncommitted=1 and both would have claimed the transition — enqueueing the
// moderation scan twice and, worse, ingesting the file into AvaBrain twice.
// SQLite reports 0 changed rows for the loser of that race, so it stays silent.
async function markCommitted(
  mdb: ReturnType<typeof mediaSession>, uid: string, id: string,
): Promise<boolean> {
  const res = await mdb.prepare(
    "UPDATE user_media SET uncommitted=0, uncommitted_at=NULL WHERE id=?1 AND uid=?2 AND COALESCE(uncommitted,0)=1",
  ).bind(id, uid).run();
  return Number((res as { meta?: { changes?: number } })?.meta?.changes ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// [SPEC-SEND-3 / WS-30a] DEFERRED UPLOAD SIDE EFFECTS
//
// A speculative upload is a file the user STAGED and may never send. Until
// [SPEC-SEND-3] the only thing that treated it as provisional was the storage
// quota: everything else fired at upload time, so a file the user picked and
// then discarded was still enqueued for moderation and — the serious one —
// permanently ingested into AvaBrain. The row is swept after 24h; the brain
// vectors are not, so Ava kept remembering a file whose owner had explicitly
// changed their mind. Discarding is meant to mean "forget this".
//
// So these three effects now run on the uncommitted→committed TRANSITION, from
// whichever path performs it (POST /api/media/commit, or the dedup-collision
// promotion when the same bytes are re-uploaded for real). A committed upload —
// i.e. every shipped client, which sends no x-uncommitted header — still fires
// them inline at insert time, byte-for-byte the old behaviour.
//
// Private/DM uploads never had any of this (no scan of ciphertext, no server
// brain ingest), so uploadPrivate has nothing to defer — hence the visibility
// and storage guards here rather than at the call sites.
// ---------------------------------------------------------------------------
interface CommittedUploadInfo {
  media_id: string;
  key: string;
  mime: string;
  size: number;
  name: string;
  category: string;
  visibility: string;
  /** 'digital' = the private bucket. Never public-brain / moderation eligible. */
  storage?: string | null;
}

async function emitCommittedUploadEffects(
  env: Env, uid: string, app: string, m: CommittedUploadInfo,
): Promise<void> {
  if (m.visibility !== "public" || m.storage === "digital") return;
  // The content hash IS the last path segment of the content-addressed key
  // (userKey() below: `u/<uid>/<kind>/<hash>`), so a commit arriving hours after
  // the upload can still name the exact content the scanner has to fetch —
  // without the queue message needing the bytes or a second D1 column.
  const hash = /\/([0-9a-f]{64})$/i.exec(m.key)?.[1] || "";
  const jobs: Promise<unknown>[] = [];
  // async moderation — content hash for scan/blocklist, r2_key for fetch/delete.
  if (hash) jobs.push(env.Q_MODERATION.send({ type: "image", hash, uid, media_id: m.media_id, r2_key: m.key }));
  // AvaBrain learns from public uploads (metadata only — no DM media here).
  jobs.push(brainIngest(env, {
    uid, domain: "files", kind: "upload_completed", sourceId: m.media_id,
    meta: { hash, mime: m.mime, size: m.size, app },
  }));
  // AvaBrain CONTENT ingestion of the public file itself (caption/OCR/text →
  // embed), gated on the user's consent toggles.
  jobs.push(maybeEmitLibraryBrain(env, uid, app, {
    media_id: m.media_id, key: m.key, mime: m.mime, size: m.size,
    name: m.name, category: m.category, visibility: "public",
  }));
  // allSettled, not all: one failing effect must not cancel the others.
  await Promise.allSettled(jobs);
}

// [SPEC-SEND-3] moderation_status for a speculative PUBLIC upload.
//
// It cannot be 'pending'. 'pending' means "a scan is coming", and while the row
// is uncommitted no scan has been enqueued — but consumers/src/index.ts's
// 6-hourly cron flips every 'pending' row older than 24h to 'rejected'. A
// staged file would therefore be auto-rejected before the user ever pressed
// Send, and the rejection would be indistinguishable from a real moderation
// failure. 'staged' is a fourth value alongside pending/live/rejected/skipped;
// nothing else in the codebase branches on an unknown status (the brain's
// library reader requires 'live', the auto-reject matches 'pending' exactly),
// so it is inert until the commit flips it to 'pending' next to the enqueue.
const MOD_STAGED = "staged";

/** 'staged' → 'pending', at the same moment the scan is actually enqueued. */
async function markModerationPending(
  mdb: ReturnType<typeof mediaSession>, uid: string, id: string,
): Promise<void> {
  await mdb.prepare(
    `UPDATE user_media SET moderation_status='pending' WHERE id=?1 AND uid=?2 AND moderation_status='${MOD_STAGED}'`,
  ).bind(id, uid).run();
}

// [SPEC-SEND-3] Library views must not show a file the user staged and never
// sent. Applied as a WHERE fragment so the deploy-window fallback (Worker live,
// migrations/media_uncommitted.sql not yet applied to this environment's D1)
// can retry the SAME query without it — and that fallback is exact, not an
// approximation: no column ⇒ no row can be uncommitted.
const COMMITTED_ONLY = "COALESCE(uncommitted,0)=0";
async function withCommittedFilter<T>(run: (filter: string) => Promise<T>): Promise<T> {
  try { return await run(COMMITTED_ONLY); } catch { return await run("1=1"); }
}

// Both upload routes SELECT their dedup row with this projection. COALESCE reads
// a NULL (a row written before the column existed) as 0 = committed. The column
// itself is guaranteed present by the ensureUncommittedColumns() call each route
// makes before its first query.
const UNCOMMITTED_SEL = "COALESCE(uncommitted,0) AS uncommitted";

// POST /upload/public — plaintext media (posts). sha256 → blocklist check →
// R2 PUT (status 'pending') → enqueue Workers-AI scan (Phase 4 consumer flips
// to 'live' or deletes). AI is async per Rulebook; blocklist is a cheap sync gate.
export async function uploadPublic(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  // [AVA-IDGATE-1] The liveness gate was REMOVED from this route (2026-07-10).
  //
  // WHY: /upload/public is the byte-staging endpoint for BOTH profile avatars AND
  // post/listing media. Gating it here broke SIGNUP — a profile photo is a required
  // onboarding field, and both the "take a selfie" and "upload" buttons post here
  // (Directory.uploadAvatar). A brand-new user has no liveness pass, so every avatar
  // upload 403'd and no one could finish onboarding.
  //
  // It was also redundant: uploading bytes is harmless on its own — they land in R2
  // as 'pending' moderation, attached to nothing. The PUBLIC ACTION that exposes them
  // (create post / listing / go live, all via /api/listings + /api/live) is gated at
  // its own endpoint, so the deterrent is intact. CSAM + nudity scanning still run on
  // every upload regardless. Gate the ACTION, not the byte transfer.
  const bytes = await req.arrayBuffer();
  if (!bytes.byteLength) return json({ error: "empty body" }, 400);
  const hash = await sha256Hex(bytes);                  // content id (moderation/blocklist/dedup)
  const r2Key = userKey(ctx.uid, "public", hash);    // per-user storage path → clear ownership
  const url = `${env.BLOSSOM_BASE_URL}/${r2Key}`;
  const ct = req.headers.get("x-content-type") || req.headers.get("content-type") || "application/octet-stream";
  const fileName = req.headers.get("x-file-name") || defaultName(ct, hash);
  const app = (req.headers.get("x-app") || "avatweet").toLowerCase();
  // VIDPOL-2: hard 64 MB cap on video uploads (mirrors the client's 720p H.264
  // transcode gate). Rejected before R2/quota work with the exact client message.
  const vidCap = videoCapReject(ct, bytes.byteLength);
  if (vidCap) return vidCap;
  // Optional: drop the upload straight into a user folder (AvaLibrary "+ Upload").
  const folderId = req.headers.get("x-folder") || null;
  // [SPEC-SEND-1 / WS-30a] Speculative upload? Header absent ⇒ committed, i.e.
  // exactly the pre-existing behaviour for every shipped client.
  const uncommitted = wantsUncommitted(req);
  await ensureUncommittedColumns(env);

  // Cheap synchronous blocklist gate (known-bad sha256 — content-level, cross-user).
  const blocked = await moderationSession(env)
    .prepare("SELECT 1 FROM blocked_media_hashes WHERE hash_value=?1 LIMIT 1").bind(hash).first();
  if (blocked) return json({ error: "rejected", reason: "blocked content" }, 403);

  const mdb = mediaSession(env);
  const existing = await mdb.prepare(`SELECT id, moderation_status, ${UNCOMMITTED_SEL} FROM user_media WHERE key=?1`).bind(r2Key).first<any>();
  let id: string | undefined = existing?.id;
  if (!existing) {
    // Phase 4 quota gate: would-exceed 5 GB + empty wallet ⇒ 413, read_only.
    const gate = await checkUploadAllowed(env, ctx.uid, bytes.byteLength, false);
    if (!gate.ok) return gate.resp;
    await env.BLOBS.put(r2Key, bytes, { httpMetadata: { contentType: ct } });
    id = crypto.randomUUID();
    await mdb.prepare(
      `INSERT INTO user_media (id, uid, media_type, storage, visibility, encrypted, key, display_url, mime_type, size_bytes, original_app, created_at, moderation_status, category, file_name, source_kind, folder_id, uncommitted, uncommitted_at)
       VALUES (?1,?2,?3,'blossom','public',0,?4,?5,?6,?7,?8,?9,?15,?10,?11,'sent',?12,?13,?14)`,
    ).bind(id, ctx.uid, mediaType(ct), r2Key, url, ct, bytes.byteLength, app, Date.now(), categoryOf(ct), fileName, folderId,
      uncommitted ? 1 : 0, uncommitted ? Date.now() : null,
      // [SPEC-SEND-3] 'staged', not 'pending' — no scan is enqueued below for a
      // speculative upload, and a 'pending' row is auto-rejected after 24h.
      uncommitted ? MOD_STAGED : "pending").run();
    if (uncommitted) {
      exec.waitUntil(track(env, ctx.uid, "media_upload_uncommitted", app, {
        media_id: id, key: r2Key, bytes: bytes.byteLength, kind: categoryOf(ct), mime: ct, visibility: "public",
      }));
    } else {
      // [SPEC-SEND-3] Moderation + both AvaBrain ingests. Deferred to commit time
      // for a speculative upload (see emitCommittedUploadEffects) so a staged-then-
      // discarded file is never scanned and never remembered by Ava.
      exec.waitUntil(emitCommittedUploadEffects(env, ctx.uid, app, {
        media_id: id, key: r2Key, mime: ct, size: bytes.byteLength, name: fileName,
        category: categoryOf(ct), visibility: "public", storage: "blossom",
      }));
    }
    // Phase 4: refresh the storage summary + live-push it over the InboxDO socket.
    exec.waitUntil(afterRegisterFile(env, ctx.uid, { kind: categoryOf(ct), bytes: bytes.byteLength, source_app: app, dedup: false }));
  } else {
    if (folderId) {
      // Re-upload of identical content while sitting in a folder → place it there.
      await mdb.prepare("UPDATE user_media SET folder_id=?3 WHERE id=?1 AND uid=?2").bind(existing.id, ctx.uid, folderId).run();
    }
    // [SPEC-SEND-1 / WS-30a] The dedup row may be a SPECULATIVE upload of the
    // same bytes. A real (committed) upload of that content must win — see
    // promoteIfUncommitted(). Never the other way round.
    if (!uncommitted && await promoteIfUncommitted(env, mdb, ctx.uid, existing)) {
      exec.waitUntil(afterRegisterFile(env, ctx.uid, { kind: categoryOf(ct), bytes: bytes.byteLength, source_app: app, dedup: false }));
      exec.waitUntil(track(env, ctx.uid, "media_commit", app, {
        media_id: existing.id, bytes: bytes.byteLength, kind: categoryOf(ct), via: "dedup_upload", visibility: "public",
      }));
      // [SPEC-SEND-3] This is a commit, so it owes the same deferred side effects
      // /api/media/commit does. promoteIfUncommitted() reports the TRANSITION only
      // (rows-changed guarded), so a second real upload of the same bytes lands
      // here with `false` and nothing fires twice. Byte-identical content ⇒ the
      // size/mime of this request describe the stored row exactly.
      await markModerationPending(mdb, ctx.uid, existing.id);
      exec.waitUntil(emitCommittedUploadEffects(env, ctx.uid, app, {
        media_id: existing.id, key: r2Key, mime: ct, size: bytes.byteLength, name: fileName,
        category: categoryOf(ct), visibility: "public", storage: "blossom",
      }));
    }
  }
  return json({ hash, key: r2Key, url, status: "pending", id });
}

// POST /upload/private — DM attachments. Two modes, chosen by the caller:
//
//  1. DEFAULT (no x-encrypted header, or "1"/"true") — client-side AES-GCM
//     CIPHERTEXT, byte-for-byte the original behavior. No scan (unscannable
//     by design). Stored in the PUBLIC BLOBS bucket — safe to serve there
//     because it is opaque without the AES key, which travels inside the
//     encrypted DM, never through this endpoint.
//
//  2. x-encrypted: 0 — [MVP voice-note decision 2026-07-25 / B3 fix] PLAINTEXT
//     that the server can read (gated client-side by config.ts's
//     voiceNoteEncryptionEnabled=false), so it MUST NOT land in the public
//     bucket: "unguessable path" is not access control. Stored instead in the
//     PRIVATE `DIGITAL` bucket (worker/wrangler.toml — same bucket
//     routes/olx.ts uses for paid digital-goods downloads) and never served
//     by the public blossom.avatok.ai domain — only via a freshly presigned,
//     short-lived URL (presignDigitalReadUrl above), which this route mints
//     once at upload time and getLibrary()/libraryRecord() re-mint on every
//     later read (a stored presigned URL would just go stale).
export async function uploadPrivate(req: Request, env: Env, exec?: ExecutionContext): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  // [TEST-FAILURE-INJECT-1] no-op unless FAULT_INJECT=media_upload_private is set.
  if (shouldFail(env, "media_upload_private")) throw new Error("fault_inject:media_upload_private");
  const bytes = await req.arrayBuffer();
  if (!bytes.byteLength) return json({ error: "empty body" }, 400);
  const hash = await sha256Hex(bytes);

  const encryptedHeader = (req.headers.get("x-encrypted") || "").trim().toLowerCase();
  const isPlaintext = encryptedHeader === "0" || encryptedHeader === "false";

  // [P1 fix / AVA-MEDIA-AUTHZ-1] voiceNoteEncryptionEnabled was a CLIENT-ONLY
  // brake: this route honoured x-encrypted:0 unconditionally, so flipping the
  // flag back to true would not stop plaintext uploads from a client that
  // hasn't refetched config, or a modified client that never checks it at
  // all — the exact "declared, flippable flag that isn't a brake" failure
  // shape CLAUDE.md documents for inAppUpdateEnabled. Enforced server-side
  // now: when the flag says encryption IS required, a plaintext upload is
  // rejected outright rather than silently accepted.
  if (isPlaintext) {
    const cfg = await readConfig(env);
    if (cfg.voiceNoteEncryptionEnabled) {
      return json({ error: "plaintext_disabled" }, 400);
    }
  }

  const r2Key = userKey(ctx.uid, isPlaintext ? "private" : "dm", hash); // per-user path (bytes owned by sender)
  const ct = "application/octet-stream"; // ciphertext OR opaque-on-the-wire plaintext blob — real mime rides in x-real-mime
  // The real content type/name travel in headers. Used only to categorise the
  // Library entry — never to scan (ciphertext is unscannable by design;
  // plaintext-but-private scanning is a follow-on, not this issue's scope).
  const realMime = req.headers.get("x-real-mime") || "application/octet-stream";
  const fileName = req.headers.get("x-file-name") || defaultName(realMime, hash);
  const app = (req.headers.get("x-app") || "avachat").toLowerCase();
  // VIDPOL-2: same 64 MB ceiling either way (ciphertext/plaintext are ~same size as source).
  const vidCap = videoCapReject(realMime, bytes.byteLength);
  if (vidCap) return vidCap;

  // [SPEC-SEND-1 / WS-30a] Speculative upload? Header absent ⇒ committed, i.e.
  // exactly the pre-existing behaviour for every shipped client. This is the
  // route the chat composer stages attachments through.
  const uncommitted = wantsUncommitted(req);
  const mdb = mediaSession(env);
  await ensureUncommittedColumns(env);
  const existing = await mdb.prepare(`SELECT id, ${UNCOMMITTED_SEL} FROM user_media WHERE key=?1`).bind(r2Key).first<any>();
  if (!existing) {
    // Phase 4 quota gate (same pool as public — these bytes count too).
    const gate = await checkUploadAllowed(env, ctx.uid, bytes.byteLength, false);
    if (!gate.ok) return gate.resp;
  }
  const bucket = isPlaintext ? env.DIGITAL : env.BLOBS;
  const head = await bucket.head(r2Key);
  if (!head) await bucket.put(r2Key, bytes, { httpMetadata: { contentType: ct } });

  const url = isPlaintext
    ? ((await presignDigitalReadUrl(env, r2Key)) || "")
    : `${env.BLOSSOM_BASE_URL}/${r2Key}`;

  let id: string = existing?.id;
  if (!existing) {
    id = crypto.randomUUID();
    await mdb.prepare(
      `INSERT INTO user_media (id, uid, media_type, storage, visibility, encrypted, key, display_url, mime_type, size_bytes, original_app, created_at, moderation_status, category, file_name, source_kind, uncommitted, uncommitted_at)
       VALUES (?1,?2,?3,?4,'private',?5,?6,?7,?8,?9,?10,?11,'skipped',?12,?13,'sent',?14,?15)`,
    ).bind(
      id, ctx.uid, mediaType(realMime), isPlaintext ? "digital" : "blossom",
      isPlaintext ? 0 : 1, r2Key, isPlaintext ? "" : url, ct, bytes.byteLength, app, Date.now(),
      categoryOf(realMime), fileName, uncommitted ? 1 : 0, uncommitted ? Date.now() : null,
    ).run();
    const reg = afterRegisterFile(env, ctx.uid, { kind: categoryOf(realMime), bytes: bytes.byteLength, source_app: app, dedup: false });
    if (exec) exec.waitUntil(reg); else await reg.catch(() => { /* best-effort */ });
    if (uncommitted) {
      const t = track(env, ctx.uid, "media_upload_uncommitted", app, {
        media_id: id, key: r2Key, bytes: bytes.byteLength, kind: categoryOf(realMime), mime: realMime, visibility: "private",
      });
      if (exec) exec.waitUntil(t); else await t.catch(() => { /* best-effort */ });
    }
  } else if (!uncommitted && await promoteIfUncommitted(env, mdb, ctx.uid, existing)) {
    // [SPEC-SEND-1 / WS-30a] Same content already staged speculatively, now
    // uploaded for real → the row must end up committed (one-way promotion).
    const reg = afterRegisterFile(env, ctx.uid, { kind: categoryOf(realMime), bytes: bytes.byteLength, source_app: app, dedup: false });
    const t = track(env, ctx.uid, "media_commit", app, {
      media_id: id, bytes: bytes.byteLength, kind: categoryOf(realMime), via: "dedup_upload", visibility: "private",
    });
    if (exec) { exec.waitUntil(reg); exec.waitUntil(t); }
    else { await reg.catch(() => { /* best-effort */ }); await t.catch(() => { /* best-effort */ }); }
  }
  // `id` is additive in this response ([SPEC-SEND-1]): a speculative upload has
  // to be able to name the row it later commits (POST /api/media/commit
  // {media_id}), and this route previously returned only the key/hash.
  return json({ hash, key: r2Key, url, status: "live", encrypted: isPlaintext ? 0 : 1, id });
}

// POST /api/media/commit {media_id} — [SPEC-SEND-1 / WS-30a] "the user actually
// sent it": flip a speculative row to committed so its bytes start counting
// against the AvaStorage pool, and take it out of reach of the stale-draft
// sweeper.
//
// Auth + ownership are both mandatory: the UPDATE is scoped to (id, uid), so one
// user can never commit (and thereby bill / rescue) another user's row, and an
// unknown or foreign id is a flat 404 rather than a silent no-op.
//
// IDEMPOTENT by design — the client retries a send, or sends the same staged
// attachment to a second thread. An already-committed row returns ok with
// committed:true and does NOT re-run afterRegisterFile (the recompute is a full
// dedup SUM, so a second run would be a pure waste, not a double-count).
export async function mediaCommit(req: Request, env: Env, exec?: ExecutionContext): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  const mediaId = (b.media_id ?? b.id ?? "").toString().trim();
  if (!mediaId) return json({ error: "media_id required" }, 400);

  await ensureUncommittedColumns(env);
  const mdb = mediaSession(env);
  const row = await mdb.prepare(
    `SELECT id, size_bytes, category, original_app, key, mime_type, file_name, visibility, storage, ${UNCOMMITTED_SEL} FROM user_media WHERE id=?1 AND uid=?2 LIMIT 1`,
  ).bind(mediaId, ctx.uid).first<any>();
  if (!row) return json({ error: "not_found" }, 404);

  const app = (row.original_app || "avatok").toString();
  const bytes = Number(row.size_bytes || 0);
  const kind = (row.category || "other").toString();
  if (!Number(row.uncommitted ?? 0)) return json({ ok: true, id: mediaId, committed: true, already: true });

  // [SPEC-SEND-3] Guarded flip: `already` is now decided by who actually changed
  // the row, not by a read that can be stale by the time the write lands. Two
  // concurrent commits of the same media_id (the client retries a send, or sends
  // the same staged attachment to two threads at once) both pass the check
  // above; only one gets changes>0, so the moderation scan and the AvaBrain
  // ingest below happen exactly once.
  if (!(await markCommitted(mdb, ctx.uid, mediaId))) {
    return json({ ok: true, id: mediaId, committed: true, already: true });
  }
  // [SPEC-SEND-3] The side effects deferred at upload time: the moderation scan
  // and both AvaBrain ingests. No-ops for a private/DM row (uploadPrivate never
  // fired them either) — emitCommittedUploadEffects guards on visibility.
  await markModerationPending(mdb, ctx.uid, mediaId);
  const fx = emitCommittedUploadEffects(env, ctx.uid, app, {
    media_id: mediaId,
    key: (row.key || "").toString(),
    mime: (row.mime_type || "application/octet-stream").toString(),
    size: bytes,
    name: (row.file_name || "").toString(),
    category: kind,
    visibility: (row.visibility || "private").toString(),
    storage: row.storage ?? null,
  });
  if (exec) exec.waitUntil(fx); else await fx.catch(() => { /* best-effort */ });
  // Quota recompute + live storage push — the bytes count from this moment.
  const reg = afterRegisterFile(env, ctx.uid, { kind, bytes, source_app: app, dedup: false });
  const t = track(env, ctx.uid, "media_commit", app, { media_id: mediaId, bytes, kind, via: "commit_route" });
  if (exec) { exec.waitUntil(reg); exec.waitUntil(t); }
  else { await reg.catch(() => { /* best-effort */ }); await t.catch(() => { /* best-effort */ }); }
  return json({ ok: true, id: mediaId, committed: true, already: false });
}

// ---------------------------------------------------------------------------
// [AVA-MEDIA-JOB-2 / B3 fix] registerArtifactMedia — the ONE place a derived
// AI media job artifact (a generated image, a doc summary/translation, a
// transcript, a translated transcript) uploads its output bytes and
// registers a `user_media` row, so the result shows up in AvaLibrary/
// AvaStorage and can be opened/downloaded/shared with the SAME machinery as
// any manually-uploaded file. Routes through the SAME content-addressed
// media pool as uploadPublic()/uploadPrivate() above — no second storage
// path, per this issue's instructions.
//
// THE FIX: an earlier attempt at this function (parked on
// wave3-media-ux-parked, blocked in review) ALWAYS wrote to
// `u/<uid>/public/<hash>` with visibility='public' — the summary of a
// private contract and the transcript of a private voice note became
// publicly fetchable URLs with no auth. `sensitivity` is now a REQUIRED
// input (no default): 'private' routes storage through the SAME
// access-gated DIGITAL bucket + presigned-URL scheme uploadPrivate() uses
// for unencrypted voice notes above — never the public BLOBS/blossom bucket.
// Callers (the per-kind job handlers, [AVA-IMAGE-UX-1]/[AVA-DOC-ARTIFACT-1]/
// [AVA-AUDIO-ARTIFACT-1]) decide 'public' vs 'private' by calling
// ai_media_jobs.ts's resolveArtifactSensitivity(sourceMediaId) — an artifact
// inherits the sensitivity of its source; no known-public source defaults to
// private.
//
// The PARENT/DERIVED link (source_media_id) is deliberately NOT stored on
// this row — it lives on `ai_media_artifacts`
// (worker/migrations/2026-07-25-ai-media-jobs.sql), written by
// ai_media_jobs.ts's completeAiMediaJob() right after this call returns a
// media_id. This function only ever creates the STORAGE/LIBRARY side; it
// never touches ai_media_jobs/ai_media_artifacts.
// ---------------------------------------------------------------------------
export interface RegisterArtifactInput {
  uid: string;
  bytes: Uint8Array;
  mimeType: string;
  /** Exact final display file name. If omitted, derived from filePrefix + the
   *  first 8 hex chars of the content hash + fileExt. */
  fileName?: string;
  filePrefix?: string; // e.g. "ava-image", "summary", "transcript"
  fileExt?: string;    // e.g. "png", "md", "txt", "pdf"
  /** AvaLibrary category — defaults to categoryOf(mimeType) when omitted. */
  category?: string;
  /** original_app column — defaults to "avatok". */
  app?: string;
  /** [B3 fix] REQUIRED — no default. 'private' = the source this was derived
   *  from is private/received (or unknown); 'public' = the source was
   *  explicitly visibility='public'. See ai_media_jobs.ts's
   *  resolveArtifactSensitivity(). */
  sensitivity: ArtifactSensitivity;
}
export interface RegisterArtifactResult {
  id: string;
  /** Public artifacts: a stable, permanent CDN URL. Private artifacts: null —
   *  callers must presign fresh on every read (presignDigitalReadUrl above);
   *  a URL minted once at register time would go stale. */
  url: string | null;
  key: string;
  dedup: boolean;
  visibility: "public" | "private";
}

export async function registerArtifactMedia(env: Env, input: RegisterArtifactInput): Promise<RegisterArtifactResult> {
  const hash = await sha256Hex(input.bytes);
  const mdb = mediaSession(env);
  const fileName = input.fileName || `${input.filePrefix || "file"}-${hash.slice(0, 8)}.${input.fileExt || "bin"}`;
  const category = input.category || categoryOf(input.mimeType);
  const app = input.app || "avatok";

  if (input.sensitivity === "private") {
    const r2Key = `u/${input.uid}/private/${hash}`;
    const existing = await mdb.prepare("SELECT id FROM user_media WHERE key=?1 AND uid=?2").bind(r2Key, input.uid).first<any>();
    if (existing) return { id: existing.id, url: null, key: r2Key, dedup: true, visibility: "private" };
    // [§41] Same universal-storage quota every manual upload goes through —
    // an AI-generated artifact is a real file in the SAME pool.
    const gate = await checkUploadAllowed(env, input.uid, input.bytes.byteLength, false);
    if (!gate.ok) throw new Error("insufficient_balance: storage quota exceeded (AvaStorage is read-only over quota with an empty wallet)");
    await env.DIGITAL.put(r2Key, input.bytes, { httpMetadata: { contentType: input.mimeType } });
    const id = crypto.randomUUID();
    await mdb.prepare(
      `INSERT INTO user_media (id, uid, media_type, storage, visibility, encrypted, key, display_url, mime_type, size_bytes, original_app, created_at, moderation_status, category, file_name, source_kind)
       VALUES (?1,?2,?3,'digital','private',0,?4,'',?5,?6,?7,?8,'skipped',?9,?10,'sent')`,
    ).bind(id, input.uid, artifactMediaKind(input.mimeType), r2Key, input.mimeType, input.bytes.byteLength, app, Date.now(), category, fileName).run();
    await afterRegisterFile(env, input.uid, { kind: category, bytes: input.bytes.byteLength, source_app: app, dedup: false }).catch(() => {});
    return { id, url: null, key: r2Key, dedup: false, visibility: "private" };
  }

  // sensitivity === "public" — original always-public behavior, now opt-in only.
  const r2Key = `u/${input.uid}/public/${hash}`;
  const url = `${env.BLOSSOM_BASE_URL}/${r2Key}`;
  const existing = await mdb.prepare("SELECT id FROM user_media WHERE key=?1 AND uid=?2").bind(r2Key, input.uid).first<any>();
  if (existing) return { id: existing.id, url, key: r2Key, dedup: true, visibility: "public" };
  const gate = await checkUploadAllowed(env, input.uid, input.bytes.byteLength, false);
  if (!gate.ok) throw new Error("insufficient_balance: storage quota exceeded (AvaStorage is read-only over quota with an empty wallet)");
  await env.BLOBS.put(r2Key, input.bytes, { httpMetadata: { contentType: input.mimeType } });
  const id = crypto.randomUUID();
  await mdb.prepare(
    `INSERT INTO user_media (id, uid, media_type, storage, visibility, encrypted, key, display_url, mime_type, size_bytes, original_app, created_at, moderation_status, category, file_name, source_kind)
     VALUES (?1,?2,?3,'blossom','public',0,?4,?5,?6,?7,?8,?9,'live',?10,?11,'sent')`,
  ).bind(id, input.uid, artifactMediaKind(input.mimeType), r2Key, url, input.mimeType, input.bytes.byteLength, app, Date.now(), category, fileName).run();
  await afterRegisterFile(env, input.uid, { kind: category, bytes: input.bytes.byteLength, source_app: app, dedup: false }).catch(() => {});
  return { id, url, key: r2Key, dedup: false, visibility: "public" };
}

// ---------------------------------------------------------------------------
// [RECEPT-LIB-1] registerExistingObjectMedia — the `user_media` row for an
// object that is ALREADY in R2, under a key its producer chose.
//
// WHY registerArtifactMedia() CANNOT BE USED FOR THIS. That function OWNS the
// key: it hashes the bytes and writes to `u/<uid>/{public,private}/<hash>`.
// The Ava-receptionist voicemail is stored by the reception DOs at
// `receptionist/<uid>/<phone>/<sid>.wav` (do/reception_room_cf.ts,
// do/reception_room.ts, do/vobiz_agent_room.ts), the bespoke owner-authed
// playback endpoint (routes/voicemail_routes.ts, routes/receptionist.ts) reads
// that exact key, and AvaLibrary's client-side "Ava Receptionist" folder
// classifies on the `receptionist/` KEY PREFIX
// (app/lib/features/library/voicemail_tile.dart:85). Re-registering through
// registerArtifactMedia would write a SECOND copy of the same audio under a
// different key — double storage, and a row the client would file under Music.
// So: keep the key, register a row that POINTS at it.
//
// This is the same shape as callrec.ts's local registerPrivateObject(), with
// two deliberate differences:
//   • `bucket` is explicit. A receptionist wav lives in BLOBS (the public
//     blossom bucket) — `blossom` rows carry a stored display_url; `digital`
//     rows carry '' and getLibrary() re-mints a presign on every read.
//   • An existing row is returned AS IS and is never revived. callrec's chunked
//     lane must un-delete (a re-upload of the same content hash is a real new
//     file); here the key embeds a one-shot session id, so the only way to hit
//     an existing row is a DO retry — and resurrecting a row the OWNER deleted
//     from their library would be a bug, not idempotency.
// Idempotency is therefore exactly "(uid, key) exists → no second row".
//
// NO checkUploadAllowed() GATE, on purpose. The bytes are already in R2 before
// this is called, so refusing the row frees nothing — it would only hide a
// caller's message from its owner while still billing the storage. The bytes
// are still COUNTED (afterRegisterFile → recomputeStorage), so an over-quota
// account still goes read-only for its next voluntary upload; §6's "never
// delete" rule is unchanged.
// ---------------------------------------------------------------------------
export interface RegisterExistingObjectInput {
  uid: string;
  /** The R2 key EXACTLY as stored. Never rewritten. */
  key: string;
  /** Which bucket `key` lives in. Decides storage/display_url handling. */
  bucket: "blossom" | "digital";
  mimeType: string;
  sizeBytes: number;
  fileName: string;
  /** AvaLibrary category — defaults to categoryOf(mimeType). */
  category?: string;
  /** original_app column — defaults to "avatok". */
  app?: string;
  /** 'received' = the user did not create this (an incoming voicemail).
   *  Drives the client's incoming/outgoing tile flag. Defaults to 'sent'. */
  sourceKind?: "sent" | "received";
  /** Defaults to 'private'. NOTE: for bucket:'blossom' this is a LABEL, not
   *  enforcement — that bucket has a public read host. */
  visibility?: "public" | "private";
}

export async function registerExistingObjectMedia(
  env: Env, input: RegisterExistingObjectInput,
): Promise<{ id: string; dedup: boolean; key: string }> {
  const mdb = mediaSession(env);
  const existing = await mdb.prepare("SELECT id FROM user_media WHERE key=?1 AND uid=?2 LIMIT 1")
    .bind(input.key, input.uid).first<{ id: string }>();
  if (existing) return { id: existing.id, dedup: true, key: input.key };

  const app = input.app || "avatok";
  const category = input.category || categoryOf(input.mimeType);
  const visibility = input.visibility || "private";
  const sourceKind = input.sourceKind || "sent";
  const storage = input.bucket === "digital" ? "digital" : "blossom";
  // A 'digital' row's URL is presigned per read (getLibrary), so it is stored
  // empty exactly as uploadPrivate()/registerArtifactMedia() store it.
  const displayUrl = input.bucket === "digital" ? "" : `${env.BLOSSOM_BASE_URL}/${input.key}`;
  const id = crypto.randomUUID();
  await mdb.prepare(
    `INSERT INTO user_media (id, uid, media_type, storage, visibility, encrypted, key, display_url, mime_type, size_bytes, original_app, created_at, moderation_status, category, file_name, source_kind)
     VALUES (?1,?2,?3,?4,?5,0,?6,?7,?8,?9,?10,?11,'skipped',?12,?13,?14)`,
  ).bind(
    id, input.uid, artifactMediaKind(input.mimeType), storage, visibility, input.key, displayUrl,
    input.mimeType, Math.max(0, Math.round(input.sizeBytes)), app, Date.now(), category,
    input.fileName, sourceKind,
  ).run();
  // Same storage recompute + live push every other register path runs. Never
  // fatal — the object is already in R2 either way.
  await afterRegisterFile(env, input.uid, {
    kind: category, bytes: input.sizeBytes, source_app: app, dedup: false,
  }).catch(() => {});
  return { id, dedup: false, key: input.key };
}

// Local to registerArtifactMedia — deliberately distinct from mediaType()
// above (which defaults anything non-image/audio/video to "image" and would
// mis-tag a text/PDF artifact). AI-derived documents/transcripts are the
// common case here, so they get their own correct "document" bucket.
function artifactMediaKind(mime: string): string {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "document";
}

// Per-user storage prefix with a type subfolder → everything a user owns lives
// under `u/<uid>/…`, so an account delete is one prefix wipe and nothing of
// another user's can be touched. `uid` is bech32 (safe charset).
//   u/<uid>/public/<hash>   public posts
//   u/<uid>/dm/<hash>       DM ciphertext (E2E — opaque, safe in the PUBLIC bucket)
//   u/<uid>/private/<hash>  [B3 / voice-note MVP] server-readable PLAINTEXT that is
//                           NOT public — lives in the DIGITAL bucket, never BLOBS.
//   u/<uid>/video/…         (future) Bunny is separate, but keep the convention
//   u/<uid>/backups/…       account exports
function userKey(uid: string, kind: "public" | "dm" | "private", hash: string): string {
  return `u/${uid}/${kind}/${hash}`;
}

// [B3 fix] The ONE place that mints a fetchable URL for a DIGITAL-bucket
// (private, server-readable) object. A private object is NEVER served by the
// public blossom.avatok.ai domain (that bucket has no auth at all — an
// unguessable path is not access control, which is the exact defect this
// issue fixes). Same SigV4 query-presign scheme as routes/olx.ts's digital
// downloads; short expiry (15 min) because every caller re-mints on read
// rather than persisting a URL that would go stale or leak a long-lived
// credential. Returns null (never throws) when R2 S3 credentials aren't
// configured — callers must treat that as "not downloadable yet", the same
// precondition routes/olx.ts's presigned branch already has.
export async function presignDigitalReadUrl(env: Env, r2Key: string, expiresSec = 900): Promise<string | null> {
  if (!(env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_ACCOUNT_ID)) return null;
  // [AVA-MEDIA-AUTHZ-1 fix] Per-environment bucket name (staging vs prod use
  // different avatok-digital* bucket names, worker/wrangler.toml). NO
  // hardcoded "avatok-digital" fallback anymore — that silently made staging
  // sign against the PRODUCTION bucket whenever DIGITAL_BUCKET_NAME was
  // unset. Fail CLOSED instead: an unset var means the environment isn't
  // configured yet, not "assume prod".
  const bucket = (env as unknown as { DIGITAL_BUCKET_NAME?: string }).DIGITAL_BUCKET_NAME;
  if (!bucket) return null;
  try {
    return await presignGetUrl({
      url: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${bucket}/${r2Key}`,
      region: "auto", service: "s3",
      accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      expiresSec,
    });
  } catch { return null; }
}

// VIDPOL-2: 64 MB hard cap on video uploads (both /upload/public and
// /upload/private). The client transcodes to 720p H.264 and rejects locally with
// the SAME copy; this is the server-side backstop. Returns a 413 Response to
// return early, or null when the upload is allowed.
const VIDEO_MAX_BYTES = 64 * 1024 * 1024; // 64 MB
const VIDEO_TOO_BIG_MSG =
  "Videos are limited to 64 MB (about 3–5 minutes). Trim it and try again.";
function videoCapReject(mime: string, byteLength: number): Response | null {
  if (!String(mime || "").toLowerCase().startsWith("video/")) return null;
  if (byteLength <= VIDEO_MAX_BYTES) return null;
  return json({ error: "too_large", message: VIDEO_TOO_BIG_MSG }, 413);
}

// GET /media/:hash — back-compat shim. Old app fetched bytes here; now we 301 to
// the public bucket. Removed entirely at Phase 5 once the app reads blossom directly.
export function mediaRedirect(path: string, env: Env): Response {
  const hash = path.split("/").pop();
  return new Response(null, { status: 301, headers: { ...CORS, location: `${env.BLOSSOM_BASE_URL}/${hash}` } });
}

// Columns every Library item view returns (kept stable for the client model).
// `storage` is selected ONLY to decide whether display_url needs a fresh
// presign below — stripped back off each row before the response goes out
// (see getLibrary) so the client-facing shape is unchanged.
const LIB_COLS =
  "id, media_type, category, key, display_url, thumbnail_url, mime_type, file_name, " +
  "size_bytes, visibility, original_app, folder_id, source_kind, enc_blob, created_at, storage";

// GET /api/library?app=&category=&folder=&type=&cursor= — paginated file list for
// ONE view (an app→category bucket, or a user folder). Soft-deleted rows excluded.
// Back-compat: a bare ?type= still works (legacy chat library callers).
export async function getLibrary(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const sp = new URL(req.url).searchParams;
  const cursor = Number(sp.get("cursor") || Date.now());
  const app = sp.get("app");
  const category = sp.get("category") || sp.get("type");
  const folder = sp.get("folder");
  const q = (sp.get("q") || "").trim();
  const where: string[] = ["uid=?1", "deleted_at IS NULL", "created_at < ?2"];
  const binds: any[] = [ctx.uid, cursor];
  // Phase 4: server-side name search (file_name LIKE, escaped).
  if (q) { where.push(`file_name LIKE ?${binds.length + 1} ESCAPE '\\'`); binds.push(`%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`); }
  if (folder) { where.push(`folder_id=?${binds.length + 1}`); binds.push(folder); }
  else {
    // System (auto) folder view: files NOT placed in a user folder. A name
    // search (?q=) spans user folders too — it's a find, not a folder view.
    if (!q) where.push("folder_id IS NULL");
    if (app) { where.push(`original_app=?${binds.length + 1}`); binds.push(app); }
    // PDFs are split out of the 'document' bucket; 'doc' = documents that aren't PDFs.
    if (category === "pdf") {
      where.push(`mime_type=?${binds.length + 1}`); binds.push("application/pdf");
    } else if (category === "doc") {
      where.push(`category='document' AND mime_type<>?${binds.length + 1}`); binds.push("application/pdf");
    } else if (category) {
      where.push(`(category=?${binds.length + 1} OR media_type=?${binds.length + 1})`); binds.push(category);
    }
  }
  // [SPEC-SEND-3] Speculative uploads are NOT files the user has: they were
  // staged before a Send that may never happen, they are already excluded from
  // the storage quota, and the 24h sweep deletes them. Showing them in
  // AvaLibrary would offer the user a file that vanishes on its own.
  const rs = await withCommittedFilter((filter) => mediaSession(env)
    .prepare(`SELECT ${LIB_COLS} FROM user_media WHERE ${where.join(" AND ")} AND ${filter} ORDER BY created_at DESC LIMIT 30`)
    .bind(...binds).all());
  const items = (rs.results ?? []) as any[];
  const next = items.length === 30 ? items[items.length - 1].created_at : null;
  // [B3 / voice-note MVP] A stored display_url is only ever valid for a
  // public-bucket row. A 'digital' (private, server-readable) row's
  // display_url was recorded empty/soon-stale at write time (uploadPrivate /
  // libraryRecord above) — re-mint a fresh short-lived presigned URL on every
  // read instead, and strip the internal `storage` field back off before it
  // reaches the client (LIB_COLS's public contract is unchanged).
  await Promise.all(items.map(async (it) => {
    if (it.storage === "digital") it.display_url = (await presignDigitalReadUrl(env, it.key)) || it.display_url;
    delete it.storage;
  }));
  return json({ items, cursor: next });
}

// GET /api/library/tree — the navigation skeleton: per-app totals + per-category
// counts (system folders) and the user's folders grouped by app. Cheap aggregates.
export async function getLibraryTree(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const mdb = mediaSession(env);
  // Split the 'document' bucket into pdf vs doc so the client root reads like a
  // clean file manager (Images/Videos/PDFs/Documents/Music/Other). Additive: the
  // client folds pdf/doc back into a single "Documents" folder if it ever sees a
  // legacy 'document'-only tree.
  // [SPEC-SEND-3] Same exclusion as getLibrary: a staged-but-unsent file must not
  // inflate a folder count or a byte total (it isn't in the quota either).
  const agg = await withCommittedFilter((filter) => mdb.prepare(
    `SELECT COALESCE(original_app,'avatok') AS app,
            CASE
              WHEN mime_type='application/pdf' THEN 'pdf'
              WHEN COALESCE(category,'other')='document' THEN 'doc'
              ELSE COALESCE(category,'other')
            END AS category,
            COUNT(*) AS n, COALESCE(SUM(size_bytes),0) AS bytes
     FROM user_media WHERE uid=?1 AND deleted_at IS NULL AND ${filter}
     GROUP BY app, category`,
  ).bind(ctx.uid).all());
  const apps: Record<string, any> = {};
  for (const r of (agg.results ?? []) as any[]) {
    const a = (apps[r.app] ||= { app: r.app, total: 0, bytes: 0, by_category: {} });
    a.by_category[r.category] = { count: r.n, bytes: r.bytes };
    a.total += r.n; a.bytes += r.bytes;
  }
  const fr = await mdb.prepare(
    "SELECT id, app, name, parent_id, created_at FROM library_folders WHERE uid=?1 ORDER BY created_at ASC",
  ).bind(ctx.uid).all();
  const foldersByApp: Record<string, any[]> = {};
  for (const f of (fr.results ?? []) as any[]) (foldersByApp[f.app] ||= []).push(f);
  return json({ apps: Object.values(apps), folders_by_app: foldersByApp });
}

// --- /api/library/folders — user-folder CRUD ---
// GET ?app=  list · POST create · PATCH rename · DELETE ?id= (reparents files).
export async function libraryFolders(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const mdb = mediaSession(env);
  const url = new URL(req.url);

  if (req.method === "GET") {
    const app = url.searchParams.get("app");
    const rs = app
      ? await mdb.prepare("SELECT id, app, name, parent_id, created_at FROM library_folders WHERE uid=?1 AND app=?2 ORDER BY created_at ASC").bind(ctx.uid, app).all()
      : await mdb.prepare("SELECT id, app, name, parent_id, created_at FROM library_folders WHERE uid=?1 ORDER BY created_at ASC").bind(ctx.uid).all();
    return json({ folders: rs.results ?? [] });
  }

  if (req.method === "POST") {
    const b = (await req.json().catch(() => ({}))) as any;
    const name = (b.name || "").toString().trim().slice(0, 120);
    const app = (b.app || "avatok").toString().toLowerCase();
    if (!name) return json({ error: "name required" }, 400);
    const id = crypto.randomUUID();
    await mdb.prepare(
      "INSERT INTO library_folders (id, uid, app, name, parent_id, created_at) VALUES (?1,?2,?3,?4,?5,?6)",
    ).bind(id, ctx.uid, app, name, b.parent_id ?? null, Date.now()).run();
    return json({ id, app, name, parent_id: b.parent_id ?? null });
  }

  if (req.method === "PATCH" || req.method === "PUT") {
    const b = (await req.json().catch(() => ({}))) as any;
    const name = (b.name || "").toString().trim().slice(0, 120);
    if (!b.id || !name) return json({ error: "id and name required" }, 400);
    await mdb.prepare("UPDATE library_folders SET name=?3 WHERE id=?1 AND uid=?2").bind(b.id, ctx.uid, name).run();
    return json({ ok: true });
  }

  if (req.method === "DELETE") {
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "id required" }, 400);
    // Don't orphan files: reparent them to the app auto folder (folder_id NULL).
    await mdb.batch([
      mdb.prepare("UPDATE user_media SET folder_id=NULL WHERE uid=?1 AND folder_id=?2").bind(ctx.uid, id),
      mdb.prepare("UPDATE library_folders SET parent_id=NULL WHERE uid=?1 AND parent_id=?2").bind(ctx.uid, id),
      mdb.prepare("DELETE FROM library_folders WHERE id=?1 AND uid=?2").bind(id, ctx.uid),
    ]);
    return json({ ok: true });
  }
  return json({ error: "method" }, 405);
}

// POST /api/library/move {id, folder_id|null, app?} — place a file in a user
// folder (or back to its system folder when folder_id is null). Passing `app`
// moves it across app roots too (AvaLibrary lets files move anywhere).
export async function libraryMove(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  if (!b.id) return json({ error: "id required" }, 400);
  const mdb = mediaSession(env);
  if (b.app) {
    await mdb.prepare("UPDATE user_media SET folder_id=?3, original_app=?4 WHERE id=?1 AND uid=?2")
      .bind(b.id, ctx.uid, b.folder_id ?? null, String(b.app).toLowerCase()).run();
  } else {
    await mdb.prepare("UPDATE user_media SET folder_id=?3 WHERE id=?1 AND uid=?2")
      .bind(b.id, ctx.uid, b.folder_id ?? null).run();
  }
  return json({ ok: true });
}

// POST /api/library/copy {id, folder_id, app?} — a shortcut: a NEW row pointing at
// the SAME content-addressed key. Storage counts distinct keys, so this is free
// bytes. Passing `app` lands the copy under another app root.
export async function libraryCopy(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  if (!b.id) return json({ error: "id required" }, 400);
  const mdb = mediaSession(env);
  // [SPEC-SEND-3] `id` comes from the caller, not from a Library listing, so this
  // is the one copy path that can still name a staged-but-unsent row. Refuse it:
  // copyMediaRow duplicates moderation_status verbatim, so a 'staged' source
  // would mint a committed, quota-counted, library-visible PUBLIC row that no
  // scan is ever enqueued for. Commit first (/api/media/commit), then copy.
  const src = await withCommittedFilter((filter) => mdb
    .prepare(`SELECT ${LIB_COLS}, media_type, storage, encrypted, moderation_status FROM user_media WHERE id=?1 AND uid=?2 AND ${filter}`)
    .bind(b.id, ctx.uid).first<any>());
  if (!src) return json({ error: "not found" }, 404);
  const id = await copyMediaRow(mdb, ctx.uid, src, b.folder_id ?? null, b.app ? String(b.app).toLowerCase() : src.original_app);
  return json({ id });
}

// Insert a duplicate of a media row (same content key → free storage) into a
// target folder/app. Shared by file-copy and folder-copy.
async function copyMediaRow(mdb: any, uid: string, src: any, folderId: string | null, app: string): Promise<string> {
  const id = crypto.randomUUID();
  await mdb.prepare(
    `INSERT INTO user_media (id, uid, media_type, storage, visibility, encrypted, key, display_url, thumbnail_url, mime_type, size_bytes, original_app, created_at, moderation_status, category, file_name, folder_id, source_kind, enc_blob)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)`,
  ).bind(id, uid, src.media_type, src.storage, src.visibility, src.encrypted, src.key, src.display_url, src.thumbnail_url ?? null,
    src.mime_type, src.size_bytes, app, Date.now(), src.moderation_status, src.category, src.file_name,
    folderId, src.source_kind, src.enc_blob ?? null).run();
  return id;
}

// Walk up the parent chain from `start` to check whether `ancestorId` is an
// ancestor (used to block moving/copying a folder into its own subtree).
async function isInSubtree(mdb: any, uid: string, start: string | null, ancestorId: string): Promise<boolean> {
  let cur = start;
  let hops = 0;
  while (cur && hops < 64) {
    if (cur === ancestorId) return true;
    const row = await mdb.prepare("SELECT parent_id FROM library_folders WHERE id=?1 AND uid=?2").bind(cur, uid).first();
    cur = (row as any)?.parent_id ?? null;
    hops++;
  }
  return false;
}

// POST /api/library/folders/move {id, app?, parent_id?} — re-home a whole folder:
// nest it under another folder (parent_id) and/or move it to another app root.
// Files inside travel with the folder; when the app changes they're re-stamped so
// the tree's per-app counts stay honest.
export async function libraryFolderMove(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  if (!b.id) return json({ error: "id required" }, 400);
  const mdb = mediaSession(env);
  const folder = await mdb.prepare("SELECT id, app, parent_id FROM library_folders WHERE id=?1 AND uid=?2").bind(b.id, ctx.uid).first<any>();
  if (!folder) return json({ error: "not found" }, 404);
  const newApp = b.app ? String(b.app).toLowerCase() : folder.app;
  const newParent = b.parent_id === undefined ? folder.parent_id : (b.parent_id ?? null);
  if (newParent && (newParent === b.id || await isInSubtree(mdb, ctx.uid, newParent, b.id))) {
    return json({ error: "cannot move a folder into itself" }, 400);
  }
  const stmts = [
    mdb.prepare("UPDATE library_folders SET app=?3, parent_id=?4 WHERE id=?1 AND uid=?2").bind(b.id, ctx.uid, newApp, newParent),
  ];
  if (newApp !== folder.app) {
    stmts.push(mdb.prepare("UPDATE user_media SET original_app=?3 WHERE uid=?1 AND folder_id=?2").bind(ctx.uid, b.id, newApp));
  }
  await mdb.batch(stmts);
  return json({ ok: true, id: b.id, app: newApp, parent_id: newParent });
}

// POST /api/library/folders/copy {id, app?, parent_id?} — duplicate a folder and
// everything inside it (recursively). Files are copied as shortcuts (same content
// key → no extra storage). Returns the new top-level folder id.
export async function libraryFolderCopy(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  if (!b.id) return json({ error: "id required" }, 400);
  const mdb = mediaSession(env);
  const folder = await mdb.prepare("SELECT id, app, parent_id FROM library_folders WHERE id=?1 AND uid=?2").bind(b.id, ctx.uid).first<any>();
  if (!folder) return json({ error: "not found" }, 404);
  const destApp = b.app ? String(b.app).toLowerCase() : folder.app;
  const destParent = b.parent_id ?? null;
  if (destParent && (destParent === b.id || await isInSubtree(mdb, ctx.uid, destParent, b.id))) {
    return json({ error: "cannot copy a folder into itself" }, 400);
  }
  const newId = await copyFolderRec(mdb, ctx.uid, b.id, destApp, destParent);
  return json({ id: newId });
}

// Recursively duplicate a folder subtree (folder rows + their non-deleted files).
async function copyFolderRec(mdb: any, uid: string, srcId: string, destApp: string, destParent: string | null): Promise<string | null> {
  const src = (await mdb.prepare("SELECT id, name FROM library_folders WHERE id=?1 AND uid=?2").bind(srcId, uid).first()) as any;
  if (!src) return null;
  const newId = crypto.randomUUID();
  await mdb.prepare("INSERT INTO library_folders (id, uid, app, name, parent_id, created_at) VALUES (?1,?2,?3,?4,?5,?6)")
    .bind(newId, uid, destApp, src.name, destParent, Date.now()).run();
  // [SPEC-SEND-3] Don't duplicate a staged-but-unsent file into the copy: it is
  // invisible in the source folder and the sweep will delete it out from under
  // the copy, leaving a shortcut to nothing.
  const files = await withCommittedFilter<any>((filter) => mdb.prepare(
    `SELECT ${LIB_COLS}, media_type, storage, encrypted, moderation_status FROM user_media WHERE uid=?1 AND folder_id=?2 AND deleted_at IS NULL AND ${filter}`,
  ).bind(uid, srcId).all());
  for (const f of (files.results ?? []) as any[]) {
    await copyMediaRow(mdb, uid, f, newId, destApp);
  }
  const kids = await mdb.prepare("SELECT id FROM library_folders WHERE uid=?1 AND parent_id=?2").bind(uid, srcId).all();
  for (const k of (kids.results ?? []) as any[]) {
    await copyFolderRec(mdb, uid, k.id, destApp, newId);
  }
  return newId;
}

// POST /api/library/delete {id} — soft delete (storage recomputes; hard-delete of
// orphaned blobs runs via the erasure queue / account-deletion cascade).
export async function libraryDelete(req: Request, env: Env, exec?: ExecutionContext): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  if (!b.id) return json({ error: "id required" }, 400);
  await mediaSession(env).prepare("UPDATE user_media SET deleted_at=?3 WHERE id=?1 AND uid=?2")
    .bind(b.id, ctx.uid, Date.now()).run();
  // Phase 4: quota frees when the LAST reference to a key goes (dedup recompute).
  const reg = afterRegisterFile(env, ctx.uid);
  if (exec) exec.waitUntil(reg); else await reg.catch(() => { /* best-effort */ });
  return json({ ok: true });
}

// POST /api/library/record — receiver-side Library entry for DM media the user
// RECEIVED. The blob is already content-addressed on R2 (uploaded by the sender);
// we store the recipient's reference + their decryption material ENCRYPTED TO THEM
// (enc_blob — Vault-style; the server never sees plaintext keys). Makes received
// media cross-device + (opt-in) brain-eligible without weakening E2E.
export async function libraryRecord(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  const key = (b.key || "").toString();
  if (!key) return json({ error: "key required" }, 400);

  // [B2 fix / AVA-MEDIA-AUTHZ-1 — CRITICAL] `key` used to be taken raw with
  // NO validation that the caller ever received it. Pre-wave that was
  // harmless (the row only ever produced a public-bucket blossom URL — no
  // privilege gained). This wave changed that: b.storage==='digital' routes
  // the row into the PRIVATE bucket and calls presignDigitalReadUrl(), and
  // getLibrary() re-mints that presign on every read — so any authenticated
  // user could POST an arbitrary victim's (or an OLX paid-digital-good's,
  // env.DIGITAL is shared with routes/olx.ts) key and mint themselves a
  // valid SigV4 read for it. Fixed by:
  //   1. Rejecting any key that doesn't match the real `u/<uid>/<kind>/<hash>`
  //      shape this codebase actually writes (userKey() above).
  //   2. Requiring the caller to send `conv` and proving BOTH the key's
  //      owner (parsed from the key, not trusted from the body) AND the
  //      caller are members of that SAME conversation — a forged key for a
  //      stranger's media never shares a conversation with the attacker.
  //   3. Never trusting b.storage/b.enc_blob to decide privacy: `encrypted`/
  //      `visibility`/`storage` are derived from the OWNER's OWN user_media
  //      row (a client-asserted sensitivity is the input to a privacy
  //      decision — attacker-controlled). enc_blob's VALUE (the recipient's
  //      E2E-wrapped decryption key) is still accepted from the body — it is
  //      opaque, recipient-specific ciphertext the server never reads, not a
  //      privilege signal.
  //   4. Denying by default (404) when no matching owner row exists — a key
  //      with no real backing upload is a forgery attempt, not "record what
  //      I received".
  // [MEDIA-KEY-UID-1 2026-08-14] `[a-z0-9]+` REJECTED every real Clerk uid —
  // they all contain an underscore (`user_3Auq…`), so since [AVA-MEDIA-AUTHZ-1]
  // (2026-07-25) EVERY library/record call 400'd `invalid_key` and received
  // media silently stopped being recorded (found via hdavy2002's device
  // exception LibraryRecordException status=400 code=invalid_key). Charset now
  // matches Clerk ids (word chars + hyphen); the 64-hex tail stays strict, so
  // the AUTHZ-1 forgery protections are unchanged.
  const keyMatch = /^u\/([A-Za-z0-9_-]+)\/(public|dm|private)\/[0-9a-f]{64}$/i.exec(key);
  if (!keyMatch) return json({ error: "invalid_key" }, 400);
  const senderUid = keyMatch[1];
  const conv = (b.conv || "").toString().trim();
  // [AVA-MEDIA-AUTHZ-1 — BACKWARD COMPATIBILITY] `conv` is a NEW required field.
  // The shipped production client (build 10462 and every build before it) does
  // NOT send it, and the APK rollout lags this worker deploy by days. Hard-
  // requiring it would 400 every existing user's "record the media I just
  // received" call — i.e. break media receiving for the entire installed base
  // to close a hole none of those clients can reach.
  //
  // The privilege escalation B2 describes exists ONLY on the digital/private
  // path: that is what mints a SigV4 presigned read and what shares a bucket
  // with OLX paid goods. A legacy client cannot produce a digital row (it has
  // no plaintext-voice upload path), so gating strictly on the OWNER's real
  // storage class is both sufficient and safe:
  //   - owner row is `digital`  -> conv + two-sided membership REQUIRED, no exceptions.
  //   - owner row is `blossom`  -> pre-wave behaviour, which granted no
  //     privilege (public bucket URL, or opaque AES ciphertext for a DM).
  //     Verify membership when `conv` IS supplied (new clients), skip when it
  //     is absent (old clients) rather than locking them out.
  // The owner-row lookup below is the real backstop either way: a key with no
  // backing upload is rejected 404, so a forged key never records at all.
  const convChecked = conv
    ? (await isConvMember(env, conv, senderUid)) && (await isConvMember(env, conv, ctx.uid))
    : false;
  if (conv && !convChecked) return json({ error: "forbidden" }, 403);

  const mime = (b.mime || "application/octet-stream").toString();
  const app = (b.app || "avatok").toString().toLowerCase();
  const size = Number(b.size || 0);
  const name = (b.name || defaultName(mime, key)).toString();

  const mdb = mediaSession(env);
  const ownerRow = await mdb.prepare(
    "SELECT storage, visibility, encrypted FROM user_media WHERE uid=?1 AND key=?2 AND deleted_at IS NULL LIMIT 1",
  ).bind(senderUid, key).first<{ storage: string; visibility: string; encrypted: number }>();
  if (!ownerRow) return json({ error: "source_not_found" }, 404);

  const isDigital = ownerRow.storage === "digital";
  // [AVA-MEDIA-AUTHZ-1] The B2 escalation lives entirely here: a `digital` row
  // is the only one that mints a presigned read into the private bucket shared
  // with OLX paid goods. No conv, or an unverified conv, NEVER reaches it —
  // regardless of client version. A legacy client cannot legitimately hit this
  // branch, so refusing it costs nothing and closes the hole completely.
  if (isDigital && !convChecked) {
    return json({ error: conv ? "forbidden" : "conv_required" }, conv ? 403 : 400);
  }
  const encrypted = isDigital ? 0 : (ownerRow.encrypted ? 1 : 0);
  const visibility = ownerRow.visibility === "public" ? "public" : "private";
  const storage = isDigital ? "digital" : "blossom";
  const display = isDigital
    ? ((await presignDigitalReadUrl(env, key)) || "")
    : (b.display_url || `${env.BLOSSOM_BASE_URL}/${key}`).toString();
  // Idempotent per (uid, key, received): re-receiving the same blob is a no-op.
  const existing = await mdb.prepare("SELECT id FROM user_media WHERE uid=?1 AND key=?2 AND source_kind='received'").bind(ctx.uid, key).first<any>();
  if (existing) return json({ id: existing.id, deduped: true });
  const id = crypto.randomUUID();
  await mdb.prepare(
    `INSERT INTO user_media (id, uid, media_type, storage, visibility, encrypted, key, display_url, mime_type, size_bytes, original_app, created_at, moderation_status, category, file_name, source_kind, enc_blob)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'skipped',?13,?14,'received',?15)`,
  ).bind(id, ctx.uid, mediaType(mime), storage, visibility, encrypted, key, display, mime, size, app, Date.now(),
    categoryOf(mime), name, b.enc_blob ?? null).run();
  // PUBLIC received media is brain-eligible server-side; private (E2E OR
  // digital-private) stays out of the automatic public-brain path — indexing
  // private/received media is the separate AVABRAIN-INGEST-1 consent-gated
  // pipeline (Specs/ROOT-CAUSE-REPORT-RECURRING-ISSUES-2026-07-25.md §40), not
  // this endpoint.
  if (!encrypted && !isDigital && env.Q_BRAIN) {
    exec.waitUntil(maybeEmitLibraryBrain(env, ctx.uid, app, { media_id: id, key, mime, size, name, category: categoryOf(mime), visibility: "public" }));
  }
  // Phase 4: received files join the recipient's pool too → recompute + live push.
  exec.waitUntil(afterRegisterFile(env, ctx.uid, { kind: categoryOf(mime), bytes: size, source_app: app, dedup: false }));
  return json({ id });
}

// GET /api/storage — AvaStorage accounting for the bars UI. One universal pool per
// account. Bytes are summed over DISTINCT content keys (shortcuts/copies don't
// double-count), non-deleted only. Quota: free GB from config; over quota draws
// Tokens/GB/month from the AvaWallet — an empty wallet over quota = read-only.
export async function getStorage(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const mdb = mediaSession(env);
  // Distinct-key dedup: one physical copy per key, charged once. We pick a single
  // representative row per key (MIN(id)) then aggregate its category/app/bytes.
  // [SPEC-SEND-1 / WS-30a] Speculative (uncommitted) rows are excluded here for
  // the same reason and in the same place as storage.ts's recomputeStorage —
  // inside the CTE, so the representative row per key is chosen from committed
  // rows only. If these two disagreed, /api/storage and the storage_quota
  // summary the bars actually repaint from would show different numbers.
  const dedupTail =
    `SELECT COALESCE(m.category,'other') AS category, COALESCE(m.original_app,'avatok') AS app, m.size_bytes AS size
     FROM dedup d JOIN user_media m ON m.id = d.rep`;
  const rs = await mdb.prepare(
    `WITH dedup AS (
       SELECT key, MIN(id) AS rep FROM user_media
       WHERE uid=?1 AND deleted_at IS NULL AND COALESCE(uncommitted,0)=0 GROUP BY key
     )
     ${dedupTail}`,
  ).bind(ctx.uid).all().catch(async () =>
    // Deploy window: worker live, migrations/media_uncommitted.sql not applied to
    // this environment's D1 yet. No column ⇒ no uncommitted row can exist, so the
    // unfiltered SUM is exactly the same number, not an approximation.
    await mdb.prepare(
      `WITH dedup AS (
         SELECT key, MIN(id) AS rep FROM user_media
         WHERE uid=?1 AND deleted_at IS NULL GROUP BY key
       )
       ${dedupTail}`,
    ).bind(ctx.uid).all(),
  );
  const byCategory: Record<string, number> = { image: 0, video: 0, document: 0, audio: 0, other: 0 };
  const byApp: Record<string, number> = {};
  let total = 0;
  for (const r of (rs.results ?? []) as any[]) {
    const sz = Number(r.size || 0);
    byCategory[r.category] = (byCategory[r.category] || 0) + sz;
    byApp[r.app] = (byApp[r.app] || 0) + sz;
    total += sz;
  }
  const freeGb = Number(env.STORAGE_FREE_GB || "5");
  const quota = freeGb * 1024 * 1024 * 1024;
  let state: "ok" | "read_only" = "ok";
  if (total > quota) {
    // Over the free quota — needs Tokens. Empty wallet → read-only (never delete).
    let coins = 0;
    try {
      const w = await walletOp(env, ctx.uid, { op: "balance", uid: ctx.uid });
      coins = Number(w.body?.balance ?? w.body?.coins ?? w.body?.available ?? 0);
    } catch { /* wallet optional → treat as 0 */ }
    if (coins <= 0) state = "read_only";
  }
  return json({ total_used: total, quota, by_category: byCategory, by_app: byApp, state, free_gb: freeGb });
}

const STUN_FALLBACK = [{ urls: "stun:stun.cloudflare.com:3478" }];

export interface IceServerResult {
  iceServers: unknown[];
  /** True when the response is STUN-only and TURN relay is unavailable. */
  relayDegraded: boolean;
  relayReason?: string;
}

/**
 * Mint short-lived STUN+TURN ICE servers from Cloudflare Calls. Returns the
 * `iceServers` value (array of RTCIceServer) — Cloudflare-STUN-only fallback when
 * TURN isn't configured or the call fails. Shared by GET /ice (1:1 + mesh) and
 * the group-conference token issue (so LiveKit clients can relay via Cloudflare
 * TURN). `ttl` seconds (default 24h). Never throws.
 */
export async function mintIceServersWithStatus(env: Env, ttl = 86400): Promise<IceServerResult> {
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) {
    return { iceServers: STUN_FALLBACK, relayDegraded: true, relayReason: "turn_not_configured" };
  }
  try {
    const r = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ttl }),
      },
    );
    if (!r.ok) return { iceServers: STUN_FALLBACK, relayDegraded: true, relayReason: `turn_http_${r.status}` };
    const data = (await r.json()) as any;
    const ice = data.iceServers ?? data;
    const iceServers = Array.isArray(ice) ? ice : [ice];
    if (!iceServers.length) return { iceServers: STUN_FALLBACK, relayDegraded: true, relayReason: "turn_empty_response" };
    return { iceServers, relayDegraded: false };
  } catch {
    return { iceServers: STUN_FALLBACK, relayDegraded: true, relayReason: "turn_request_failed" };
  }
}

export async function mintIceServers(env: Env, ttl = 86400): Promise<unknown[]> {
  return (await mintIceServersWithStatus(env, ttl)).iceServers;
}

// GET /ice — short-lived STUN+TURN credentials from Cloudflare Calls.
export async function getIce(env: Env): Promise<Response> {
  const result = await mintIceServersWithStatus(env);
  return json({ iceServers: result.iceServers, relay_available: !result.relayDegraded, relay_degraded: result.relayDegraded, ...(result.relayReason ? { relay_reason: result.relayReason } : {}) });
}

function mediaType(ct: string): string {
  if (ct.startsWith("image/")) return "image";
  if (ct.startsWith("audio/")) return "audio";
  if (ct.startsWith("video/")) return "video";
  return "image";
}

// AvaLibrary category from a mime type. The library bucket the file lands in.
export function categoryOf(ct: string): string {
  if (ct.startsWith("image/")) return "image";
  if (ct.startsWith("video/")) return "video";
  if (ct.startsWith("audio/")) return "audio";
  if (
    ct === "application/pdf" ||
    ct.startsWith("text/") ||
    ct.startsWith("application/msword") ||
    ct.startsWith("application/vnd.")
  ) return "document";
  return "other";
}

// --- AvaBrain consent gate (Golden Rule 15: default ON, opt-out) ---
// Ingestion producers must check the toggle BEFORE learning. Absence of a row =
// enabled (default ON). We require BOTH the master switch and the per-app "files"
// capability to be on. brain_consent lives in DB_BRAIN (server-readable booleans —
// not sensitive). Private/E2E plaintext never reaches this path regardless.
export async function brainConsentAllows(env: Env, uid: string, app: string): Promise<boolean> {
  try {
    const caps = [`master`, `${app}_files`];
    const rs = await env.DB_BRAIN.prepare(
      `SELECT capability, enabled FROM brain_consent WHERE uid=?1 AND capability IN (?2,?3)`,
    ).bind(uid, caps[0], caps[1]).all();
    for (const r of (rs.results ?? []) as any[]) {
      if (Number(r.enabled) === 0) return false; // explicit opt-out
    }
    return true; // default ON
  } catch { return false; } // [PRIV-CONSENT-1] D1 error → FAIL CLOSED: a brain_consent
                            // read failure must NOT ingest a possibly-opted-out user's
                            // private content. "Off = nothing captured" must hold even
                            // when the consent table is transiently unreadable (DPDP).
}

// Emit a library_file_added event for content ingestion, gated on consent.
export async function maybeEmitLibraryBrain(
  env: Env, uid: string, app: string,
  payload: { media_id: string; key: string; mime: string; size: number; name: string; category: string; visibility: string },
): Promise<void> {
  if (payload.visibility !== "public") return;            // server ingests PUBLIC only
  if (!(await brainConsentAllows(env, uid, app))) return; // user opted out
  // PAID-ONLY vector/transcribe/embed ingestion (owner decision 2026-06-20):
  // premium (topped-up wallet) users get their library files vectorised into the
  // server RAG so AvaChat can pull them; FREE users are indexed ON-DEVICE by the
  // client (AvaLocalIndex) and synced via their Drive backup — never here. Fail
  // closed: if the balance lookup errors we do NOT vectorise. Same source of
  // truth as lib/premium.ts isPremiumAI (wallet balance .premium === 1).
  try {
    const bal = await walletOp(env, uid, { op: "balance", uid });
    if (Number(bal.body?.premium ?? 0) !== 1) return;
  } catch { return; }
  await brainIngest(env, { uid, domain: "files", kind: "library_file_added", sourceId: String((payload as { media_id?: unknown }).media_id ?? ""), meta: payload as Record<string, unknown> });
}

// A sensible display name when the client didn't send one. Extension from mime.
function defaultName(ct: string, hash: string): string {
  const ext = ({
    "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
    "video/mp4": "mp4", "audio/mpeg": "mp3", "audio/aac": "m4a", "application/pdf": "pdf",
  } as Record<string, string>)[ct] || ct.split("/")[1] || "bin";
  return `${categoryOf(ct)}-${hash.slice(0, 8)}.${ext}`;
}
