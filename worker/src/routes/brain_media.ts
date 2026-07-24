// [AVABRAIN-MEDIA-1] (Bible §5, §9.2) — daily audio/video "remember this in
// AvaBrain" recordings. Distinct from AvaLibrary (/upload/public, routes/media.ts)
// and from DM voicemail (do/voicemail_room.ts + the `voicemail` brain domain):
// media_memory is a first-class recorder capture, its own consent key, its own
// state machine, its own cost controls.
//
// Four authenticated endpoints (Bible §9.2):
//   POST   /api/brain/media/prepare   — policy decision BEFORE the client uploads
//                                        bytes (caps, daily quota, dedup hint).
//   POST   /api/brain/media/complete  — the actual bytes land HERE (mirrors the
//                                        existing uploadPublic/uploadPrivate shape
//                                        in routes/media.ts: raw body + headers).
//                                        Idempotent by content hash; enqueues the
//                                        ONE brainIngest producer call for this domain.
//   GET    /api/brain/media/:id       — status/progress only (never derived content).
//   DELETE /api/brain/media/:id       — source + ALL derived rows (transcript,
//                                        vectors, facts) — an async job, mirroring
//                                        the §5.1 deletion contract's shape.
//
// Cost-control flags (Bible §5.3) are read directly off `env` with safe defaults
// and NOT added to routes/config.ts (out of this change's file ownership — see the
// report). Every flag is `(env as any).<name>` so this file compiles without a
// worker/src/types.ts edit; AVABRAIN-FLAGS-1 lands the real KV-backed flags.
import type { Env } from "../types";
import { json, sha256Hex } from "../util";
import { requireUser, isFail } from "../authz";
import { brainIngest } from "../lib/brain_ingest";
import { emailFor } from "../lib/identity";
import { trackUser, trackException } from "../hooks";

// ---- cost-control flags (Bible §5.3) — reported to AVABRAIN-FLAGS-1, not wired
// into config.ts by this change. Read via env with hard-coded safe fallbacks so a
// missing flag NEVER means "unlimited". ----
function flagBool(env: Env, name: string, def: boolean): boolean {
  const v = (env as unknown as Record<string, unknown>)[name];
  if (v === undefined || v === null) return def;
  if (typeof v === "boolean") return v;
  return String(v) === "1" || String(v).toLowerCase() === "true";
}
function flagNum(env: Env, name: string, def: number): number {
  const v = (env as unknown as Record<string, unknown>)[name];
  const n = Number(v);
  return v !== undefined && v !== null && Number.isFinite(n) && n > 0 ? n : def;
}

// mediaMemoryEnabled — SHIPS DARK (default false). Flip only after the AVABRAIN-
// FLAGS-1 agent has verified the flag round-trips through config.ts + KV (per the
// CLAUDE.md "prove it" rule — a flag config.ts doesn't declare is a fake flag).
function mediaMemoryEnabled(env: Env): boolean { return flagBool(env, "mediaMemoryEnabled", false); }
function maxSec(env: Env): number { return flagNum(env, "mediaMemoryMaxSec", 900); }        // 15 min
// NIT 12 (Opus review): default LOWERED from 64 MB (which mirrored the VIDPOL-2
// video cap) to 24 MB / 25165824 bytes — that ceiling matches transcribeVoice's
// hard Whisper limit in consumers/src/brain.ts (`if (buf.byteLength > 24_000_000)
// return ""`). At 64MB, an upload between 24-64MB passed /prepare and /complete's
// gates, then silently produced an EMPTY transcript in the consumer (a stage that
// looks identical to "recorded silence" — Bible §5.2 step 7's "never make a failed
// AI job look like a failed upload" was being violated by the flag default itself,
// not just missing error handling). Report to AVABRAIN-FLAGS-1: set
// mediaMemoryMaxBytes=25165824 as the KV default (or raise it only once the
// consumer chunks oversized recordings instead of hard-capping transcribeVoice).
function maxBytes(env: Env): number { return flagNum(env, "mediaMemoryMaxBytes", 25_165_824); }
function frameBudget(env: Env): number { return flagNum(env, "mediaMemoryFrameBudget", 20); }
function dailyPerUser(env: Env): number { return flagNum(env, "mediaMemoryDailyPerUser", 10); }
// Per-user concurrency bound (Bible §5.3 "queue concurrency per user"). Not in the
// bible's named-flag list but required by the task; small + conservative default.
function concurrencyPerUser(env: Env): number { return flagNum(env, "mediaMemoryConcurrency", 2); }

const KINDS = new Set(["audio", "video"]);
const ACTIVE_STATES = ["queued", "transcribing", "summarizing", "embedding"];

function startOfDayMs(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

// ── BLOCKER 2 fix (Opus review) ──────────────────────────────────────────────
// media_memory is account_private, but env.BLOBS (avatok-blobs) is the PUBLIC,
// world-servable bucket (blossom.avatok.ai serves it directly, no auth). Writing
// raw recording bytes there would make an account-private recording world-
// servable to anyone who guesses/derives the r2_key. No existing private R2
// binding fits without abuse: VERIFICATION is presigned-only for KYC docs,
// DIGITAL is OLX paid-download goods, BACKUP_R2 is the premium cross-device
// sync/image store — none is "generic account-private blob storage" and
// wrangler.toml is out of this change's file ownership anyway. Fix: encrypt
// the bytes with AES-256-GCM (WebCrypto, native to the Workers runtime) using a
// fresh random key+IV per item BEFORE the R2 put; the key/IV are stored in the
// brain_media row (key_b64/iv_b64), never returned by any endpoint, and used
// only server-side (this Worker + the brain consumer) to decrypt for
// transcription. content_hash is computed from the PLAINTEXT (below, before
// encryption) so dedup-by-hash still works across identical re-uploads.
function b64FromBytes(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}

async function encryptMediaBytes(plaintext: ArrayBuffer): Promise<{ ciphertext: ArrayBuffer; keyB64: string; ivB64: string }> {
  const keyBytes = crypto.getRandomValues(new Uint8Array(32)); // AES-256
  const iv = crypto.getRandomValues(new Uint8Array(12));       // 96-bit GCM nonce, never reused (fresh per item)
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return { ciphertext, keyB64: b64FromBytes(keyBytes), ivB64: b64FromBytes(iv) };
}

// ── SHOULD-FIX 5 (Opus review) ── consent pre-check BEFORE any bytes are
// written. brainIngest() also fails closed on consent, but by then the ciphertext
// is already sitting in R2; checking here first means a consent-off user never
// causes an R2 write at all (defense in depth, mirrors brainIngest's own
// consentAllows() — media_memory has no legacy alias keys, it's a new B0 key).
async function mediaMemoryConsentAllows(env: Env, uid: string): Promise<boolean> {
  try {
    const rs = await env.DB_BRAIN.prepare(
      "SELECT enabled FROM brain_consent WHERE uid=?1 AND capability IN ('master','media_memory')",
    ).bind(uid).all();
    for (const r of (rs.results ?? []) as Array<{ enabled: number }>) if (Number(r.enabled) === 0) return false;
    return true;
  } catch (e) {
    console.error("[brain-media] consent pre-check failed — dropping (fail-closed):", String(e));
    return false; // FAIL CLOSED — a consent-store outage must never allow a write
  }
}

async function trackMedia(env: Env, uid: string, event: string, props: Record<string, unknown>): Promise<void> {
  // trackUser stamps the raw email (Bible §10 — "every event must be pullable by
  // account"); emailFor is KV-cached so this is cheap on the hot path.
  try { await trackUser(env, uid, await emailFor(env, uid), event, "avabrain", props); } catch { /* best-effort */ }
}

interface MediaRow {
  id: string; uid: string; content_hash: string; kind: string; mime: string; r2_key: string;
  size_bytes: number; duration_sec: number | null; state: string; error: string | null;
  transcript_chars: number | null; frame_count: number | null; vector_count: number | null;
  created_at: number; updated_at: number; ready_at: number | null;
}

// ---- POST /api/brain/media/prepare ----
// Body: { contentHash, mime, sizeBytes, durationSec?, kind:'audio'|'video' }.
// Pure policy check — no bytes move here. Returns a decision the client must
// respect before it starts the upload (Bible §5.1 "never block the composer" —
// this call happens in the background AFTER the local bubble already renders).
export async function brainMediaPrepare(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const uid = ctx.uid;

  if (!mediaMemoryEnabled(env)) return json({ allowed: false, decision: "disabled" });

  const b = (await req.json().catch(() => ({}))) as {
    contentHash?: string; mime?: string; sizeBytes?: number; durationSec?: number; kind?: string;
  };
  const kind = String(b.kind || "").toLowerCase();
  if (!KINDS.has(kind)) return json({ error: "kind must be audio|video" }, 400);
  const sizeBytes = Number(b.sizeBytes || 0);
  const durationSec = b.durationSec != null ? Number(b.durationSec) : null;
  const contentHash = String(b.contentHash || "").toLowerCase();

  const capBytes = maxBytes(env);
  const capSec = maxSec(env);
  if (sizeBytes > capBytes) {
    return json({ allowed: false, decision: "too_large", max_bytes: capBytes });
  }
  if (durationSec != null && durationSec > capSec) {
    return json({ allowed: false, decision: "too_long", max_sec: capSec });
  }

  // Dedup hint (Bible §5.3 "audio transcription once per source hash"): if this
  // exact (uid, hash) already has a row, tell the client so it can skip the upload
  // entirely and just reference the existing id.
  if (contentHash) {
    try {
      const existing = await env.DB_BRAIN.prepare(
        "SELECT id, state FROM brain_media WHERE uid=?1 AND content_hash=?2",
      ).bind(uid, contentHash).first<{ id: string; state: string }>();
      if (existing) {
        return json({ allowed: true, decision: "duplicate", id: existing.id, state: existing.state });
      }
    } catch { /* table read best-effort — fall through to a fresh-upload decision */ }
  }

  // Daily cap (Bible §5.3 cost control — mediaMemoryDailyPerUser).
  try {
    const cutoff = startOfDayMs(Date.now());
    const row = await env.DB_BRAIN.prepare(
      "SELECT COUNT(*) AS n FROM brain_media WHERE uid=?1 AND created_at>=?2",
    ).bind(uid, cutoff).first<{ n: number }>();
    const used = Number(row?.n ?? 0);
    const cap = dailyPerUser(env);
    if (used >= cap) return json({ allowed: false, decision: "daily_cap_reached", used, cap });
  } catch { /* fail-open on the READ (not a consent/security gate) — a D1 hiccup
              shouldn't block a legitimate recording; the daily cap is a cost
              control, not a privacy boundary. */ }

  return json({
    allowed: true, decision: "ok",
    max_bytes: capBytes, max_sec: capSec,
    // Bytes land at POST /api/brain/media/complete (raw body + headers), mirroring
    // routes/media.ts uploadPublic. No separate signed URL — this Worker IS the
    // upload endpoint, same as every other media path in this repo.
    complete_url: "/api/brain/media/complete",
  });
}

// ---- POST /api/brain/media/complete ----
// Raw bytes in the body (mirrors uploadPublic). Metadata via headers:
//   x-kind: audio|video   x-mime: <mime>   x-duration-sec: <int>
// Idempotent: re-completing the SAME (uid, sha256(bytes)) returns the existing row
// instead of re-queuing processing (Bible §5.2/§5.3 "never process twice").
export async function brainMediaComplete(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
  void exec; // no longer used: NIT 10 removed the Q_MODERATION waitUntil (see below) — kept
             // in the signature so the (out-of-scope) index.ts call site needs no change.
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const uid = ctx.uid;
  if (!mediaMemoryEnabled(env)) return json({ error: "media_memory disabled" }, 403);

  const kind = (req.headers.get("x-kind") || "").toLowerCase();
  if (!KINDS.has(kind)) return json({ error: "x-kind header must be audio|video" }, 400);
  const mime = req.headers.get("x-mime") || (kind === "video" ? "video/mp4" : "audio/mp4");
  const durationSecHdr = req.headers.get("x-duration-sec");
  const durationSec = durationSecHdr != null ? Number(durationSecHdr) : null;

  const bytes = await req.arrayBuffer();
  if (!bytes.byteLength) return json({ error: "empty body" }, 400);

  const capBytes = maxBytes(env);
  if (bytes.byteLength > capBytes) return json({ error: "too_large", max_bytes: capBytes }, 413);
  if (durationSec != null && durationSec > maxSec(env)) return json({ error: "too_long", max_sec: maxSec(env) }, 413);

  // Content hash IS the dedup + idempotency key (Bible §5.3, §9.2). Computed
  // server-side from the actual bytes — never trust a client-declared hash for
  // dedup/idempotency (the client may send one in headers as a hint only; here we
  // verify against the real bytes so a mislabeled/malicious hash can't collide
  // another user's cache entry or skip processing).
  const contentHash = await sha256Hex(bytes);
  const now = Date.now();

  const mdb = env.DB_BRAIN;
  const existing = await mdb.prepare(
    "SELECT id, state FROM brain_media WHERE uid=?1 AND content_hash=?2",
  ).bind(uid, contentHash).first<{ id: string; state: string }>();

  if (existing) {
    // Idempotent completion: same bytes already known for this uid. Do NOT
    // re-enqueue — the state machine may already be mid-flight or done.
    await trackMedia(env, uid, "avabrain_memory_ingest_queued", {
      id: existing.id, kind, dedup_hit: true, size_bytes: bytes.byteLength,
    });
    return json({ id: existing.id, state: existing.state, deduped: true });
  }

  // SHOULD-FIX 3 (Opus review): /prepare's daily cap was advisory only — nothing
  // stopped a client from skipping straight to /complete. Re-check the SAME cap
  // here, AFTER the dedup short-circuit above (a re-upload of an existing hash
  // must never count twice against the daily quota) and BEFORE the insert. Same
  // decision shape as /prepare so the client can render one code path for both.
  {
    const cutoff = startOfDayMs(now);
    try {
      const capRow = await mdb.prepare(
        "SELECT COUNT(*) AS n FROM brain_media WHERE uid=?1 AND created_at>=?2",
      ).bind(uid, cutoff).first<{ n: number }>();
      const used = Number(capRow?.n ?? 0);
      const cap = dailyPerUser(env);
      if (used >= cap) {
        return json({ error: "daily_cap_reached", decision: "daily_cap_reached", used, cap }, 429);
      }
    } catch { /* fail-open on the READ — cost control, not a consent/security gate */ }
  }

  // SHOULD-FIX 5 (Opus review): check consent BEFORE any bytes are written, not
  // just after (brainIngest's own consentAllows() would otherwise be the first
  // gate, by which point the ciphertext is already in R2).
  if (!(await mediaMemoryConsentAllows(env, uid))) {
    await trackMedia(env, uid, "avabrain_memory_ingest_failed", { id: null, kind, reason: "no_consent", size_bytes: bytes.byteLength });
    return json({ error: "no_consent", reason: "no_consent" }, 403);
  }

  // Per-user concurrency bound (Bible §5.3): refuse a NEW job while too many are
  // already in flight rather than let an unbounded backlog pile up on one user.
  const activePh = ACTIVE_STATES.map((_, i) => `?${i + 2}`).join(",");
  const activeRow = await mdb.prepare(
    `SELECT COUNT(*) AS n FROM brain_media WHERE uid=?1 AND state IN (${activePh})`,
  ).bind(uid, ...ACTIVE_STATES).first<{ n: number }>();
  if (Number(activeRow?.n ?? 0) >= concurrencyPerUser(env)) {
    return json({ error: "too_many_pending", retry_after_sec: 30 }, 429);
  }

  const id = crypto.randomUUID();
  // Opus gate-1 re-review BLOCKER: the R2 key must be PER-ROW (id), NOT
  // content-addressed. Each /complete encrypts with its own fresh random key,
  // so two racing uploads of the same (uid, content_hash) would write DIFFERENT
  // ciphertexts to the SAME content-addressed key — and the UNIQUE-race loser's
  // best-effort BLOBS.delete below would then delete the WINNER's object (or
  // leave bytes the winner's stored key can't decrypt). Keying by row id makes
  // the loser's delete provably touch only its own object. Dedup is unaffected:
  // it happens at the DB layer (pre-put SELECT + UNIQUE(uid, content_hash)),
  // never via R2 key collision.
  const r2Key = `u/${uid}/media_memory/${id}`;

  // Malware/type/size checks (Bible §5.2 step 3) — cheap gate before any AI spend:
  // mime must actually match the declared kind family.
  if (kind === "audio" && !mime.startsWith("audio/")) return json({ error: "mime/kind mismatch" }, 400);
  if (kind === "video" && !mime.startsWith("video/")) return json({ error: "mime/kind mismatch" }, 400);

  // NIT 10 (Opus review): the Q_MODERATION queue is the image-scan pipeline
  // (perceptual hash + vision classifier expect an actual decodable image) —
  // sending it these bytes under type:'image' would either crash decoding a
  // non-image container or (post-encryption, below) scan opaque ciphertext it
  // can never classify. media_memory is account_private, not published/public
  // content (unlike every other Q_MODERATION producer), so it is deliberately
  // NOT run through that pipeline. Skipping, not silently mislabeling.

  let ciphertext: ArrayBuffer;
  let keyB64: string;
  let ivB64: string;
  try {
    const enc = await encryptMediaBytes(bytes);
    ciphertext = enc.ciphertext; keyB64 = enc.keyB64; ivB64 = enc.ivB64;
  } catch (e) {
    await trackException(env, e, { uid, route: "brain_media_complete", method: "POST", extra: { stage: "encrypt" } });
    return json({ error: "encryption failure" }, 500);
  }

  try {
    await env.BLOBS.put(r2Key, ciphertext, { httpMetadata: { contentType: "application/octet-stream" } });
    await mdb.prepare(
      `INSERT INTO brain_media (id, uid, content_hash, kind, mime, r2_key, size_bytes, duration_sec, key_b64, iv_b64, state, created_at, updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'queued',?11,?11)`,
    ).bind(id, uid, contentHash, kind, mime, r2Key, ciphertext.byteLength, durationSec, keyB64, ivB64, now).run();
  } catch (e) {
    // NIT 11 (Opus review): two concurrent /complete calls for the SAME (uid,
    // content_hash) both pass the "no existing row" SELECT above, then race the
    // INSERT — the loser previously got a generic 503 instead of the winning row.
    // The UNIQUE(uid, content_hash) constraint is the tell; on that specific
    // violation, look up the winner and return its row as a normal dedup 200
    // (same shape as the early dedup return above) rather than an error.
    const msgStr = String((e as any)?.message ?? e);
    if (/unique/i.test(msgStr) && /content_hash/i.test(msgStr)) {
      try { await env.BLOBS.delete(r2Key); } catch { /* best-effort — this loser's ciphertext is unused */ }
      const winner = await mdb.prepare(
        "SELECT id, state FROM brain_media WHERE uid=?1 AND content_hash=?2",
      ).bind(uid, contentHash).first<{ id: string; state: string }>().catch(() => null);
      if (winner) {
        await trackMedia(env, uid, "avabrain_memory_ingest_queued", { id: winner.id, kind, dedup_hit: true, size_bytes: bytes.byteLength, race: true });
        return json({ id: winner.id, state: winner.state, deduped: true });
      }
    }
    await trackException(env, e, { uid, route: "brain_media_complete", method: "POST" });
    // Best-effort cleanup: don't leave orphaned ciphertext if the D1 insert failed
    // after the R2 put landed.
    try { await env.BLOBS.delete(r2Key); } catch { /* best-effort */ }
    return json({ error: "storage failure" }, 503);
  }

  // The ONE brainIngest producer call for this domain (Bible §9.1 contract).
  // sourceId = contentHash so the idempotency key is derived from (uid, domain,
  // kind, sourceId) per the platform-wide contract — a redelivered queue message
  // for the SAME hash collapses to one processing run in the consumer.
  const result = await brainIngest(env, {
    uid, domain: "media_memory", kind: "media_uploaded", sourceId: contentHash,
    meta: { mediaId: id, contentHash, kind, mime, r2Key, sizeBytes: bytes.byteLength, durationSec },
    ts: now,
  });

  if (!result.ok) {
    // Consent off / queue error — the row stays 'queued' forever otherwise, which
    // would look like a stuck upload rather than an honest "not going to process".
    // Mark it failed immediately so GET /:id and the client don't wait forever.
    try {
      await mdb.prepare("UPDATE brain_media SET state='failed', error=?2, updated_at=?3 WHERE id=?1")
        .bind(id, result.reason || "ingest_rejected", now).run();
    } catch { /* best-effort */ }
    // SHOULD-FIX 5 (Opus review): a consent-rejected (or queue-failed) completion
    // otherwise orphans the ciphertext we just wrote — nothing will ever process
    // or clean it up. Best-effort delete now rather than leaving dead bytes.
    try { await env.BLOBS.delete(r2Key); } catch { /* best-effort */ }
    await trackMedia(env, uid, "avabrain_memory_ingest_failed", { id, kind, reason: result.reason ?? "unknown" });
    return json({ id, state: "failed", reason: result.reason ?? "ingest_rejected" });
  }

  await trackMedia(env, uid, "avabrain_memory_ingest_queued", {
    id, kind, dedup_hit: false, size_bytes: bytes.byteLength, duration_sec: durationSec,
  });
  return json({ id, state: "queued" });
}

// ---- GET /api/brain/media/:id ----
// Status/progress ONLY (Bible §9.2) — never the transcript/facts/derived content.
export async function brainMediaStatus(req: Request, env: Env, id: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const row = await env.DB_BRAIN.prepare(
    `SELECT id, uid, kind, state, error, size_bytes, duration_sec, transcript_chars, frame_count,
            vector_count, created_at, updated_at, ready_at
     FROM brain_media WHERE id=?1 AND uid=?2`,
  ).bind(id, ctx.uid).first<MediaRow>();
  if (!row) return json({ error: "not found" }, 404);
  return json({
    id: row.id, kind: row.kind, state: row.state, error: row.error ?? null,
    size_bytes: row.size_bytes, duration_sec: row.duration_sec,
    transcript_chars: row.transcript_chars ?? null, frame_count: row.frame_count ?? null,
    vector_count: row.vector_count ?? null,
    created_at: row.created_at, updated_at: row.updated_at, ready_at: row.ready_at ?? null,
  });
}

// ---- DELETE /api/brain/media/:id ----
// Source + ALL derived rows (transcript/vectors/facts) — an async job mirroring
// the §5.1 deletion contract's shape but scoped to ONE media item instead of the
// whole account. The consumer (consumers/src/brain.ts handleBrain, event_type
// 'media_delete') does the actual store-by-store wipe; this route only validates
// ownership, flips the row to 'deleted' (so it stops showing as processing) and
// enqueues the job. Idempotent: deleting an already-'deleted' row is a no-op 200.
export async function brainMediaDelete(req: Request, env: Env, id: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const uid = ctx.uid;
  const row = await env.DB_BRAIN.prepare(
    "SELECT id, uid, r2_key, state FROM brain_media WHERE id=?1 AND uid=?2",
  ).bind(id, uid).first<{ id: string; uid: string; r2_key: string; state: string }>();
  if (!row) return json({ error: "not found" }, 404);
  if (row.state === "deleted") return json({ ok: true, id, state: "deleted", already: true });

  const now = Date.now();
  try {
    await env.DB_BRAIN.prepare("UPDATE brain_media SET state='deleted', updated_at=?2 WHERE id=?1").bind(id, now).run();
  } catch (e) {
    await trackException(env, e, { uid, route: "brain_media_delete", method: "DELETE" });
    return json({ error: "delete failed" }, 503);
  }
  // Best-effort: drop the R2 bytes immediately (this endpoint IS the user asking
  // for the recording to go away — unlike the account-wide purge, which defers
  // orphaned-blob cleanup to the erasure queue, per-item delete is a direct ask).
  try { await env.BLOBS.delete(row.r2_key); } catch { /* best-effort */ }

  try {
    await env.Q_BRAIN.send({ uid, event_type: "media_delete", source_app: "media_memory", payload: { mediaId: id } });
  } catch { /* the row is already 'deleted'; a retry/cron can still finish the derived-data sweep */ }

  await trackMedia(env, uid, "avabrain_memory_deleted", { id });
  return json({ ok: true, id, state: "deleted" });
}
