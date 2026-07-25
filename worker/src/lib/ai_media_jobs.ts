// [AVA-MEDIA-JOB-1] Canonical server job/state-machine for durable AI media
// jobs (image generation, document summarize/translate, audio transcribe/
// translate). Specs/ROOT-CAUSE-REPORT-RECURRING-ISSUES-2026-07-25.md
// Part VI §36-42 (media-jobs diagnosis/contract), Part VII §43 item 1, §48.
//
// SCOPE OF THIS WAVE ([AVA-MEDIA-JOB-1] only): the job/message state machine,
// D1 schema, HTTP surface (routes/ai_media_jobs.ts) and queue plumbing
// (queues/ai_media.ts). The actual per-kind provider pipelines (image
// generation, PDF summarize/translate, audio STT/translate) are migrated
// onto this backbone by the FOLLOW-ON issues named in queues/ai_media.ts's
// KIND_HANDLERS ([AVA-IMAGE-UX-1] / [AVA-DOC-ARTIFACT-1] /
// [AVA-AUDIO-ARTIFACT-1] — §50 items 2-4). Until then, every created job is
// claimed and fails cleanly with error_code NOT_IMPLEMENTED, releasing its
// wallet reservation — it never charges and never hangs.
//
// BILLING (§48): this file NEVER decides a price and NEVER touches WalletDO
// directly. Every reservation/settlement/release goes through
// worker/src/lib/ai_billing.ts's canonical reserveAiJob()/settleAiJob()/
// releaseAiJob() (owned by [AI-WALLET-SPENDABLE-2] — do not duplicate that
// logic here). Media capabilities are NEVER free (§42/§48) — none of the
// CAPABILITY_BY_KIND values below are in ai_billing.ts's FREE_CAPABILITIES
// set, so every createAiMediaJob() call reserves (subject to the global
// aiWalletMeteringEnabled flag, exactly like every other reserveAiJob caller).
//
// PRIVACY (§41/§42): this table (and its queue messages, queues/ai_media.ts)
// NEVER stores provider prompts, file contents, transcripts, captions,
// intimate labels or raw media URLs — only ids, kind, status, a short display
// label, a target-language code, and safe billing linkage.
//
// D1 BINDING: DB_MEDIA (avatok-media-meta) — the SAME database as
// `user_media` (worker/migrations/media.sql), so artifact rows reference
// source/derived media without a cross-database query. See
// worker/migrations/2026-07-25-ai-media-jobs.sql.
import type { Env } from "../types";
import {
  reserveAiJob, settleAiJob, releaseAiJob,
  type AiModality, type UsageUnits, type ReserveAiJobResult,
} from "./ai_billing";
import { track, trackException } from "../hooks";
// [B3 fix] Private-artifact URL minting reuses the SAME presign helper the
// upload path uses (worker/src/routes/media.ts) — one place decides how a
// DIGITAL-bucket object becomes a fetchable URL. `lib/` importing a helper
// from `routes/` is an established pattern in this codebase (lib/ai_billing.ts
// already imports readConfig/walletOp from routes/config.ts, routes/wallet.ts).
import { presignDigitalReadUrl } from "../routes/media";

export type AiMediaJobKind =
  | "image_generate"
  | "doc_summarize"
  | "doc_translate"
  | "audio_transcribe"
  | "audio_translate";

export type AiMediaJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface AiMediaJobRecord {
  job_id: string;
  owner_uid: string;
  conv_id: string;
  source_media_id: string | null;
  kind: AiMediaJobKind;
  status: AiMediaJobStatus;
  label: string | null;
  progress: number;
  target_language: string | null;
  artifact_media_id: string | null;
  /** [AVA-MEDIA-JOB-2] Computed, NEVER persisted — resolved fresh on every
   *  read from the artifact's user_media row (resolveArtifactUrl below): a
   *  stable public CDN URL for a public artifact, or a short-lived (15 min)
   *  presigned URL for a private one. null until status='succeeded'. THE
   *  CONTRACT the other agents (M2/M3/M4) code against: this is the ONLY
   *  field they need to open/download/share a completed job's result — no
   *  second lookup, and it is always the correctly-scoped URL for that
   *  artifact's sensitivity. */
  artifact_url: string | null;
  error_code: string | null;
  reservation_id: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

const VALID_KINDS = new Set<AiMediaJobKind>([
  "image_generate", "doc_summarize", "doc_translate", "audio_transcribe", "audio_translate",
]);

// ---------------------------------------------------------------------------
// Capability/modality/model routing per kind — the single place that decides
// which ai_billing.ts price-catalog lane a job kind bills against at RESERVE
// time. Never one of ai_billing.ts's FREE_CAPABILITIES ("chat_ava",
// "chat_thread") — see file header.
// ---------------------------------------------------------------------------
const CAPABILITY_BY_KIND: Record<AiMediaJobKind, string> = {
  image_generate: "media_image_generate",
  doc_summarize: "media_doc_summarize",
  doc_translate: "media_doc_translate",
  audio_transcribe: "media_audio_transcribe",
  audio_translate: "media_audio_translate",
};
export const MODALITY_BY_KIND: Record<AiMediaJobKind, AiModality> = {
  image_generate: "image",
  doc_summarize: "text",
  doc_translate: "text",
  audio_transcribe: "audio",
  audio_translate: "audio",
};
// Representative RESERVE-time model per kind (Part II §11c catalog). The
// ACTUAL model used is read from the provider call site at settle time
// (settlement.modelActual) — this is only the reserve-time sizing lookup.
export const MODEL_BY_KIND: Record<AiMediaJobKind, string> = {
  image_generate: "openai/gpt-5-image-mini",
  doc_summarize: "mistralai/mistral-nemo",
  doc_translate: "mistralai/mistral-nemo",
  audio_transcribe: "openai/whisper-large-v3",
  audio_translate: "openai/whisper-large-v3",
};

export interface AiMediaJobEstimate {
  maxInputTokens?: number;
  maxOutputTokens?: number;
  images?: number;
  avSeconds?: number;
}

// Conservative RESERVE-time defaults per kind, used when the caller doesn't
// supply its own estimate (e.g. doesn't yet know a doc's page count). §66:
// image generation over-reserves deliberately — ai_billing.ts's own
// IMAGE_OUTPUT_TOKEN_RESERVE_CEILING is applied on top of `images` when
// modality==='image', and unused headroom is refunded automatically at
// settle, never eaten as under-reserved platform loss.
const DEFAULT_ESTIMATE: Record<AiMediaJobKind, AiMediaJobEstimate> = {
  image_generate: { maxInputTokens: 200, maxOutputTokens: 0, images: 1 },
  doc_summarize: { maxInputTokens: 40_000, maxOutputTokens: 1_500 },
  doc_translate: { maxInputTokens: 40_000, maxOutputTokens: 40_000 },
  audio_transcribe: { maxInputTokens: 0, maxOutputTokens: 4_000, avSeconds: 600 },
  audio_translate: { maxInputTokens: 0, maxOutputTokens: 6_000, avSeconds: 600 },
};

// Hard ceilings on a CALLER-supplied estimate override, so a client can never
// force an unbounded reservation.
const MAX_TOKENS_CEILING = 300_000;
const MAX_IMAGES_CEILING = 4;
const MAX_AV_SECONDS_CEILING = 4 * 3600; // 4 hours

function clampEstimate(kind: AiMediaJobKind, e?: AiMediaJobEstimate): { inputTokens: number; outputTokens: number; images?: number; avSeconds?: number } {
  const d = DEFAULT_ESTIMATE[kind];
  const inputTokens = Math.max(0, Math.min(MAX_TOKENS_CEILING, Math.trunc(e?.maxInputTokens ?? d.maxInputTokens ?? 0)));
  const outputTokens = Math.max(0, Math.min(MAX_TOKENS_CEILING, Math.trunc(e?.maxOutputTokens ?? d.maxOutputTokens ?? 0)));
  const images = d.images != null || e?.images != null
    ? Math.max(0, Math.min(MAX_IMAGES_CEILING, Math.trunc(e?.images ?? d.images ?? 0)))
    : undefined;
  const avSeconds = d.avSeconds != null || e?.avSeconds != null
    ? Math.max(0, Math.min(MAX_AV_SECONDS_CEILING, Math.trunc(e?.avSeconds ?? d.avSeconds ?? 0)))
    : undefined;
  return { inputTokens, outputTokens, images, avSeconds };
}

function now(): number { return Date.now(); }

function rowToRecord(r: any): AiMediaJobRecord {
  return {
    job_id: r.job_id, owner_uid: r.owner_uid, conv_id: r.conv_id,
    source_media_id: r.source_media_id ?? null, kind: r.kind, status: r.status,
    label: r.label ?? null, progress: Number(r.progress ?? 0),
    target_language: r.target_language ?? null,
    artifact_media_id: r.artifact_media_id ?? null,
    artifact_url: null, // computed below in fetchJob — never read from the row
    error_code: r.error_code ?? null,
    reservation_id: r.reservation_id ?? null,
    created_at: Number(r.created_at), updated_at: Number(r.updated_at),
    completed_at: r.completed_at != null ? Number(r.completed_at) : null,
  };
}

async function fetchJob(env: Env, jobId: string): Promise<AiMediaJobRecord | null> {
  const r = await env.DB_MEDIA.prepare("SELECT * FROM ai_media_jobs WHERE job_id=?1").bind(jobId).first<any>();
  if (!r) return null;
  const record = rowToRecord(r);
  record.artifact_url = await resolveArtifactUrl(env, record.artifact_media_id);
  return record;
}

// [AVA-MEDIA-JOB-2 / B3] The contract's artifact_url, resolved fresh on every
// read (never persisted — a stored presigned URL would go stale). No-ops
// (returns null, no DB hit) until a job has an artifact. Fail-closed: any
// lookup error returns null rather than a broken/wrong URL.
async function resolveArtifactUrl(env: Env, artifactMediaId: string | null): Promise<string | null> {
  if (!artifactMediaId) return null;
  try {
    const row = await env.DB_MEDIA.prepare(
      "SELECT key, visibility, storage FROM user_media WHERE id=?1",
    ).bind(artifactMediaId).first<{ key: string; visibility: string; storage: string }>();
    if (!row) return null;
    if (row.storage === "digital" || row.visibility === "private") {
      return await presignDigitalReadUrl(env, row.key);
    }
    return `${env.BLOSSOM_BASE_URL}/${row.key}`;
  } catch (e) {
    void trackException(env, e, { route: "ai_media_jobs.resolveArtifactUrl", handled: true, extra: { artifact_media_id: artifactMediaId } });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Source-media resolution + authorization — read-only checks against
// EXISTING tables (DB_META conversation_members, DB_MEDIA user_media). No
// schema changes to either. Fail CLOSED (deny) on any read error — these
// gate a paid action.
//
// B1 FIX: an earlier attempt at this file (parked on wave3-media-ux-parked,
// blocked in review) resolved `sourceMediaId` ONLY as `user_media.id` (a
// crypto.randomUUID()). The client's ChatMedia.id
// (app/lib/features/avatok/media.dart:29) is documented as "sha256 of
// ciphertext (R2 key)" — the HASH TAIL of user_media.key
// (`u/<uid>/<public|dm|private>/<hash>`, worker/src/routes/media.ts's
// userKey()), NOT user_media.id. Every client-created job 404'd
// (source_media_not_found). findSourceMediaRows() below tries the UUID
// primary-key lookup FIRST, then falls back to a key-suffix match against the
// SAME indexed `key` column (idx_media_key, worker/migrations/media.sql) —
// one indexed-then-fallback lookup, either identifier form resolves.
//
// EARLIER FIX (superseded, kept for history): an earlier attempt gated with
// `row.uid === requesterUid` — but a PDF/voice note someone SENT you is
// owned (user_media.uid) by the SENDER, so "summarize the document I
// received" / "transcribe their voice note" both 403'd. That version of
// authorizeSourceMedia() authorized on raw CONVERSATION MEMBERSHIP instead —
// the media row's owner only had to be a fellow member of the conversation
// the job is being created in, with no check the media was ever sent IN that
// conversation. The 2026-07-25 security review (AVA-MEDIA-AUTHZ-1, "B3")
// flagged that as a live cross-account exfiltration hole: a single shared DM
// with a victim authorized ALL of that victim's server-readable media, from
// every other conversation they have. See the fix + rationale on
// authorizeSourceMedia() below — the fallback is now REMOVED, not
// broadened; the "they sent it to me" case is covered by the requester's own
// ownRow instead (routes/media.ts's libraryRecord() always gives a recipient
// their own row).
// ---------------------------------------------------------------------------
// [AVA-MEDIA-AUTHZ-1] Exported — routes/media.ts's libraryRecord() (B2 fix)
// needs the exact same "does this uid share this conversation" check to
// authorize a forged-key /api/library/record call. One implementation, no
// second copy that could drift out of sync with this one.
export async function isConvMember(env: Env, conv: string, uid: string): Promise<boolean> {
  if (!conv) return false;
  // Mirrors routes/ava_image.ts's membersOf(): a 1:1 DM conv id encodes both
  // participants directly and may have no conversation_members rows at all.
  if (conv.startsWith("dm_")) {
    const parts = conv.slice(3).split("__");
    return parts.length === 2 && parts.includes(uid);
  }
  try {
    const r = await env.DB_META.prepare(
      "SELECT 1 FROM conversation_members WHERE conv_id=?1 AND uid=?2",
    ).bind(conv, uid).first();
    return !!r;
  } catch { return false; }
}

interface SourceMediaRow { id: string; uid: string }

// B1: resolve EITHER a user_media.id (UUID) or a content-hash/key-suffix
// identifier (the client's ChatMedia.id shape) to every matching user_media
// row. A content hash can legitimately match more than one row — the
// sender's own row AND each recipient's received-side copy
// (routes/media.ts's libraryRecord() inserts a row per recipient pointing at
// the SAME `key` as the sender's) — so this returns all candidates and lets
// authorizeSourceMedia() below decide which one is authorized.
// [B1 FIX / AVA-MEDIA-AUTHZ-1 — CRITICAL] `identifier` is client-supplied and
// was being concatenated into a LIKE pattern with NO metacharacter escaping
// and no ESCAPE clause: a caller could pass '%' / '_' as live wildcards
// (e.g. source_media_id:"private/%" -> `key LIKE '%/private/%'`, matching
// EVERY user's private media in the shard). Fixed by:
//   1. Rejecting any identifier that isn't a UUID (user_media.id) or a
//      64-hex sha256 content hash (the client's ChatMedia.id form) BEFORE it
//      ever reaches a query — the only two legitimate shapes.
//   2. Escaping '\', '%', '_' anyway (defense in depth — the shape check
//      above already excludes them, but every LIKE in this codebase should
//      follow the same rule) with an explicit ESCAPE '\', mirroring
//      routes/media.ts's getLibrary() precedent.
//   3. Excluding soft-deleted rows (deleted_at IS NULL) — a "deleted" file
//      must stop being a valid job source, or delete doesn't actually delete.
//   4. A LIMIT so a wildcard pattern can never return an unbounded row set.
async function findSourceMediaRows(env: Env, identifier: string): Promise<SourceMediaRow[]> {
  if (!/^[0-9a-f]{64}$/i.test(identifier) && !/^[0-9a-f-]{36}$/i.test(identifier)) return [];
  try {
    const byId = await env.DB_MEDIA.prepare(
      "SELECT id, uid FROM user_media WHERE id=?1 AND deleted_at IS NULL",
    ).bind(identifier).first<SourceMediaRow>();
    if (byId) return [byId];
    const escaped = identifier.replace(/[\\%_]/g, (m) => `\\${m}`);
    const byKey = await env.DB_MEDIA.prepare(
      "SELECT id, uid FROM user_media WHERE (key=?1 OR key LIKE '%/' || ?2 ESCAPE '\\') AND deleted_at IS NULL LIMIT 50",
    ).bind(identifier, escaped).all<SourceMediaRow>();
    return (byKey.results || []) as SourceMediaRow[];
  } catch { return []; }
}

type SourceMediaAuth =
  | { ok: true; mediaId: string }
  | { ok: false; error: "not_found" | "forbidden" };

// [B3 FIX / AVA-MEDIA-AUTHZ-1 — was authz hole] Prefers a row the REQUESTER
// themself owns (so the stored source_media_id points at the caller's own
// reference when they have one — e.g. either side of a DM).
//
// The earlier design (parked here as history) additionally fell back to
// "authorize any row whose OWNER is a member of `convId`" for the "they sent
// it to me" case. That check only proved the owner is a member of THIS
// conversation, never that the media was ever sent IN this conversation — a
// single shared DM with a victim authorized ALL of that victim's
// server-readable media, from every other conversation they have. There is
// no cheap way to verify "this media id/key actually appears in a message in
// convId" here: per the Cloudflare-native pivot (CLAUDE.md), messages live
// in per-account DO-local SQLite, not a D1 table this lib can join against.
//
// CHOSEN FIX: drop the fallback rather than build a real per-message check
// against a store this file can't see. It buys nothing legitimate: the real
// "they sent it to me" case is already fully covered by the ownRow branch
// above — receiving media calls POST /api/library/record
// (routes/media.ts's libraryRecord(), itself hardened this same wave) which
// inserts a row OWNED BY THE RECIPIENT (source_kind='received') pointing at
// the same key, so a real recipient always has their own row. Deny by
// default when no own row exists.
async function authorizeSourceMedia(env: Env, identifier: string, convId: string, requesterUid: string): Promise<SourceMediaAuth> {
  // convId membership for requesterUid is already verified by the caller
  // (createAiMediaJob's isConvMember(env, convId, ownerUid) check, above);
  // convId is accepted here only to keep the function signature/call site
  // unchanged for the other agents' callers.
  const rows = await findSourceMediaRows(env, identifier);
  if (!rows.length) return { ok: false, error: "not_found" };
  const ownRow = rows.find((r) => r.uid === requesterUid);
  if (ownRow) return { ok: true, mediaId: ownRow.id };
  return { ok: false, error: "forbidden" };
}

export type ArtifactSensitivity = "public" | "private";

// [B3 fix / §41] An artifact inherits the sensitivity of its source. No
// known-public source — including a bare-prompt image_generate with no
// source_media_id at all — defaults to PRIVATE: the safe default for a
// Messenger-conversation artifact. Only a source whose OWN user_media row is
// explicitly visibility='public' promotes the derived artifact to the public
// path. Deny-safe (private) on any lookup error. Callers: the per-kind job
// handlers ([AVA-IMAGE-UX-1]/[AVA-DOC-ARTIFACT-1]/[AVA-AUDIO-ARTIFACT-1]),
// BEFORE calling routes/media.ts's registerArtifactMedia().
export async function resolveArtifactSensitivity(env: Env, sourceMediaId: string | null | undefined): Promise<ArtifactSensitivity> {
  if (!sourceMediaId) return "private";
  try {
    const r = await env.DB_MEDIA.prepare("SELECT visibility FROM user_media WHERE id=?1").bind(sourceMediaId).first<{ visibility: string }>();
    return r?.visibility === "public" ? "public" : "private";
  } catch { return "private"; }
}

// ---------------------------------------------------------------------------
// createAiMediaJob — validates owner/conversation/media scope, reserves
// billing (ai_billing.ts), inserts the placeholder row. Idempotent by job_id.
// ---------------------------------------------------------------------------
export interface CreateAiMediaJobInput {
  ownerUid: string;
  convId: string;
  kind: AiMediaJobKind;
  sourceMediaId?: string | null;
  label?: string | null;
  targetLanguage?: string | null;
  estimate?: AiMediaJobEstimate;
  /** Caller-supplied id makes create() idempotent (a retried POST replays the
   * same job instead of double-reserving). Server generates one if omitted. */
  jobId?: string;
  email?: string | null;
}

export type CreateAiMediaJobResult =
  | { ok: true; job: AiMediaJobRecord }
  | { ok: false; error: string; status: number; needed?: number; balance?: number };

export async function createAiMediaJob(env: Env, input: CreateAiMediaJobInput): Promise<CreateAiMediaJobResult> {
  const ownerUid = String(input.ownerUid || "").trim();
  const convId = String(input.convId || "").trim();
  if (!ownerUid) return { ok: false, error: "owner_required", status: 400 };
  if (!convId) return { ok: false, error: "conv_required", status: 400 };
  if (!VALID_KINDS.has(input.kind)) return { ok: false, error: "invalid_kind", status: 400 };

  if (!(await isConvMember(env, convId, ownerUid))) {
    return { ok: false, error: "forbidden", status: 403 };
  }
  // B1/B2 fix: resolve the client-supplied identifier (either a user_media.id
  // OR the ChatMedia.id content-hash form) AND authorize it on conversation
  // membership (not raw uid equality) in one step. `sourceMediaId` below is
  // always the CANONICAL user_media.id once resolved, so every downstream
  // consumer (the D1 row, resolveArtifactSensitivity()) gets a real FK.
  const sourceMediaInput = input.sourceMediaId ? String(input.sourceMediaId).trim() : null;
  let sourceMediaId: string | null = null;
  if (sourceMediaInput) {
    const auth = await authorizeSourceMedia(env, sourceMediaInput, convId, ownerUid);
    if (!auth.ok) {
      return {
        ok: false,
        error: auth.error === "not_found" ? "source_media_not_found" : "forbidden",
        status: auth.error === "not_found" ? 404 : 403,
      };
    }
    sourceMediaId = auth.mediaId;
  }

  const jobId = String(input.jobId || crypto.randomUUID());

  // Idempotent create: a replay with the same job_id returns the existing row
  // untouched rather than re-reserving/re-inserting.
  const existing = await fetchJob(env, jobId);
  if (existing) {
    if (existing.owner_uid !== ownerUid) return { ok: false, error: "forbidden", status: 403 };
    return { ok: true, job: existing };
  }

  const usage = clampEstimate(input.kind, input.estimate);
  const reservation = await reserveAiJob(env, {
    uid: ownerUid, opId: jobId, capability: CAPABILITY_BY_KIND[input.kind],
    modality: MODALITY_BY_KIND[input.kind], model: MODEL_BY_KIND[input.kind],
    maxInputTokens: usage.inputTokens, maxOutputTokens: usage.outputTokens,
    units: { images: usage.images, avSeconds: usage.avSeconds },
    email: input.email ?? null,
  });
  if (!reservation.ok) {
    return {
      ok: false, error: reservation.error || "reserve_failed",
      status: reservation.error === "AI_INSUFFICIENT_TOKENS" ? 402 : 502,
      needed: reservation.needed, balance: reservation.balance,
    };
  }

  const ts = now();
  const label = input.label ? String(input.label).slice(0, 200) : null;
  const targetLanguage = input.targetLanguage ? String(input.targetLanguage).slice(0, 40) : null;
  // NULL = no wallet reservation was actually taken for this job (metering
  // was off / capability turned out free). Every OTHER function below treats
  // a NULL reservation_id as "nothing to settle/release" — never a wallet call.
  const reservationId = reservation.metered ? reservation.ref : null;

  try {
    await env.DB_MEDIA.prepare(
      `INSERT INTO ai_media_jobs
         (job_id, owner_uid, conv_id, source_media_id, kind, status, label, progress, target_language, artifact_media_id, error_code, reservation_id, created_at, updated_at, completed_at)
       VALUES (?1,?2,?3,?4,?5,'queued',?6,0,?7,NULL,NULL,?8,?9,?9,NULL)`,
    ).bind(jobId, ownerUid, convId, sourceMediaId, input.kind, label, targetLanguage, reservationId, ts).run();
  } catch (e) {
    // The row insert failed AFTER a successful reservation — release it so we
    // never leave a dangling hold with no job row to ever settle/fail it.
    await releaseAiJob(env, reservation, { uid: ownerUid, opId: jobId, capability: CAPABILITY_BY_KIND[input.kind], reason: "job_row_insert_failed" }).catch(() => {});
    void trackException(env, e, { uid: ownerUid, route: "ai_media_jobs.createAiMediaJob", handled: true, extra: { job_id: jobId, kind: input.kind } });
    return { ok: false, error: "internal_error", status: 500 };
  }

  void track(env, ownerUid, "ai_media_job_created", "ai_media_jobs", { job_id: jobId, kind: input.kind, conv_id: convId, metered: reservation.metered });
  const job = await fetchJob(env, jobId);
  return { ok: true, job: job! };
}

// ---------------------------------------------------------------------------
// claimAiMediaJob — atomic queued -> running. Conditional UPDATE + `changes`
// check (never read-then-write), so two concurrent claim attempts (at-least-
// once queue redelivery) can never both "win".
// ---------------------------------------------------------------------------
export type ClaimAiMediaJobResult =
  | { ok: true; job: AiMediaJobRecord }
  | { ok: false; error: "not_found" | "already_claimed" };

export async function claimAiMediaJob(env: Env, jobId: string): Promise<ClaimAiMediaJobResult> {
  const ts = now();
  const res = await env.DB_MEDIA.prepare(
    "UPDATE ai_media_jobs SET status='running', updated_at=?2 WHERE job_id=?1 AND status='queued'",
  ).bind(jobId, ts).run();
  if ((res.meta?.changes ?? 0) > 0) {
    const job = await fetchJob(env, jobId);
    return job ? { ok: true, job } : { ok: false, error: "not_found" };
  }
  const existing = await fetchJob(env, jobId);
  if (!existing) return { ok: false, error: "not_found" };
  // Already running or already terminal — safe no-op for an at-least-once
  // redelivery; the caller (queues/ai_media.ts) just acks and moves on.
  return { ok: false, error: "already_claimed" };
}

/** running -> queued, for a RETRYABLE provider failure — lets the queue's
 * automatic redelivery re-claim the job instead of leaving it stuck 'running'
 * forever (claimAiMediaJob's predicate only matches status='queued'). */
export async function requeueAiMediaJob(env: Env, jobId: string): Promise<boolean> {
  const res = await env.DB_MEDIA.prepare(
    "UPDATE ai_media_jobs SET status='queued', updated_at=?2 WHERE job_id=?1 AND status='running'",
  ).bind(jobId, now()).run();
  return (res.meta?.changes ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// completeAiMediaJob — atomic running -> succeeded + artifact link + settle
// (ai_billing.ts settleAiJob, exactly once by job_id). Idempotent: a replay
// against an already-succeeded job returns the existing row untouched.
// ---------------------------------------------------------------------------
export interface CompleteAiMediaJobArtifact {
  mediaId: string;
  mimeType?: string | null;
  fileName?: string | null;
  language?: string | null;
}
export interface CompleteAiMediaJobSettlement {
  modelActual: string;
  usage: UsageUnits;
  /** Prefer this straight from the provider's own reported cost (micro-USD) — ai_billing.ts's settleAiJob treats it as ground truth over the catalog estimate. */
  providerCostUsdMicro?: number;
}
export interface CompleteAiMediaJobInput {
  jobId: string;
  artifact: CompleteAiMediaJobArtifact;
  settlement: CompleteAiMediaJobSettlement;
  email?: string | null;
}
export type CompleteAiMediaJobResult = { ok: true; job: AiMediaJobRecord } | { ok: false; error: string };

export async function completeAiMediaJob(env: Env, input: CompleteAiMediaJobInput): Promise<CompleteAiMediaJobResult> {
  const job = await fetchJob(env, input.jobId);
  if (!job) return { ok: false, error: "not_found" };
  if (job.status === "succeeded") return { ok: true, job }; // idempotent replay

  const ts = now();
  const artifactId = crypto.randomUUID();

  const upd = await env.DB_MEDIA.prepare(
    "UPDATE ai_media_jobs SET status='succeeded', artifact_media_id=?2, progress=100, completed_at=?3, updated_at=?3 WHERE job_id=?1 AND status='running'",
  ).bind(input.jobId, input.artifact.mediaId, ts).run();

  if ((upd.meta?.changes ?? 0) === 0) {
    // Raced with another completion/failure/cancel — resolve from current state.
    const cur = await fetchJob(env, input.jobId);
    if (cur?.status === "succeeded") return { ok: true, job: cur };
    return { ok: false, error: cur ? `invalid_state:${cur.status}` : "not_found" };
  }

  try {
    await env.DB_MEDIA.prepare(
      `INSERT INTO ai_media_artifacts (artifact_id, owner_uid, source_media_id, job_id, media_id, mime_type, file_name, language, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
       ON CONFLICT(job_id, media_id) DO NOTHING`,
    ).bind(
      artifactId, job.owner_uid, job.source_media_id, input.jobId, input.artifact.mediaId,
      input.artifact.mimeType ?? null, input.artifact.fileName ?? null, input.artifact.language ?? null, ts,
    ).run();
  } catch (e) {
    // The job is already marked succeeded (the deliverable is real) — an
    // artifact-index write failure must never unwind that; log for repair.
    void trackException(env, e, { uid: job.owner_uid, route: "ai_media_jobs.completeAiMediaJob", handled: true, extra: { job_id: input.jobId } });
  }

  // Settle exactly once by job_id — best-effort; a billing-bookkeeping
  // failure never unwinds an already-delivered artifact (mirrors ai_billing.ts's
  // own "never fail the user's ALREADY-COMPLETED answer over our own
  // bookkeeping gap" stance, §65).
  if (job.reservation_id) {
    const reservation: ReserveAiJobResult = { ok: true, metered: true, reserved_tokens: 0, ref: job.reservation_id };
    await settleAiJob(env, reservation, {
      opId: input.jobId, uid: job.owner_uid, capability: CAPABILITY_BY_KIND[job.kind], modality: MODALITY_BY_KIND[job.kind],
      modelRequested: MODEL_BY_KIND[job.kind], modelActual: input.settlement.modelActual, usage: input.settlement.usage,
      providerCostUsdMicro: input.settlement.providerCostUsdMicro, email: input.email ?? null,
    }).catch((e) => {
      void trackException(env, e, { uid: job.owner_uid, route: "ai_media_jobs.completeAiMediaJob", method: "settleAiJob", handled: true, extra: { job_id: input.jobId } });
    });
  }

  void track(env, job.owner_uid, "ai_media_job_completed", "ai_media_jobs", { job_id: input.jobId, kind: job.kind, status: "succeeded" });
  const finalRow = await fetchJob(env, input.jobId);
  return { ok: true, job: finalRow! };
}

// ---------------------------------------------------------------------------
// failAiMediaJob — records a SAFE error code, releases/refunds the
// reservation (ai_billing.ts releaseAiJob). Idempotent: a replay against an
// already-terminal job returns the existing row untouched, never a double
// release.
// ---------------------------------------------------------------------------
export interface FailAiMediaJobInput {
  jobId: string;
  /** Short, safe code only (e.g. NOT_IMPLEMENTED, PROVIDER_ERROR, TIMEOUT, MODERATION_BLOCKED) — NEVER a raw provider message (§41/§42). */
  errorCode: string;
  reason: string; // free-form for telemetry only, e.g. "provider_error" | "timeout" | "moderation_block" | "worker_timeout"
}
export type FailAiMediaJobResult = { ok: true; job: AiMediaJobRecord } | { ok: false; error: string };

export async function failAiMediaJob(env: Env, input: FailAiMediaJobInput): Promise<FailAiMediaJobResult> {
  const job = await fetchJob(env, input.jobId);
  if (!job) return { ok: false, error: "not_found" };
  if (job.status === "failed" || job.status === "cancelled" || job.status === "succeeded") {
    return { ok: true, job }; // idempotent — already terminal
  }
  const ts = now();
  const errorCode = String(input.errorCode || "unknown_error").slice(0, 64);
  const upd = await env.DB_MEDIA.prepare(
    "UPDATE ai_media_jobs SET status='failed', error_code=?2, updated_at=?3 WHERE job_id=?1 AND status IN ('queued','running')",
  ).bind(input.jobId, errorCode, ts).run();

  if ((upd.meta?.changes ?? 0) > 0 && job.reservation_id) {
    const reservation: ReserveAiJobResult = { ok: true, metered: true, reserved_tokens: 0, ref: job.reservation_id };
    await releaseAiJob(env, reservation, {
      uid: job.owner_uid, opId: input.jobId, capability: CAPABILITY_BY_KIND[job.kind], reason: input.reason || errorCode,
    }).catch((e) => {
      void trackException(env, e, { uid: job.owner_uid, route: "ai_media_jobs.failAiMediaJob", method: "releaseAiJob", handled: true, extra: { job_id: input.jobId } });
    });
  }
  void track(env, job.owner_uid, "ai_media_job_failed", "ai_media_jobs", { job_id: input.jobId, kind: job.kind, error_code: errorCode, reason: input.reason });
  const finalRow = await fetchJob(env, input.jobId);
  return { ok: true, job: finalRow! };
}

// ---------------------------------------------------------------------------
// cancelAiMediaJob — owner-authorized cancellation. Idempotent.
// ---------------------------------------------------------------------------
export type CancelAiMediaJobResult = { ok: true; job: AiMediaJobRecord } | { ok: false; error: string };

export async function cancelAiMediaJob(env: Env, jobId: string, ownerUid: string): Promise<CancelAiMediaJobResult> {
  const job = await fetchJob(env, jobId);
  if (!job) return { ok: false, error: "not_found" };
  if (job.owner_uid !== ownerUid) return { ok: false, error: "forbidden" };
  if (job.status === "cancelled" || job.status === "succeeded" || job.status === "failed") {
    return { ok: true, job }; // idempotent
  }
  const ts = now();
  const upd = await env.DB_MEDIA.prepare(
    "UPDATE ai_media_jobs SET status='cancelled', updated_at=?2 WHERE job_id=?1 AND status IN ('queued','running')",
  ).bind(jobId, ts).run();

  if ((upd.meta?.changes ?? 0) > 0 && job.reservation_id) {
    const reservation: ReserveAiJobResult = { ok: true, metered: true, reserved_tokens: 0, ref: job.reservation_id };
    await releaseAiJob(env, reservation, { uid: ownerUid, opId: jobId, capability: CAPABILITY_BY_KIND[job.kind], reason: "client_cancel" }).catch(() => {});
  }
  void track(env, ownerUid, "ai_media_job_cancelled", "ai_media_jobs", { job_id: jobId, kind: job.kind });
  const finalRow = await fetchJob(env, jobId);
  return { ok: true, job: finalRow! };
}

// ---------------------------------------------------------------------------
// getAiMediaJob / listAiMediaJobs — account-scoped reconnect/hydration reads.
// ---------------------------------------------------------------------------
export type GetAiMediaJobResult = { ok: true; job: AiMediaJobRecord } | { ok: false; error: string };

export async function getAiMediaJob(env: Env, jobId: string, ownerUid: string): Promise<GetAiMediaJobResult> {
  const job = await fetchJob(env, jobId);
  if (!job) return { ok: false, error: "not_found" };
  if (job.owner_uid !== ownerUid) return { ok: false, error: "forbidden" };
  return { ok: true, job };
}

export interface ListAiMediaJobsInput {
  ownerUid: string;
  convId?: string;
  statuses?: AiMediaJobStatus[];
  limit?: number;
}

export async function listAiMediaJobs(env: Env, input: ListAiMediaJobsInput): Promise<AiMediaJobRecord[]> {
  const limit = Math.max(1, Math.min(200, Math.trunc(input.limit ?? 50)));
  const clauses = ["owner_uid=?1"];
  const binds: unknown[] = [input.ownerUid];
  if (input.convId) { clauses.push(`conv_id=?${binds.length + 1}`); binds.push(input.convId); }
  if (input.statuses && input.statuses.length) {
    const placeholders = input.statuses.map((_, i) => `?${binds.length + 1 + i}`).join(",");
    clauses.push(`status IN (${placeholders})`);
    binds.push(...input.statuses);
  }
  const sql = `SELECT * FROM ai_media_jobs WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT ${limit}`;
  try {
    const r = await env.DB_MEDIA.prepare(sql).bind(...binds).all<any>();
    const records = (r.results || []).map(rowToRecord);
    // Same artifact_url contract as fetchJob() — a reconnect/hydration list
    // must carry it too, or a client that only ever calls the list endpoint
    // (GET /api/ai/jobs?conv=...) would never learn how to open a succeeded
    // job's result.
    await Promise.all(records.map(async (rec) => {
      rec.artifact_url = await resolveArtifactUrl(env, rec.artifact_media_id);
    }));
    return records;
  } catch { return []; }
}
