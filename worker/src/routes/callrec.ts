// [CALLREC-SERVER-1] Call-recording server layer — the whole of it.
// Spec: Specs/FEASIBILITY-CALL-RECORDING-2026-08-04.md (rev 11, final).
//
// The audio is captured ON DEVICE (Android ADM taps — see §2/§3). This file only
// deals with what happens AFTER the call ends: register the finished .m4a into the
// user's existing storage pool, drop a card in their Inbox, and let them rename,
// play back and delete it.
//
// FOUR THINGS THIS FILE DELIBERATELY DOES NOT DO
//  1. No bespoke R2 write. Bytes go through registerArtifactMedia (routes/media.ts)
//     with sensitivity:'private', which gives content-addressed dedup, the
//     checkUploadAllowed() quota gate, the user_media row, and afterRegisterFile()'s
//     storage recompute + live socket push — all already built and already tested.
//     A recording NEVER touches the public BLOBS/blossom bucket.
//  2. No transcription, no STT, no LLM, no summary, no generated title, no summary
//     email. All removed by the owner in rev 11. `title`/`description` start EMPTY
//     and are only ever user-supplied.
//  3. No retention sweeper, no TTL. Recordings persist until the user deletes them;
//     they are paid for by the per-GB storage pool (§6.2).
//  4. No persisted playback URL. Private objects are presigned per access
//     (presignDigitalReadUrl); a stored URL would go stale and leak a credential.
//
// Routes (all authed, all gated on `callRecordingEnabled`):
//   POST  /api/callrec/finalize          SMALL recording: base64 upload + Inbox card
//   POST  /api/callrec/upload/begin      LARGE recording: open an R2 multipart upload
//   PUT   /api/callrec/upload/part       …one 5 MiB chunk, raw body
//   POST  /api/callrec/upload/complete   …assemble + the SAME finalize logic
//   POST  /api/callrec/upload/abort      …throw the parts away
//   PATCH /api/callrec/meta       user-supplied title/description, patched in place
//   POST  /api/callrec/delete     soft-hide the card + release the storage quota
//   GET   /api/callrec/playback   a freshly presigned read URL
//
// ── [CALLREC-UPLOAD-1] THE CHUNKED LANE ────────────────────────────────────────
// Recordings are unbounded (no duration cap). At ~11 MB/hour a 3-hour call is
// ~33 MB, which is ~44 MB of base64 in ONE request — a shape that fails often on
// mobile and puts a Worker isolate (128 MB ceiling) within sight of OOM because
// the base64 string AND the decoded copy are both resident. Spec §5.1 requires a
// resumable upload; this is it.
//
// FIVE PROPERTIES WORTH KNOWING BEFORE YOU CHANGE ANY OF IT
//  1. **Ownership is carried by the KEY, not by a session store.** The key is
//     always `u/<uid>/private/<sha256>` (registerArtifactMedia's own scheme), so
//     `key.startsWith("u/" + uid + "/private/")` IS the ownership check on every
//     part/complete/abort. No KV row, no D1 row, nothing to leak or expire, and
//     an upload_id for someone else's key is simply unusable.
//  2. **The bytes never pass through a Worker isolate as one buffer.** Each part
//     is streamed straight into R2; `complete` only stitches etags.
//  3. **The quota gate runs at `begin`**, before the client spends 40 MB of a
//     mobile plan, and again implicitly at `complete` (the row it writes is what
//     `recomputeStorage` counts). 413 `quota_exceeded` / `storage_full` is the
//     same contract the single-shot lane has always had.
//  4. **`complete` reuses the EXACT finalize path** (`finalizeRecording` below):
//     the same Inbox row, the same push, the same telemetry. There is one
//     definition of "a recording is saved", not two.
//  5. **The content hash is supplied by the client.** A Worker cannot hash a
//     multipart object without streaming it back through the isolate (workerd has
//     no incremental SubtleCrypto digest), so `sha256` is trusted for KEY
//     SELECTION only. It is scoped under the caller's own `u/<uid>/` prefix, so
//     the blast radius of a wrong hash is one user deduping against their own
//     file. It is never used as an authorization or integrity claim.
import type { Env } from "../types";
import { json, normalizePhone } from "../util";
import { requireUser, isFail } from "../authz";
import { readConfig } from "./config";
import { registerArtifactMedia, presignDigitalReadUrl } from "./media";
import { mediaSession } from "../db/shard";
import { afterRegisterFile, checkUploadAllowed } from "../storage";
import { trackException, trackUserContact } from "../hooks";
import { contactFor, publicIdentityFor } from "../lib/identity";

// ── size policy ────────────────────────────────────────────────────────────────
// THE THRESHOLD: the client sends anything **≤ 4 MiB** as a single base64 POST
// (`/finalize`) and anything larger through the chunked lane. 4 MiB of audio is
// ~5.4 MiB of base64 — a request size mobile networks handle without drama, and
// ~22 minutes of the spec's mono AAC, which covers the large majority of calls
// with the simpler code path.
//
// The server accepts base64 up to 8 MiB DECODED, i.e. double the client
// threshold. The headroom exists so a client that mis-measures (or an older build
// with a different constant) still succeeds rather than falling off a cliff;
// anything past it is told to use the chunked lane, not silently truncated.
const MAX_INLINE_BYTES = 8 * 1024 * 1024;
/** Kept as the documented name the client's `recording_too_large` maps to. */
const MAX_AUDIO_BYTES = MAX_INLINE_BYTES;

// R2 multipart rules that are NOT ours to choose: every part except the last must
// be the same size, the minimum part size is 5 MiB, and there is a 10,000-part
// ceiling. 5 MiB parts + the cap below keeps us well inside all three.
const PART_SIZE = 5 * 1024 * 1024;
const MAX_PARTS = 2048;
/** 1 GiB ≈ 90 hours of the spec's mono AAC. A recording larger than this is a
 *  bug in the recorder, not a long call. */
const MAX_RECORDING_BYTES = 1024 * 1024 * 1024;

const MAX_TITLE = 120;
const MAX_DESCRIPTION = 2000;
const CALL_ID_RE = /^[A-Za-z0-9_:.-]{1,64}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

/** Metadata every finalize (inline or chunked) needs. Identical field names on
 *  both lanes so the client builds the payload once. */
type RecordingMeta = {
  call_id?: string;
  peer_uid?: string;
  peer_name?: string;
  peer_phone?: string;
  peer_avatar?: string;
  direction?: string;
  started_at?: number;
  duration_s?: number;
  mime?: string;
  bytes?: number;
};

type FinalizeBody = RecordingMeta & {
  audio_b64?: string;
  upload_id?: string;
};

/** What landed in R2, however it got there. */
type StoredAudio = {
  mediaId: string;
  key: string;
  bytes: number;
  mime: string;
  dedup: boolean;
};

// ---------------------------------------------------------------------------
// POST /api/callrec/finalize — the SMALL-recording lane (base64, one request).
// Anything past MAX_INLINE_BYTES belongs on /upload/*; see the threshold note above.
// ---------------------------------------------------------------------------
export async function callRecFinalize(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const uid = ctx.uid;

  const cfg = await readConfig(env);
  if (cfg.callRecordingEnabled !== true) {
    return json({ error: "disabled", flag: "callRecordingEnabled" }, 403);
  }

  const b = (await req.json().catch(() => ({}))) as FinalizeBody;
  const meta = parseMeta(b);
  if (!meta.ok) return meta.resp;
  const { callId } = meta;

  // The chunked lane is a set of ROUTES now, not a mode of this one. A client
  // that still posts `upload_id` here is pointed at it explicitly rather than
  // being told 501 and dropping the recording.
  if (!b.audio_b64 && b.upload_id) {
    return json({
      error: "wrong_route", code: "use_upload_complete",
      message: "Chunked uploads finish at POST /api/callrec/upload/complete.",
    }, 400);
  }

  let audio: Uint8Array;
  try {
    audio = b64decode(String(b.audio_b64 ?? ""));
  } catch {
    return json({ error: "bad_audio", code: "audio_b64_invalid" }, 400);
  }
  if (!audio.byteLength) return json({ error: "bad_audio", code: "audio_empty" }, 400);
  if (audio.byteLength > MAX_AUDIO_BYTES) {
    return json({
      error: "too_large", code: "recording_too_large", max_bytes: MAX_AUDIO_BYTES,
      chunked: { begin: "/api/callrec/upload/begin", part_size: PART_SIZE },
      message: "That recording is too long to upload in one piece.",
    }, 413);
  }

  // ── storage ───────────────────────────────────────────────────────────────
  // sensitivity:'private' → DIGITAL bucket + presigned reads. category
  // 'call_recording' gives recordings their own bar in the AvaStorage graph.
  let reg;
  try {
    reg = await registerArtifactMedia(env, {
      uid, bytes: audio, mimeType: meta.mime,
      filePrefix: "call-recording", fileExt: extOf(meta.mime),
      category: "call_recording", app: "avacall", sensitivity: "private",
    });
  } catch (e) {
    // checkUploadAllowed() failing is the ONLY expected throw here: over quota with
    // an empty wallet, AvaStorage is read-only (it never deletes — §6). Render it as
    // a distinct 413 the client can turn into "storage full", not a generic error.
    const msg = String((e as { message?: string })?.message ?? e);
    const quota = msg.includes("insufficient_balance") || msg.includes("quota");
    // waitUntil: workerd drops UNAWAITED telemetry on an early-return error path
    // (CLAUDE.md). Every emit on a failure branch below is wrapped the same way.
    exec.waitUntil(trackException(env, e, {
      uid, route: "/api/callrec/finalize", method: "POST", handled: true,
      extra: { call_id: callId, bytes: audio.byteLength, quota },
    }));
    if (quota) return quotaFullResponse();
    return json({ error: "register_failed" }, 500);
  }

  return finalizeRecording(env, exec, uid, meta, {
    mediaId: reg.id, key: reg.key, bytes: audio.byteLength, mime: meta.mime, dedup: reg.dedup,
  }, "/api/callrec/finalize", "inline");
}

// ---------------------------------------------------------------------------
// POST /api/callrec/upload/begin — open an R2 multipart upload.
//
// Answers BEFORE the client spends a single byte of its data plan:
//   • is the flag on,
//   • do we already hold this exact content (→ `dedup`, skip the upload entirely
//     and go straight to complete),
//   • does it fit in the storage pool (→ 413 `storage_full`, the §5.1 requirement
//     that a user over quota is told first, not after uploading 40 MB).
// ---------------------------------------------------------------------------
export async function callRecUploadBegin(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const uid = ctx.uid;

  const cfg = await readConfig(env);
  if (cfg.callRecordingEnabled !== true) return json({ error: "disabled", flag: "callRecordingEnabled" }, 403);

  const b = (await req.json().catch(() => ({}))) as { call_id?: string; sha256?: string; bytes?: number; mime?: string };
  const callId = String(b.call_id ?? "");
  if (!CALL_ID_RE.test(callId)) return json({ error: "call_id required" }, 400);
  const sha = String(b.sha256 ?? "").trim().toLowerCase();
  if (!SHA256_RE.test(sha)) return json({ error: "sha256 required", code: "sha256_invalid" }, 400);
  const total = Math.round(Number(b.bytes) || 0);
  if (total <= 0) return json({ error: "bytes required" }, 400);
  if (total > MAX_RECORDING_BYTES) {
    return json({ error: "too_large", code: "recording_too_large", max_bytes: MAX_RECORDING_BYTES }, 413);
  }
  const mime = mimeOf(b.mime);
  const key = privateKeyFor(uid, sha);
  const partCount = Math.ceil(total / PART_SIZE);

  // Already held → nothing to upload. The client jumps straight to /complete with
  // no upload_id, which takes the dedup branch there.
  const existing = await mediaSession(env)
    .prepare("SELECT id FROM user_media WHERE key=?1 AND uid=?2 AND deleted_at IS NULL LIMIT 1")
    .bind(key, uid).first<{ id: string }>()
    .catch(() => null);
  if (existing) {
    // [CALLREC-TELEM-1] waitUntil, because this is an early return: workerd
    // drops unawaited telemetry on exactly this shape of path.
    exec.waitUntil(trackUserContactSafe(env, uid, "callrec_upload_begin", {
      call_id: callId, bytes: total, parts: 0, dedup: true, ok: true,
    }));
    return json({ ok: true, key, dedup: true, upload_id: null, part_size: PART_SIZE, parts: 0 });
  }

  const gate = await checkUploadAllowed(env, uid, total, false).catch(() => ({ ok: true as const }));
  if (!gate.ok) {
    exec.waitUntil(trackUserContactSafe(env, uid, "callrec_quota_blocked", { call_id: callId, bytes: total, stage: "begin" }));
    return quotaFullResponse();
  }

  try {
    const mp = await env.DIGITAL.createMultipartUpload(key, { httpMetadata: { contentType: mime } });
    // [CALLREC-TELEM-1] The chunked lane's OPENING event. Paired with
    // `callrec_finalized {transport:"chunked"}` it gives the drop-off rate for
    // large recordings: a begin with no matching finalize is an upload the user
    // started and never completed, which is invisible from either event alone.
    exec.waitUntil(trackUserContactSafe(env, uid, "callrec_upload_begin", {
      call_id: callId, bytes: total, parts: partCount, dedup: false, ok: true,
    }));
    return json({
      ok: true, key, upload_id: mp.uploadId, dedup: false,
      part_size: PART_SIZE, parts: partCount, max_parts: MAX_PARTS,
    });
  } catch (e) {
    exec.waitUntil(trackException(env, e, {
      uid, route: "/api/callrec/upload/begin", method: "POST", handled: true,
      extra: { call_id: callId, rec_id: clientIdFor(callId), bytes: total },
    }));
    exec.waitUntil(trackUserContactSafe(env, uid, "callrec_upload_begin", {
      call_id: callId, bytes: total, parts: partCount, dedup: false,
      ok: false, error: "begin_failed",
    }));
    return json({ error: "begin_failed" }, 500);
  }
}

// ---------------------------------------------------------------------------
// PUT /api/callrec/upload/part?key=&upload_id=&part_number= — ONE chunk, raw body.
//
// The body is streamed into R2 as-is: the isolate never holds more than one part,
// which is the entire reason this route exists.
// ---------------------------------------------------------------------------
export async function callRecUploadPart(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const uid = ctx.uid;

  const cfg = await readConfig(env);
  if (cfg.callRecordingEnabled !== true) return json({ error: "disabled", flag: "callRecordingEnabled" }, 403);

  const q = new URL(req.url).searchParams;
  const key = String(q.get("key") ?? "");
  const uploadId = String(q.get("upload_id") ?? "");
  const partNumber = Math.round(Number(q.get("part_number")) || 0);
  if (!ownsKey(uid, key)) return json({ error: "not_found", code: "upload_not_yours" }, 404);
  if (!uploadId) return json({ error: "upload_id required" }, 400);
  if (partNumber < 1 || partNumber > MAX_PARTS) return json({ error: "bad_part_number", max_parts: MAX_PARTS }, 400);

  const body = await req.arrayBuffer().catch(() => null);
  if (!body || body.byteLength === 0) return json({ error: "empty_part" }, 400);
  if (body.byteLength > PART_SIZE) {
    return json({ error: "part_too_large", code: "part_too_large", part_size: PART_SIZE }, 413);
  }

  try {
    const mp = env.DIGITAL.resumeMultipartUpload(key, uploadId);
    const part = await mp.uploadPart(partNumber, body);
    return json({ ok: true, part_number: part.partNumber, etag: part.etag });
  } catch (e) {
    // A dead/aborted upload_id lands here. Tell the client to restart at /begin
    // rather than retrying a part that can never succeed.
    exec.waitUntil(trackException(env, e, {
      uid, route: "/api/callrec/upload/part", method: "PUT", handled: true,
      extra: { part_number: partNumber, bytes: body.byteLength },
    }));
    // [CALLREC-TELEM-1] A named event as well as the exception: "which part
    // number do uploads die on" is a distribution question, and Error Tracking
    // cannot answer it. A cluster at part 1 is a dead upload_id; a cluster near
    // the end is a client giving up on a long file.
    exec.waitUntil(trackUserContactSafe(env, uid, "callrec_upload_part_failed", {
      part_number: partNumber, bytes: body.byteLength, code: "upload_expired",
    }));
    return json({ error: "part_failed", code: "upload_expired" }, 409);
  }
}

// ---------------------------------------------------------------------------
// POST /api/callrec/upload/complete — assemble, register, and run the SAME
// finalize logic the single-shot lane runs.
// ---------------------------------------------------------------------------
export async function callRecUploadComplete(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const uid = ctx.uid;

  const cfg = await readConfig(env);
  if (cfg.callRecordingEnabled !== true) return json({ error: "disabled", flag: "callRecordingEnabled" }, 403);

  const b = (await req.json().catch(() => ({}))) as RecordingMeta & {
    key?: string;
    upload_id?: string;
    parts?: Array<{ part_number?: number; partNumber?: number; etag?: string }>;
  };
  const meta = parseMeta(b);
  if (!meta.ok) return meta.resp;
  const { callId } = meta;

  const key = String(b.key ?? "");
  if (!ownsKey(uid, key)) return json({ error: "not_found", code: "upload_not_yours" }, 404);
  const uploadId = String(b.upload_id ?? "");

  // ── dedup branch: /begin said we already hold these bytes ──────────────────
  if (!uploadId) {
    const existing = await mediaSession(env)
      .prepare("SELECT id, size_bytes FROM user_media WHERE key=?1 AND uid=?2 AND deleted_at IS NULL LIMIT 1")
      .bind(key, uid).first<{ id: string; size_bytes: number }>()
      .catch(() => null);
    if (!existing) return json({ error: "upload_id required" }, 400);
    return finalizeRecording(env, exec, uid, meta, {
      mediaId: existing.id, key, bytes: Number(existing.size_bytes) || 0, mime: meta.mime, dedup: true,
    }, "/api/callrec/upload/complete", "chunked");
  }

  const parts = (Array.isArray(b.parts) ? b.parts : [])
    .map((p) => ({ partNumber: Math.round(Number(p?.part_number ?? p?.partNumber) || 0), etag: String(p?.etag ?? "") }))
    .filter((p) => p.partNumber >= 1 && p.partNumber <= MAX_PARTS && p.etag.length > 0)
    .sort((a, b2) => a.partNumber - b2.partNumber);
  if (!parts.length) return json({ error: "parts required" }, 400);

  let obj: R2Object;
  try {
    const mp = env.DIGITAL.resumeMultipartUpload(key, uploadId);
    obj = await mp.complete(parts);
  } catch (e) {
    exec.waitUntil(trackException(env, e, {
      uid, route: "/api/callrec/upload/complete", method: "POST", handled: true,
      extra: { call_id: callId, stage: "r2_complete", parts: parts.length },
    }));
    return json({ error: "complete_failed", code: "upload_expired" }, 409);
  }

  // The object's OWN size, never the client's claim — this number becomes the
  // user's storage bill.
  const bytes = Number(obj.size) || 0;
  let mediaId: string;
  try {
    mediaId = await registerPrivateObject(env, uid, key, bytes, meta.mime);
  } catch (e) {
    exec.waitUntil(trackException(env, e, {
      uid, route: "/api/callrec/upload/complete", method: "POST", handled: true,
      extra: { call_id: callId, stage: "register_row", bytes },
    }));
    // The R2 object exists but is unaccounted for. Deleting it would destroy the
    // only server copy of a recording the client believes it has uploaded; the
    // client retries, /begin finds no user_media row, and the same key is
    // rewritten — so leaving it is both safe and self-healing.
    return json({ error: "register_failed" }, 500);
  }

  exec.waitUntil(afterRegisterFile(env, uid, {
    kind: "call_recording", bytes, source_app: "avacall", dedup: false,
  }).catch(() => { /* best-effort — storage screens also refresh on open */ }));

  return finalizeRecording(env, exec, uid, meta, {
    mediaId, key, bytes, mime: meta.mime, dedup: false,
  }, "/api/callrec/upload/complete", "chunked");
}

// ---------------------------------------------------------------------------
// POST /api/callrec/upload/abort — throw the parts away.
// Idempotent by design: an already-gone upload answers ok, because the caller's
// goal ("this upload should not exist") is satisfied either way.
// ---------------------------------------------------------------------------
export async function callRecUploadAbort(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const uid = ctx.uid;

  const b = (await req.json().catch(() => ({}))) as { key?: string; upload_id?: string };
  const key = String(b.key ?? "");
  const uploadId = String(b.upload_id ?? "");
  if (!ownsKey(uid, key)) return json({ error: "not_found", code: "upload_not_yours" }, 404);
  if (!uploadId) return json({ error: "upload_id required" }, 400);

  try {
    await env.DIGITAL.resumeMultipartUpload(key, uploadId).abort();
  } catch (e) {
    exec.waitUntil(trackException(env, e, {
      uid, route: "/api/callrec/upload/abort", method: "POST", handled: true, extra: { stage: "r2_abort" },
    }));
  }
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// The ONE definition of "a recording is saved": Inbox card → push → telemetry →
// a fresh presign. Both lanes end here, so they cannot drift apart.
// ---------------------------------------------------------------------------
async function finalizeRecording(
  env: Env, exec: ExecutionContext, uid: string,
  meta: ParsedMeta, stored: StoredAudio, route: string, transport: "inline" | "chunked",
): Promise<Response> {
  const { callId, direction, startedAt, durationS, peerUid, peerName, peerKey } = meta;
  const conv = convFor(uid, peerKey);
  const clientId = clientIdFor(callId);

  // ── Inbox card ────────────────────────────────────────────────────────────
  // title/description START EMPTY. They are user-supplied (PATCH /meta) and are
  // never generated — there is no AI anywhere in this feature.
  const peerAvatar = meta.peerAvatar
    || (peerUid ? (await publicIdentityFor(env, peerUid).catch(() => null))?.avatar_url ?? "" : "");
  const envelope = JSON.stringify({
    t: "callrec", title: "", description: "",
    call_id: callId, started_at: startedAt, duration_s: durationS, bytes: stored.bytes,
    peer_uid: peerUid || null, peer_name: peerName || null, peer_avatar: peerAvatar || null,
    direction,
  });

  let appended = false;
  let appendStatus = 0;
  try {
    const res = await inboxFetch(env, uid, "https://inbox/append", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        conv, sender: peerKey, owner: uid, kind: "call_recording",
        body: envelope, media_ref: stored.key, scope: `to:${uid}`,
        client_id: clientId, created_at: startedAt,
      }),
    });
    appended = res.ok;
    appendStatus = res.status;
  } catch (e) {
    exec.waitUntil(trackException(env, e, {
      uid, route, method: "POST", handled: true,
      extra: { call_id: callId, rec_id: clientId, stage: "inbox_append" },
    }));
  }
  // [CALLREC-TELEM-1] The Inbox row is the RECORD OF TRUTH for this feature —
  // the push is only an accelerator — so an append that failed means the bytes
  // are safely in R2 and the user will never see them. That is the worst
  // silent outcome the server side has, and it previously produced only a
  // boolean riding on the success event (and nothing at all when the DO
  // answered a non-OK status without throwing, which is the more likely shape).
  if (!appended) {
    exec.waitUntil(trackUserContactSafe(env, uid, "callrec_inbox_append_failed", {
      call_id: callId, conv, status: appendStatus, transport,
      bytes: stored.bytes, media_id: stored.mediaId,
    }));
  }

  // Push is an accelerator — the InboxDO row is the record of truth. Mirrors
  // do/voicemail_stream_room.ts:298.
  exec.waitUntil((async () => {
    try {
      await env.Q_PUSH.send({
        kind: "notify", to: uid, fromName: peerName || "AvaTOK",
        title: "Call recording saved",
        body: peerName ? `Your call with ${peerName} was saved` : "Your call recording was saved",
        data: { type: "call_recording", conv, call_id: callId, peer_uid: peerUid || null },
      });
    } catch { /* best-effort */ }
  })());

  const playbackUrl = await presignDigitalReadUrl(env, stored.key).catch(() => null);

  // Telemetry carries the OWNER's email + phone so a future PostHog pull can find
  // this recording by either (CLAUDE.md per-session workflow), and `peer_uid` so
  // the other side of the conversation is retrievable too.
  //
  // [CALLREC-TELEM-1] The client emits its OWN `callrec_finalized` when the FILE
  // is written; this one fires when the SERVER has it. Same `call_id` / `rec_id`,
  // different `side` — a client finalize with no matching server finalize is a
  // recording that exists only on the phone, which is exactly the gap
  // `callrec_upload` is meant to close and the pair that proves whether it did.
  //
  // Emitted AFTER the presign so `presigned` is a real observation: a false here
  // means R2 S3 credentials or DIGITAL_BUCKET_NAME are unset, i.e. the recording
  // saved fine and is not downloadable — a config failure that otherwise only
  // shows up later as a 503 on playback.
  exec.waitUntil(trackUserContactSafe(env, uid, "callrec_finalized", {
    call_id: callId, side: "server", duration_s: durationS, bytes: stored.bytes,
    mime: stored.mime, direction, dedup: stored.dedup, appended, transport,
    peer_uid: peerUid || null, conv, media_id: stored.mediaId,
    presigned: !!playbackUrl,
  }));

  return json({
    ok: true, media_id: stored.mediaId, conv, client_id: clientId,
    playback_url: playbackUrl, dedup: stored.dedup, bytes: stored.bytes,
  });
}

// ---------------------------------------------------------------------------
// PATCH /api/callrec/meta — the ONLY writer of title/description.
// ---------------------------------------------------------------------------
export async function callRecMeta(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const uid = ctx.uid;

  const cfg = await readConfig(env);
  if (cfg.callRecordingEnabled !== true) return json({ error: "disabled", flag: "callRecordingEnabled" }, 403);

  const b = (await req.json().catch(() => ({}))) as { call_id?: string; title?: string; description?: string };
  const callId = String(b.call_id ?? "");
  if (!CALL_ID_RE.test(callId)) return json({ error: "call_id required" }, 400);
  if (b.title === undefined && b.description === undefined) return json({ error: "nothing to patch" }, 400);

  const title = b.title === undefined ? undefined : cleanText(String(b.title), MAX_TITLE);
  const description = b.description === undefined ? undefined : cleanText(String(b.description), MAX_DESCRIPTION);
  if (title === null || description === null) {
    return json({ error: "bad_text", code: "control_characters_rejected" }, 400);
  }

  // Ownership: we only ever address the AUTHENTICATED user's own InboxDO, so a
  // row for someone else's recording is simply not reachable from here.
  const row = await inboxRow(env, uid, clientIdFor(callId));
  if (!row) return json({ error: "not_found" }, 404);

  let env0: Record<string, unknown>;
  try { env0 = JSON.parse(String(row.body ?? "{}")) as Record<string, unknown>; } catch { env0 = {}; }
  if (env0.t !== "callrec") return json({ error: "not_found" }, 404); // never patch a non-recording row
  if (title !== undefined) env0.title = title;
  if (description !== undefined) env0.description = description;

  try {
    await inboxFetch(env, uid, "https://inbox/msg_body", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: clientIdFor(callId), body: JSON.stringify(env0) }),
    });
  } catch (e) {
    exec.waitUntil(trackException(env, e, {
      uid, route: "/api/callrec/meta", method: "PATCH", handled: true, extra: { call_id: callId },
    }));
    return json({ error: "patch_failed" }, 500);
  }

  exec.waitUntil(trackUserContactSafe(env, uid, "callrec_title_edited", {
    call_id: callId, source: "server",
    has_title: !!env0.title, has_description: !!env0.description,
    title_len: String(env0.title ?? "").length,
    description_len: String(env0.description ?? "").length,
  }));

  return json({ ok: true, call_id: callId, title: env0.title ?? "", description: env0.description ?? "" });
}

// ---------------------------------------------------------------------------
// POST /api/callrec/delete — soft-hide the card AND release the storage quota.
// ---------------------------------------------------------------------------
export async function callRecDelete(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const uid = ctx.uid;

  const cfg = await readConfig(env);
  if (cfg.callRecordingEnabled !== true) return json({ error: "disabled", flag: "callRecordingEnabled" }, 403);

  const b = (await req.json().catch(() => ({}))) as { call_id?: string };
  const callId = String(b.call_id ?? "");
  if (!CALL_ID_RE.test(callId)) return json({ error: "call_id required" }, 400);

  const row = await inboxRow(env, uid, clientIdFor(callId));
  if (!row) return json({ error: "not_found" }, 404);
  const r2Key = String(row.media_ref ?? "");
  const conv = String(row.conv ?? "");

  // Soft-delete the user_media row (same statement libraryDelete() uses), then
  // recompute — quota frees when the LAST reference to a key goes. The R2 object
  // itself is reaped by the existing erasure/account-deletion cascade, exactly as
  // for any other deleted library file. `uid=?2` is the ownership check.
  let released = false;
  if (r2Key) {
    try {
      const res = await mediaSession(env)
        .prepare("UPDATE user_media SET deleted_at=?3 WHERE key=?1 AND uid=?2 AND deleted_at IS NULL")
        .bind(r2Key, uid, Date.now()).run();
      released = ((res as { meta?: { changes?: number } }).meta?.changes ?? 0) > 0;
      exec.waitUntil(afterRegisterFile(env, uid).catch(() => { /* best-effort */ }));
    } catch (e) {
      exec.waitUntil(trackException(env, e, {
        uid, route: "/api/callrec/delete", method: "POST", handled: true,
        extra: { call_id: callId, stage: "media_delete" },
      }));
    }
  }

  // Soft-hide the Inbox card for the owner, on the owner's own InboxDO — identical
  // semantics to InboxApi.hideCard / POST /api/msg/hide (routes/messaging.ts).
  try {
    await inboxFetch(env, uid, "https://inbox/hide", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ conv, target: clientIdFor(callId), hidden: true }),
    });
  } catch (e) {
    exec.waitUntil(trackException(env, e, {
      uid, route: "/api/callrec/delete", method: "POST", handled: true,
      extra: { call_id: callId, stage: "inbox_hide" },
    }));
  }

  exec.waitUntil(trackUserContactSafe(env, uid, "callrec_deleted", {
    call_id: callId, surface: "server", quota_released: released,
    // Whether there was an R2 object to release at all. A delete with no key is
    // a row that never finished uploading, which is a different (and benign)
    // shape from one where the quota release itself failed.
    had_key: !!r2Key,
  }));

  return json({ ok: true, call_id: callId, quota_released: released });
}

// ---------------------------------------------------------------------------
// GET /api/callrec/playback?call_id= — a FRESH presign, every time.
// ---------------------------------------------------------------------------
export async function callRecPlayback(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const uid = ctx.uid;

  const cfg = await readConfig(env);
  if (cfg.callRecordingEnabled !== true) return json({ error: "disabled", flag: "callRecordingEnabled" }, 403);

  const callId = String(new URL(req.url).searchParams.get("call_id") || "");
  if (!CALL_ID_RE.test(callId)) return json({ error: "call_id required" }, 400);

  const row = await inboxRow(env, uid, clientIdFor(callId));
  if (!row) return json({ error: "not_found" }, 404);
  const r2Key = String(row.media_ref ?? "");
  // Belt-and-braces on top of "we only read this user's own InboxDO": the key's
  // own owner prefix must be this uid (the same owner-prefix idiom
  // voicemailRecording() uses), and the media row must still be live.
  if (!r2Key.startsWith(`u/${uid}/`)) return json({ error: "not_found" }, 404);
  const media = await mediaSession(env)
    .prepare("SELECT id FROM user_media WHERE key=?1 AND uid=?2 AND deleted_at IS NULL LIMIT 1")
    .bind(r2Key, uid).first<{ id: string }>()
    .catch(() => null);
  if (!media) return json({ error: "gone" }, 404);

  const url = await presignDigitalReadUrl(env, r2Key).catch(() => null);
  if (!url) {
    // presignDigitalReadUrl returns null (never throws) when R2 S3 credentials or
    // DIGITAL_BUCKET_NAME are unset — "not downloadable yet", not a crash.
    exec.waitUntil(trackException(env, new Error("presign_unavailable"), {
      uid, route: "/api/callrec/playback", method: "GET", handled: true, extra: { call_id: callId },
    }));
    return json({ error: "unavailable", code: "presign_unavailable" }, 503);
  }

  // `source: "presign"` — this route is ONLY reached when the client had no
  // local blob, so a high rate of it against `callrec_playback {source:"local"}`
  // on the client means on-device copies are being evicted (or the recording was
  // made on another of the user's devices), not that playback is broken.
  exec.waitUntil(trackUserContactSafe(env, uid, "callrec_playback", {
    call_id: callId, surface: "server", source: "presign", media_id: media.id,
  }));

  return json({ ok: true, call_id: callId, media_id: media.id, playback_url: url });
}

// ── helpers ────────────────────────────────────────────────────────────────

type ParsedMeta = {
  ok: true;
  callId: string;
  direction: "incoming" | "outgoing";
  startedAt: number;
  durationS: number;
  peerUid: string;
  peerName: string;
  peerAvatar: string;
  peerKey: string;
  mime: string;
};

/** Validate + normalise the metadata BOTH lanes send, so /finalize and
 *  /upload/complete cannot disagree about what a valid recording looks like. */
function parseMeta(b: RecordingMeta): ParsedMeta | { ok: false; resp: Response } {
  const callId = String(b.call_id ?? "");
  if (!CALL_ID_RE.test(callId)) return { ok: false, resp: json({ error: "call_id required" }, 400) };
  const direction = b.direction === "incoming" ? "incoming" : b.direction === "outgoing" ? "outgoing" : "";
  if (!direction) return { ok: false, resp: json({ error: "direction must be incoming|outgoing" }, 400) };
  const peerUid = b.peer_uid ? String(b.peer_uid).slice(0, 64) : "";
  const peerPhone = b.peer_phone ? normalizePhone(String(b.peer_phone)) : "";
  return {
    ok: true, callId, direction,
    startedAt: Number.isFinite(Number(b.started_at)) && Number(b.started_at) > 0 ? Math.round(Number(b.started_at)) : Date.now(),
    durationS: Math.max(0, Math.round(Number(b.duration_s) || 0)),
    peerUid,
    peerName: b.peer_name == null ? "" : String(b.peer_name).slice(0, 80),
    peerAvatar: b.peer_avatar ? String(b.peer_avatar).slice(0, 512) : "",
    peerKey: peerKeyOf(peerUid, peerPhone),
    mime: mimeOf(b.mime),
  };
}

/** registerArtifactMedia's own private-object scheme, reproduced so the chunked
 *  lane writes to the SAME address space (dedup, delete and playback all key off
 *  this shape). Changing it here without changing routes/media.ts silently splits
 *  the two lanes into different buckets of the same user's storage. */
function privateKeyFor(uid: string, sha256: string): string {
  return `u/${uid}/private/${sha256}`;
}

/** THE ownership check for every chunked-upload call. Because the key embeds the
 *  owner's uid, an upload_id minted for another user's key is unusable here —
 *  which is why no server-side session table is needed at all. */
function ownsKey(uid: string, key: string): boolean {
  return key.startsWith(`u/${uid}/private/`) && key.length > `u/${uid}/private/`.length && !key.includes("..");
}

/** The `user_media` row for an object that is ALREADY in R2.
 *
 *  registerArtifactMedia() cannot be reused for the chunked lane: it takes
 *  `bytes: Uint8Array` and hashes them, i.e. it requires the whole file in the
 *  isolate — the exact thing this issue exists to avoid. The INSERT below is a
 *  deliberate mirror of its `sensitivity:'private'` branch
 *  (routes/media.ts:250-265); keep the two in step if that row shape changes. */
async function registerPrivateObject(env: Env, uid: string, key: string, bytes: number, mime: string): Promise<string> {
  const mdb = mediaSession(env);
  const existing = await mdb.prepare("SELECT id FROM user_media WHERE key=?1 AND uid=?2 LIMIT 1")
    .bind(key, uid).first<{ id: string }>();
  if (existing) {
    // A retried complete, or a soft-deleted row for the same content: revive it
    // rather than creating a second row that would double-count the same object.
    await mdb.prepare("UPDATE user_media SET deleted_at=NULL, size_bytes=?3 WHERE key=?1 AND uid=?2")
      .bind(key, uid, bytes).run();
    return existing.id;
  }
  const id = crypto.randomUUID();
  const hash = key.slice(key.lastIndexOf("/") + 1);
  const fileName = `call-recording-${hash.slice(0, 8)}.${extOf(mime)}`;
  await mdb.prepare(
    `INSERT INTO user_media (id, uid, media_type, storage, visibility, encrypted, key, display_url, mime_type, size_bytes, original_app, created_at, moderation_status, category, file_name, source_kind)
     VALUES (?1,?2,'audio','digital','private',0,?3,'',?4,?5,'avacall',?6,'skipped','call_recording',?7,'sent')`,
  ).bind(id, uid, key, mime, bytes, Date.now(), fileName).run();
  return id;
}

/** The 413 both lanes must return, word for word — the client renders this
 *  message and keys its `storage_full` state off the code. */
function quotaFullResponse(): Response {
  return json({
    error: "quota_exceeded", code: "storage_full",
    message: "Your AvaStorage is full. Free some space or top up your wallet to keep this recording.",
  }, 413);
}

/** Contact-tagged telemetry that never throws — for use inside `waitUntil`.
 *
 *  [CALLREC-TELEM-1] Stamps `rec_id` automatically whenever `call_id` is present.
 *  `rec_id` is `callrec:<callId>` — byte-identical to [clientIdFor], to the Inbox
 *  row's `client_id`, and to the `rec_id` the CLIENT puts on every one of its own
 *  `callrec_*` events. That shared key is what lets one recording's whole
 *  lifecycle be replayed as a single funnel across client AND server, instead of
 *  two timelines someone has to join by hand at 2am.
 *
 *  Every call site is inside `exec.waitUntil(...)`: workerd DROPS unawaited
 *  telemetry on an early-return error path (CLAUDE.md), and every emit here is on
 *  a path that returns immediately afterwards. */
async function trackUserContactSafe(
  env: Env, uid: string, event: string, props: Record<string, unknown>,
): Promise<void> {
  try {
    const c = await contactFor(env, uid).catch(() => ({ email: null, phone: null }));
    const callId = props.call_id;
    const enriched = typeof callId === "string" && callId
      ? { rec_id: clientIdFor(callId), ...props }
      : props;
    await trackUserContact(env, uid, c.email, c.phone, event, "avacall", enriched);
  } catch { /* best-effort */ }
}

/** `callrec_<ownerUid>__<peerKey>` — one thread per (owner, peer). */
function convFor(ownerUid: string, peerKey: string): string {
  return `callrec_${ownerUid}__${peerKey}`;
}

/** Idempotency key for the Inbox row: a re-sent finalize dedups on this. */
function clientIdFor(callId: string): string {
  return `callrec:${callId}`;
}

/** An AvaTOK peer is their uid; a PSTN peer is `tel:<E.164>`. */
function peerKeyOf(peerUid: string, peerPhone: string): string {
  if (peerUid) return peerUid;
  if (peerPhone) return `tel:${peerPhone}`;
  return "unknown";
}

function inboxFetch(env: Env, uid: string, url: string, init: RequestInit): Promise<Response> {
  return env.INBOX.get(env.INBOX.idFromName(uid)).fetch(url, init);
}

type InboxRow = { conv?: string; body?: string; media_ref?: string; kind?: string; hidden?: number };

/** The owner's own row for this recording, or null. Reading the AUTHENTICATED
 *  user's InboxDO IS the ownership check — another user's row is unreachable. */
async function inboxRow(env: Env, uid: string, clientId: string): Promise<InboxRow | null> {
  try {
    const res = await inboxFetch(env, uid, `https://inbox/msg_body?client_id=${encodeURIComponent(clientId)}`, { method: "GET" });
    const j = (await res.json()) as { ok?: boolean; found?: boolean; row?: InboxRow };
    if (!j?.found || !j.row) return null;
    if (j.row.kind && j.row.kind !== "call_recording") return null;
    return j.row;
  } catch { return null; }
}

/** Trim, cap, and REJECT control characters (returns null) — a title lands in a
 *  JSON envelope other clients render verbatim. Tabs/newlines are stripped rather
 *  than rejected in a description so a pasted note doesn't fail the whole edit. */
function cleanText(raw: string, max: number): string | null {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(raw)) return null;
  return raw.replace(/[\t\r\n]+/g, " ").trim().slice(0, max);
}

function mimeOf(raw: unknown): string {
  const m = String(raw ?? "").trim().toLowerCase();
  if (m.startsWith("audio/")) return m.slice(0, 64);
  return "audio/mp4"; // the spec's format: AAC in .m4a
}

function extOf(mime: string): string {
  if (mime.includes("mpeg")) return "mp3";
  if (mime.includes("wav")) return "wav";
  if (mime.includes("aac")) return "aac";
  return "m4a";
}

// Self-contained, per this codebase's convention (do/voicemail_room.ts et al).
function b64decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
