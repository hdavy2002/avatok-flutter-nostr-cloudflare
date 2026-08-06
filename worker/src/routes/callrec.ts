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
//   POST  /api/callrec/finalize   upload + Inbox card
//   PATCH /api/callrec/meta       user-supplied title/description, patched in place
//   POST  /api/callrec/delete     soft-hide the card + release the storage quota
//   GET   /api/callrec/playback   a freshly presigned read URL
import type { Env } from "../types";
import { json, normalizePhone } from "../util";
import { requireUser, isFail } from "../authz";
import { readConfig } from "./config";
import { registerArtifactMedia, presignDigitalReadUrl } from "./media";
import { mediaSession } from "../db/shard";
import { afterRegisterFile } from "../storage";
import { trackException, trackUserContact } from "../hooks";
import { contactFor, publicIdentityFor } from "../lib/identity";

// A single-shot JSON POST is the v1 transport. base64 inflates by 4/3, so this cap
// is on the DECODED bytes and is deliberately well inside the Workers request-body
// limit. At the spec's ~11 MB/hour mono AAC this is ~6 hours of call. The resumable
// path (§5.1, `upload_id`) is NOT built yet and reports itself as such rather than
// silently truncating a long recording.
const MAX_AUDIO_BYTES = 64 * 1024 * 1024;
const MAX_TITLE = 120;
const MAX_DESCRIPTION = 2000;
const CALL_ID_RE = /^[A-Za-z0-9_:.-]{1,64}$/;

type FinalizeBody = {
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
  audio_b64?: string;
  upload_id?: string;
};

// ---------------------------------------------------------------------------
// POST /api/callrec/finalize
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
  const callId = String(b.call_id ?? "");
  if (!CALL_ID_RE.test(callId)) return json({ error: "call_id required" }, 400);
  const direction = b.direction === "incoming" ? "incoming" : b.direction === "outgoing" ? "outgoing" : "";
  if (!direction) return json({ error: "direction must be incoming|outgoing" }, 400);

  // The resumable/chunked lane the spec asks for on long files. Declared in the
  // contract so the client can feature-detect; answered honestly until it exists.
  if (!b.audio_b64 && b.upload_id) {
    return json({ error: "not_implemented", code: "resumable_upload_unavailable" }, 501);
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
      message: "That recording is too long to upload in one piece.",
    }, 413);
  }

  const mime = mimeOf(b.mime);
  const startedAt = Number.isFinite(Number(b.started_at)) && Number(b.started_at) > 0 ? Math.round(Number(b.started_at)) : Date.now();
  const durationS = Math.max(0, Math.round(Number(b.duration_s) || 0));
  const peerUid = b.peer_uid ? String(b.peer_uid).slice(0, 64) : "";
  const peerPhone = b.peer_phone ? normalizePhone(String(b.peer_phone)) : "";
  const peerName = b.peer_name == null ? "" : String(b.peer_name).slice(0, 80);
  const peerKey = peerKeyOf(peerUid, peerPhone);
  const conv = convFor(uid, peerKey);
  const clientId = clientIdFor(callId);

  // ── storage ───────────────────────────────────────────────────────────────
  // sensitivity:'private' → DIGITAL bucket + presigned reads. category
  // 'call_recording' gives recordings their own bar in the AvaStorage graph.
  let reg;
  try {
    reg = await registerArtifactMedia(env, {
      uid, bytes: audio, mimeType: mime,
      filePrefix: "call-recording", fileExt: extOf(mime),
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
    if (quota) {
      return json({
        error: "quota_exceeded", code: "storage_full",
        message: "Your AvaStorage is full. Free some space or top up your wallet to keep this recording.",
      }, 413);
    }
    return json({ error: "register_failed" }, 500);
  }

  // ── Inbox card ────────────────────────────────────────────────────────────
  // title/description START EMPTY. They are user-supplied (PATCH /meta) and are
  // never generated — there is no AI anywhere in this feature.
  const peerAvatar = b.peer_avatar
    ? String(b.peer_avatar).slice(0, 512)
    : (peerUid ? (await publicIdentityFor(env, peerUid).catch(() => null))?.avatar_url ?? "" : "");
  const envelope = JSON.stringify({
    t: "callrec", title: "", description: "",
    call_id: callId, started_at: startedAt, duration_s: durationS, bytes: audio.byteLength,
    peer_uid: peerUid || null, peer_name: peerName || null, peer_avatar: peerAvatar || null,
    direction,
  });

  let appended = false;
  try {
    const res = await inboxFetch(env, uid, "https://inbox/append", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        conv, sender: peerKey, owner: uid, kind: "call_recording",
        body: envelope, media_ref: reg.key, scope: `to:${uid}`,
        client_id: clientId, created_at: startedAt,
      }),
    });
    appended = res.ok;
  } catch (e) {
    exec.waitUntil(trackException(env, e, {
      uid, route: "/api/callrec/finalize", method: "POST", handled: true,
      extra: { call_id: callId, stage: "inbox_append" },
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

  // Telemetry carries the OWNER's email + phone so a future PostHog pull can find
  // this recording by either (CLAUDE.md per-session workflow).
  exec.waitUntil((async () => {
    const c = await contactFor(env, uid).catch(() => ({ email: null, phone: null }));
    await trackUserContact(env, uid, c.email, c.phone, "callrec_finalized", "avacall", {
      call_id: callId, duration_s: durationS, bytes: audio.byteLength, mime,
      direction, dedup: reg.dedup, appended, peer_uid: peerUid || null,
    }).catch(() => { /* best-effort */ });
  })());

  const playbackUrl = await presignDigitalReadUrl(env, reg.key).catch(() => null);
  return json({ ok: true, media_id: reg.id, conv, client_id: clientId, playback_url: playbackUrl, dedup: reg.dedup });
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

  exec.waitUntil((async () => {
    const c = await contactFor(env, uid).catch(() => ({ email: null, phone: null }));
    await trackUserContact(env, uid, c.email, c.phone, "callrec_title_edited", "avacall", {
      call_id: callId, has_title: !!env0.title, has_description: !!env0.description,
    }).catch(() => { /* best-effort */ });
  })());

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

  exec.waitUntil((async () => {
    const c = await contactFor(env, uid).catch(() => ({ email: null, phone: null }));
    await trackUserContact(env, uid, c.email, c.phone, "callrec_deleted", "avacall", {
      call_id: callId, quota_released: released,
    }).catch(() => { /* best-effort */ });
  })());

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

  exec.waitUntil((async () => {
    const c = await contactFor(env, uid).catch(() => ({ email: null, phone: null }));
    await trackUserContact(env, uid, c.email, c.phone, "callrec_playback", "avacall", { call_id: callId })
      .catch(() => { /* best-effort */ });
  })());

  return json({ ok: true, call_id: callId, media_id: media.id, playback_url: url });
}

// ── helpers ────────────────────────────────────────────────────────────────

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
