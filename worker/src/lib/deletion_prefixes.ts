// [DEL-VOICEMAIL-R2-1] R2 key prefixes an account deletion must erase.
//
// Lives in lib/ rather than inside workflows/deletion.ts for ONE reason: it is
// the piece that most needs a unit test, and deletion.ts cannot be imported by
// vitest (it extends WorkflowEntrypoint from `cloudflare:workers`, a module
// that only exists inside the workerd runtime). Same shape as
// lib/call_room_auth.ts — pure, no I/O, no env.
//
// ---------------------------------------------------------------------------
// THE DEFECT THIS EXISTS TO FIX. The deletion cascade wiped the R2 prefix
// `u/<uid>/` and nothing else, but NO voicemail has ever been stored under
// `u/`. The receptionist engines and both PSTN voicemail paths use their own
// top-level prefixes, so every recording SURVIVED account deletion
// indefinitely — recordings of THIRD PARTIES leaving personal messages,
// retained after the account owner asked to be erased.
//
//   receptionist/<uid>/<phoneKey>/<sid>.wav
//     - do/reception_room_cf.ts:1282    (Cloudflare receptionist)
//     - do/reception_room.ts:1208       (Gemini receptionist)
//     - do/vobiz_agent_room.ts:1232     (vobiz agent)
//     …and routes/receptionist.ts:2150 puts the owner's own receptionist
//     knowledge-base uploads at `receptionist/<uid>/kb/<fid>/<name>`, which the
//     same prefix sweeps up (also this account's own data).
//
//   voicemail/<uid>/<callerKey>/<callId>.{wav,mp3}
//     - routes/pstn.ts:821              (.wav, DID/PSTN voicemail)
//     - do/voicemail_stream_room.ts:249 (.mp3, streaming PSTN voicemail)
//     - do/voicemail_room.ts:257        (.wav, currently unreachable)
//   Note the two extensions: the sweep is by PREFIX precisely so a codec change
//   cannot leave a file behind.
//
// TWO BUCKETS, NOT ONE (the caller's job, see workflows/deletion.ts).
// [RECEPT-PRIVBUCKET-1] (lib/voicemail_library.ts, 2026-08-07) moved WRITES
// from the public `env.BLOBS` to the private `env.DIGITAL` and made READS fall
// back DIGITAL→BLOBS. NO historical object was moved. So a recording is in
// DIGITAL (written from that day) *or* BLOBS (everything before it, plus
// anything written while DIGITAL was failing — putVoicemailRecording falls back
// to BLOBS rather than lose a caller's message). Sweeping one bucket leaves
// data behind, which is the whole bug.
//
// NOT COVERED, deliberately:
//   - `tts-cache/voicemail/<sha>.pcm` (do/voicemail_room.ts:180) — a
//     content-hashed cache of AVA's OWN synthesised prompts, shared across all
//     users. No caller audio and no uid in the key; it cannot be deleted per
//     account, and deleting it wholesale would hit other accounts.
//   - `pstn_orphan/<callUuid>.wav` (routes/pstn.ts:794) — written on the path
//     where the session could NOT be attributed to any owner. There is no uid
//     in the key or the record, so it cannot be tied to this account.
// ---------------------------------------------------------------------------

/**
 * Characters a uid may contain before it is spliced into a destructive R2 key
 * prefix. Real uids are Clerk ids (`user_2…`), npubs (`npub1…`) or
 * `guest:<uuid>` (routes/ladder.ts:112).
 *
 * THIS IS A BLAST-RADIUS GUARD, not input validation. The caller deletes EVERY
 * key under the prefix it is handed, so an empty uid would yield
 * `receptionist/` — i.e. every user on the platform — and a uid containing `/`
 * could climb into a sibling account's path. Anything not matching is REFUSED
 * outright rather than sanitised: a uid we do not recognise is a uid we must
 * not build a destructive prefix from.
 */
export const UID_R2_SAFE = /^[A-Za-z0-9_.:+-]{4,128}$/;

/**
 * The R2 key prefixes holding one account's voicemail / receptionist audio.
 *
 * Returns `[]` — meaning "delete NOTHING" — for any uid that is empty or not
 * key-safe. Every returned prefix ends in `/` so `voicemail/user_2ab` can never
 * match another account's `voicemail/user_2abcDEF/…`.
 */
export function voicemailR2Prefixes(uid: string): string[] {
  if (!uid || !UID_R2_SAFE.test(uid)) return [];
  return [`receptionist/${uid}/`, `voicemail/${uid}/`];
}
