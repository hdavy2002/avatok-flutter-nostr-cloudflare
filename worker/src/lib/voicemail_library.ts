// [RECEPT-LIB-1] Ava-receptionist voicemail → AvaLibrary.
//
// THE GAP THIS CLOSES. All three receptionist engines store the recording with
// a bare `env.BLOBS.put()` and then reference it from exactly two places: the
// InboxDO card and `receptionist_sessions.recording_url`. Nothing ever wrote a
// `user_media` row, so AvaLibrary — whose entire model is that table — had
// nothing to list. The client's "Ava Receptionist" audio folder has shipped
// since [LIB-AUDIO-SPLIT-1] and reported 0 for every user
// (app/lib/features/library/voicemail_tile.dart:31-40 says so in as many
// words). This module is the missing producer.
//
// THREE PROPERTIES THAT ARE NOT NEGOTIABLE
//  1. **The `receptionist/` key prefix is preserved byte-for-byte.** It is the
//     primary discriminator the shipped client classifies on
//     (voicemail_tile.dart:85 `k.startsWith('receptionist/')`) AND the address
//     the bespoke owner-authed playback endpoints already read. Nothing here
//     copies, re-hashes or re-keys the object — see
//     routes/media.ts:registerExistingObjectMedia for why registerArtifactMedia
//     could not be reused.
//  2. **Never fatal.** Every call site wraps this, and this wraps itself: a
//     failed library row is a missing convenience, a lost voicemail is a lost
//     message from a real caller. It returns null instead of throwing, always.
//  3. **Idempotent.** The key embeds the one-shot session id, and
//     registerExistingObjectMedia keys its dedup on (uid, key), so a DO retry
//     or a duplicate finalize can never produce a second library row.
//
// OWNERSHIP: the row belongs to `ownerUid` — the account whose receptionist
// TOOK the message. Never the caller. The caller is a name on the tile.
import type { Env } from "../types";
import { registerExistingObjectMedia } from "../routes/media";
import { readConfig } from "../routes/config";

// ---------------------------------------------------------------------------
// [RECEPT-PRIVBUCKET-1] WHERE A VOICEMAIL LIVES.
//
// THE DEFECT. Every engine used to `env.BLOBS.put(...)`. BLOBS is the PUBLIC
// bucket: wrangler.toml binds it to `avatok-blobs`, which is served by the
// custom domain in BLOSSOM_BASE_URL (https://blossom.avatok.ai) with NO auth of
// any kind. So `https://blossom.avatok.ai/receptionist/<uid>/<phone>/<sid>.wav`
// returned a stranger's recorded message to anyone who knew or guessed the
// path. The owner-authed playback endpoints were a locked front door on a
// building with no walls. These are recordings of real people leaving personal
// messages, so "unguessable path" is not access control — the same reasoning
// routes/media.ts already applies to plaintext voice notes.
//
// THE SHAPE OF THE FIX (deliberately NOT a data migration):
//   • WRITES go to `env.DIGITAL` — the PRIVATE bucket with no public host,
//     reachable only through the Worker or a short-lived SigV4 presign
//     (routes/media.ts presignDigitalReadUrl).
//   • READS try DIGITAL first, then fall back to BLOBS. Every recording ever
//     taken is already in BLOBS under a BARE key with no bucket discriminator
//     stored anywhere, so a fallback read is the only way they keep playing.
//     Nothing is moved and nothing is deleted — a bulk migration of live user
//     data is the owner's call, not ours.
//   • The `user_media` row records which bucket it landed in (storage column),
//     so AvaLibrary presigns the new private rows and keeps serving the stored
//     blossom URL for the old public ones.
// ---------------------------------------------------------------------------
export type VoicemailBucket = "digital" | "blossom";

/**
 * Store a voicemail/receptionist recording. PRIVATE by default.
 *
 * Never silently loses a caller's message: if the DIGITAL write fails for any
 * reason, this falls back to BLOBS and REPORTS that it did (`fellBack`) so the
 * caller can raise it in telemetry. Losing the message is the worse failure of
 * the two — but a silent fallback would quietly re-open the hole, so it is
 * loud. A BLOBS failure still throws, exactly as before this change.
 */
export async function putVoicemailRecording(
  env: Env,
  key: string,
  body: ArrayBuffer | Uint8Array,
  contentType = "audio/wav",
): Promise<{ bucket: VoicemailBucket; fellBack: boolean }> {
  // Kill switch. Declared in BOTH the PlatformConfig interface and DEFAULTS
  // (routes/config.ts) — a key missing from DEFAULTS is rejected by putConfig
  // and can never be flipped, i.e. a fake flag (CLAUDE.md).
  let wantPrivate = true;
  try {
    const cfg = await readConfig(env);
    if (cfg.voicemailPrivateBucket === false) wantPrivate = false;
  } catch {
    // Config unreadable → stay PRIVATE. The secure branch is the default,
    // never the fallback.
  }
  const digital = (env as { DIGITAL?: R2Bucket }).DIGITAL;
  if (wantPrivate && digital) {
    try {
      await digital.put(key, body, { httpMetadata: { contentType } });
      return { bucket: "digital", fellBack: false };
    } catch {
      // fall through to BLOBS — a stored-but-public message beats a lost one.
    }
  }
  await env.BLOBS.put(key, body, { httpMetadata: { contentType } });
  return { bucket: "blossom", fellBack: wantPrivate };
}

/**
 * Read a voicemail/receptionist recording by its bare R2 key, from whichever
 * bucket it actually lives in.
 *
 * DIGITAL first (new recordings), BLOBS second (every recording taken before
 * [RECEPT-PRIVBUCKET-1], and anything written during a DIGITAL outage). Bare
 * keys are unique across both buckets — they embed a uuid session/call id — so
 * "try both" cannot serve the wrong object. Returns null when neither has it;
 * never throws.
 *
 * ⚠️ THE BLOBS LEG IS PERMANENT. DO NOT REMOVE IT.
 *
 * OWNER DECISION 2026-08-07: pre-existing voicemails are NOT being migrated —
 * "leave old voicemails, we will work with the new voicemails". So the public
 * bucket keeps serving every historical recording FOREVER, and deleting this
 * fallback silently 404s all of them. This is no longer temporary scaffolding
 * awaiting a sweep; it is the permanent read path for pre-2026-08-07 audio.
 *
 * The accepted consequence, recorded so nobody rediscovers it as a surprise:
 * those historical objects remain fetchable at
 * https://blossom.avatok.ai/<key> by anyone who knows the path, with no auth.
 * The owner weighed that against an irreversible copy-then-delete over live
 * audio (where a half-migrated key is a caller's message lost for good) and
 * chose to leave them. Only NEW recordings are private.
 */
export async function getVoicemailRecording(
  env: Env, key: string,
): Promise<R2ObjectBody | null> {
  if (!key) return null;
  const digital = (env as { DIGITAL?: R2Bucket }).DIGITAL;
  if (digital) {
    try {
      const o = await digital.get(key);
      if (o) return o as R2ObjectBody;
    } catch { /* fall through to the legacy bucket */ }
  }
  try {
    return (await env.BLOBS.get(key)) as R2ObjectBody | null;
  } catch {
    return null;
  }
}

/** Belt-and-braces for the client matcher: the file name also contains the
 *  literal "voicemail" (voicemail_tile.dart also matches on that), so the item
 *  lands in the right folder even if a future key scheme drifts. */
export function voicemailFileName(
  callerName?: string | null, callerPhone?: string | null, at: number = Date.now(),
): string {
  const whoRaw = (callerName || "").trim() || (callerPhone || "").trim();
  // Filename-safe: strip path separators and anything that would need quoting
  // in a Content-Disposition. Empty → "Unknown".
  const who = whoRaw.replace(/[\\/:*?"<>|\x00-\x1f]/g, "").trim().slice(0, 40) || "Unknown";
  const d = new Date(at);
  const p2 = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}`;
  return `Voicemail from ${who} ${stamp}.wav`;
}

/**
 * Register an ALREADY-STORED receptionist recording into the owner's AvaLibrary.
 * Best-effort: returns null on any failure and never throws.
 *
 * @param key the exact R2 key the wav was PUT at (`receptionist/<uid>/<phone>/<sid>.wav`)
 */
export async function registerVoicemailInLibrary(
  env: Env,
  opts: {
    ownerUid: string;
    key: string;
    bytes: number;
    callerName?: string | null;
    callerPhone?: string | null;
    at?: number;
    /** [RECEPT-PRIVBUCKET-1] Which bucket putVoicemailRecording() actually used.
     *  Omitted ⇒ 'blossom', which is only correct for a pre-fix object. */
    bucket?: VoicemailBucket;
  },
): Promise<{ id: string; dedup: boolean } | null> {
  try {
    if (!opts.ownerUid || !opts.key || !(opts.bytes > 0)) return null;
    // Kill switch. Declared in BOTH the PlatformConfig interface and DEFAULTS
    // (routes/config.ts) — a key missing from DEFAULTS is rejected by putConfig
    // and can never be flipped, i.e. a fake flag (CLAUDE.md).
    const cfg = await readConfig(env);
    if (cfg.receptionistLibraryEnabled === false) return null;
    const r = await registerExistingObjectMedia(env, {
      uid: opts.ownerUid,
      key: opts.key,
      // [RECEPT-PRIVBUCKET-1] The engines now PUT into env.DIGITAL (private) and
      // tell us which bucket won, because a DIGITAL failure falls back to BLOBS.
      // 'digital' rows store display_url='' and getLibrary() re-mints a
      // short-lived presign on every read; 'blossom' rows keep the public URL,
      // which is the truth for every recording taken before this change.
      bucket: opts.bucket || "blossom",
      mimeType: "audio/wav",
      sizeBytes: opts.bytes,
      fileName: voicemailFileName(opts.callerName, opts.callerPhone, opts.at),
      // category:'audio' is what AvaLibrary's audio bucket queries; the
      // Receptionist folder is then narrowed client-side off the key prefix.
      category: "audio",
      // original_app stays "avatok" deliberately: a novel app id would spawn a
      // stray app node in /api/library/tree, and the client does NOT need it —
      // the key prefix already classifies the row. (voicemail_tile.dart accepts
      // 'avarecept'/'receptionist' too; that path is simply not required.)
      app: "avatok",
      // The owner RECEIVED this message; the tile's incoming/outgoing flag is
      // `sourceKind != 'received'` (voicemail_tile.dart:198).
      sourceKind: "received",
      visibility: "private",
    });
    return { id: r.id, dedup: r.dedup };
  } catch {
    return null; // property 2 — never fatal
  }
}
