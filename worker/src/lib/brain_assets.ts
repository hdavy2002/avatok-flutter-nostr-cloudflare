// [AVABRAIN-ASSET-1] worker/src/lib/brain_assets.ts
//
// Canonical `AvaMemoryAsset` lifecycle — Part VI §40/§47 of
// Specs/ROOT-CAUSE-REPORT-RECURRING-ISSUES-2026-07-25.md. This is the SINGLE
// place asset identity, consent, source links, index status and derivative
// deletion live. Every surface that touches an indexed image/PDF/audio/video —
// worker/src/routes/brain_media.ts (ingestion), worker/src/routes/brain.ts
// (search enforcement), consumers/src/brain.ts (video honesty status) and the
// future AVA-MEDIA-JOB-1 producers — reads/writes through this module, not
// through ad-hoc SQL scattered across those files.
//
// ── Why consent here is NOT the BRAIN_DOMAINS registry ───────────────────────
// worker/src/lib/brain_domains.ts is a fixed, type-checked registry
// (`BrainDomain = keyof typeof BRAIN_DOMAINS`) consumed by brainIngest() for
// the EVENT/queue-routing lane. It is owned by a concurrent change this
// session and is deliberately NOT edited here. The four consent keys below
// (image analysis / file indexing / audio transcription / sensitive media)
// are a SEPARATE, real gate: they read/write the SAME `brain_consent` table
// directly (mirrors worker/src/routes/brain_media.ts's own
// mediaMemoryConsentAllows, which already bypasses the registry the same way).
// `POST /api/brain/consent` (worker/src/routes/brain.ts) writes ANY capability
// string it's given with no registry check, so these keys are fully toggleable
// from Settings via the registry-list injection in
// worker/src/routes/brain_domains.ts — a REAL gate, not a fake flag (the
// CLAUDE.md "a flag config.ts doesn't declare is fake" rule is about
// PlatformConfig/DEFAULTS; brain_consent is a free-form capability table by
// design, exactly like every other AvaBrain consent key already is).
import type { Env } from "../types";

export type AssetKind = "image" | "pdf" | "document" | "audio" | "video";

export type AssetIndexStatus =
  | "pending"
  | "processing"
  | "ready"
  | "failed"
  | "unsupported_visual_indexing" // Part VI §40/§47 — video visual search is NOT implemented; never claim it is.
  | "deleted";

export type AssetSensitivity = "standard" | "sensitive";

// The wire/DB contract from Part VI §40 "Required ingestion contract", verbatim
// field-for-field (asset_id/owner_uid/media_id/source_conversation/
// source_message/kind/mime/title/user_description/language/created_at/
// transcript_ref/extracted_text_ref/caption_ref/embedding_ref/consent_version/
// sensitivity_class/index_status/deleted_at), plus updated_at for the standard
// row-lifecycle column every other brain_* table already carries.
export interface AvaMemoryAsset {
  asset_id: string;
  owner_uid: string;
  media_id: string;
  source_conversation: string | null;
  source_message: string | null;
  kind: AssetKind;
  mime: string | null;
  title: string | null;
  user_description: string | null;
  language: string | null;
  created_at: number;
  updated_at: number;
  transcript_ref: string | null;
  extracted_text_ref: string | null;
  caption_ref: string | null;
  embedding_ref: string | null;
  consent_version: number;
  sensitivity_class: AssetSensitivity;
  index_status: AssetIndexStatus;
  deleted_at: number | null;
}

export interface AvaMemoryAssetDerivative {
  derivative_id: string;
  asset_id: string;
  owner_uid: string;
  kind: "transcript" | "caption" | "ocr_text" | "extracted_text" | "embedding";
  // Opaque pointer only (a D1 row key or a Vectorize id) — NEVER the raw
  // transcript/caption/OCR text itself (Part VI §47 "do not expose raw
  // transcript/caption content"; the hard privacy boundary in the task brief).
  ref: string;
  created_at: number;
}

export const CONSENT_VERSION_CURRENT = 1;

// ── consent (real, D1-backed — see file header) ──────────────────────────────
const CAPABILITY_BY_KIND: Record<AssetKind, string> = {
  image: "brain_image_analysis",
  pdf: "brain_file_indexing",
  document: "brain_file_indexing",
  audio: "brain_audio_transcription",
  video: "brain_audio_transcription", // this pipeline only ever indexes the audio track (§40)
};
export const SENSITIVE_MEDIA_CAPABILITY = "brain_sensitive_media";

function capabilityKeysFor(kind: AssetKind, sensitivity: AssetSensitivity): string[] {
  const keys = ["master", CAPABILITY_BY_KIND[kind]];
  if (sensitivity === "sensitive") keys.push(SENSITIVE_MEDIA_CAPABILITY);
  return keys;
}

async function capabilityAllows(env: Env, uid: string, keys: string[]): Promise<boolean> {
  try {
    const ph = keys.map((_, i) => `?${i + 2}`).join(",");
    const rs = await env.DB_BRAIN.prepare(
      `SELECT enabled FROM brain_consent WHERE uid=?1 AND capability IN (${ph})`,
    ).bind(uid, ...keys).all();
    for (const r of (rs.results ?? []) as Array<{ enabled: number }>) if (Number(r.enabled) === 0) return false;
    return true;
  } catch (e) {
    console.error("[brain-assets] consent check failed — fail-closed:", String(e));
    return false; // a D1 outage must never silently allow ingest OR retrieval
  }
}

/** Ingest-time gate: may a new asset of this kind/sensitivity be created for uid? */
export async function assetIngestConsentAllows(
  env: Env, uid: string, kind: AssetKind, sensitivity: AssetSensitivity = "standard",
): Promise<boolean> {
  return capabilityAllows(env, uid, capabilityKeysFor(kind, sensitivity));
}

/**
 * Query-time re-check (Part VI §47 — "Enforce owner scope and consent at QUERY
 * time, not only ingestion time"). Consent can be revoked AFTER an asset was
 * indexed; a stale index row must stop being retrievable the instant consent
 * flips off, not only once the async retro-delete queue drains it. Same
 * underlying check as ingest — kept as a distinctly-named export so call sites
 * document WHICH boundary they are enforcing.
 */
export async function assetQueryConsentAllows(
  env: Env, uid: string, kind: AssetKind, sensitivity: AssetSensitivity = "standard",
): Promise<boolean> {
  return capabilityAllows(env, uid, capabilityKeysFor(kind, sensitivity));
}

export function capabilityKeyForKind(kind: AssetKind): string { return CAPABILITY_BY_KIND[kind]; }

// ── CRUD ──────────────────────────────────────────────────────────────────

export interface CreateAssetInput {
  ownerUid: string;
  mediaId: string;
  kind: AssetKind;
  mime?: string | null;
  title?: string | null;
  userDescription?: string | null;
  language?: string | null;
  sourceConversation?: string | null;
  sourceMessage?: string | null;
  sensitivityClass?: AssetSensitivity;
}

/**
 * Idempotent by (owner_uid, media_id) — a redelivered queue message or a
 * concurrent retry never creates a duplicate asset row. Returns the existing
 * row when one is already present (created_at/index_status untouched).
 */
export async function createOrGetAsset(env: Env, input: CreateAssetInput): Promise<AvaMemoryAsset> {
  const existing = await getAssetByMediaId(env, input.ownerUid, input.mediaId);
  if (existing) return existing;
  const now = Date.now();
  const assetId = crypto.randomUUID();
  try {
    await env.DB_BRAIN.prepare(
      `INSERT INTO brain_assets (
         asset_id, owner_uid, media_id, source_conversation, source_message, kind, mime, title,
         user_description, language, created_at, updated_at, transcript_ref, extracted_text_ref,
         caption_ref, embedding_ref, consent_version, sensitivity_class, index_status, deleted_at
       ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?11,NULL,NULL,NULL,NULL,?12,?13,'pending',NULL)
       ON CONFLICT(owner_uid, media_id) DO NOTHING`,
    ).bind(
      assetId, input.ownerUid, input.mediaId, input.sourceConversation ?? null, input.sourceMessage ?? null,
      input.kind, input.mime ?? null, input.title ?? null, input.userDescription ?? null, input.language ?? null,
      now, CONSENT_VERSION_CURRENT, input.sensitivityClass ?? "standard",
    ).run();
  } catch (e) {
    console.error("[brain-assets] create failed:", String(e));
  }
  // Re-read regardless of which branch won the race (this insert or a
  // concurrent one) — the UNIQUE(owner_uid, media_id) index is the authority.
  const row = await getAssetByMediaId(env, input.ownerUid, input.mediaId);
  if (row) return row;
  // Extremely unlikely (DB error on both insert and re-read) — return a
  // synthetic in-memory row so callers never null-check; nothing was persisted.
  return {
    asset_id: assetId, owner_uid: input.ownerUid, media_id: input.mediaId,
    source_conversation: input.sourceConversation ?? null, source_message: input.sourceMessage ?? null,
    kind: input.kind, mime: input.mime ?? null, title: input.title ?? null,
    user_description: input.userDescription ?? null, language: input.language ?? null,
    created_at: now, updated_at: now, transcript_ref: null, extracted_text_ref: null,
    caption_ref: null, embedding_ref: null, consent_version: CONSENT_VERSION_CURRENT,
    sensitivity_class: input.sensitivityClass ?? "standard", index_status: "pending", deleted_at: null,
  };
}

export async function getAssetByMediaId(env: Env, ownerUid: string, mediaId: string): Promise<AvaMemoryAsset | null> {
  try {
    return await env.DB_BRAIN.prepare(
      "SELECT * FROM brain_assets WHERE owner_uid=?1 AND media_id=?2 AND deleted_at IS NULL",
    ).bind(ownerUid, mediaId).first<AvaMemoryAsset>();
  } catch { return null; }
}

export async function getAsset(env: Env, ownerUid: string, assetId: string): Promise<AvaMemoryAsset | null> {
  try {
    return await env.DB_BRAIN.prepare(
      "SELECT * FROM brain_assets WHERE owner_uid=?1 AND asset_id=?2 AND deleted_at IS NULL",
    ).bind(ownerUid, assetId).first<AvaMemoryAsset>();
  } catch { return null; }
}

/** Bulk, owner-scoped lookup for query-time enrichment (worker/src/routes/brain.ts recall). */
export async function getAssetsByMediaIds(env: Env, ownerUid: string, mediaIds: string[]): Promise<Map<string, AvaMemoryAsset>> {
  const out = new Map<string, AvaMemoryAsset>();
  const ids = [...new Set(mediaIds.filter(Boolean))];
  if (!ids.length) return out;
  try {
    const ph = ids.map((_, i) => `?${i + 2}`).join(",");
    const rs = await env.DB_BRAIN.prepare(
      `SELECT * FROM brain_assets WHERE owner_uid=?1 AND media_id IN (${ph}) AND deleted_at IS NULL`,
    ).bind(ownerUid, ...ids).all<AvaMemoryAsset>();
    for (const r of (rs.results ?? []) as AvaMemoryAsset[]) out.set(r.media_id, r);
  } catch { /* best-effort — an empty map degrades to "no enrichment", never a leak */ }
  return out;
}

export async function setAssetIndexStatus(
  env: Env, ownerUid: string, assetId: string, status: AssetIndexStatus,
  patch: Partial<Pick<AvaMemoryAsset, "transcript_ref" | "extracted_text_ref" | "caption_ref" | "embedding_ref" | "title">> = {},
): Promise<void> {
  const now = Date.now();
  const cols = Object.keys(patch);
  const setSql = ["index_status=?3", "updated_at=?4", ...cols.map((c, i) => `${c}=?${i + 5}`)].join(", ");
  try {
    await env.DB_BRAIN.prepare(`UPDATE brain_assets SET ${setSql} WHERE asset_id=?1 AND owner_uid=?2`)
      .bind(assetId, ownerUid, status, now, ...cols.map((c) => (patch as any)[c])).run();
  } catch (e) { console.error("[brain-assets] status update failed:", String(e)); }
}

export async function addDerivative(
  env: Env, ownerUid: string, assetId: string, kind: AvaMemoryAssetDerivative["kind"], ref: string,
): Promise<void> {
  try {
    await env.DB_BRAIN.prepare(
      `INSERT INTO brain_asset_derivatives (derivative_id, asset_id, owner_uid, kind, ref, created_at)
       VALUES (?1,?2,?3,?4,?5,?6)`,
    ).bind(crypto.randomUUID(), assetId, ownerUid, kind, ref, Date.now()).run();
  } catch (e) { console.error("[brain-assets] derivative insert failed:", String(e)); }
}

export async function listDerivatives(env: Env, ownerUid: string, assetId: string): Promise<AvaMemoryAssetDerivative[]> {
  try {
    const rs = await env.DB_BRAIN.prepare(
      "SELECT * FROM brain_asset_derivatives WHERE owner_uid=?1 AND asset_id=?2",
    ).bind(ownerUid, assetId).all<AvaMemoryAssetDerivative>();
    return (rs.results ?? []) as AvaMemoryAssetDerivative[];
  } catch { return []; }
}

/**
 * Revoke: delete every derivative (Vectorize ids + brain_asset_derivatives
 * rows) and clear the asset's own transcript/caption/extracted_text/
 * embedding ref pointers, soft-deleting the asset row (deleted_at, index_status
 * ='deleted'). NEVER touches the original file/media (user_media, brain_media,
 * R2) — those are owned by the ingestion route, not this module, so "preserve
 * the original file" is structural, not a policy this function has to enforce.
 */
export async function deleteAssetDerivatives(env: Env, ownerUid: string, assetId: string): Promise<{ derivativesDeleted: number; vectorsDeleted: number }> {
  const derivatives = await listDerivatives(env, ownerUid, assetId);
  let vectorsDeleted = 0;
  if (env.VECTOR_INDEX) {
    const vecIds = derivatives.filter((d) => d.kind === "embedding").map((d) => d.ref);
    // Embeddings for an asset are also stored as `${uid}:asset:${assetId}:${i}`
    // (see consumers/src/brain_assets.ts) — sweep that pattern too in case a
    // derivative row for one chunk failed to insert but the vector landed.
    for (let i = 0; i < 32; i++) vecIds.push(`${ownerUid}:asset:${assetId}:${i}`);
    const uniq = [...new Set(vecIds)];
    for (let i = 0; i < uniq.length; i += 1000) {
      try { await env.VECTOR_INDEX.deleteByIds(uniq.slice(i, i + 1000)); vectorsDeleted += uniq.slice(i, i + 1000).length; } catch { /* best-effort */ }
    }
  }
  try {
    await env.DB_BRAIN.prepare("DELETE FROM brain_asset_derivatives WHERE owner_uid=?1 AND asset_id=?2").bind(ownerUid, assetId).run();
  } catch (e) { console.error("[brain-assets] derivative delete failed:", String(e)); }
  try {
    await env.DB_BRAIN.prepare(
      `UPDATE brain_assets SET index_status='deleted', transcript_ref=NULL, extracted_text_ref=NULL,
         caption_ref=NULL, embedding_ref=NULL, deleted_at=?3, updated_at=?3
       WHERE owner_uid=?1 AND asset_id=?2`,
    ).bind(ownerUid, assetId, Date.now()).run();
  } catch (e) { console.error("[brain-assets] asset soft-delete failed:", String(e)); }
  return { derivativesDeleted: derivatives.length, vectorsDeleted };
}

// ── source links / safe display (never raw transcript/caption content) ──────

/** A safe, source-linking summary for a search hit or status response. */
export interface AssetSourceLink {
  media_id: string;
  source_conversation: string | null;
  source_message: string | null;
  kind: AssetKind;
  title: string;
}

/** Truthful, content-free title — falls back to a generic kind label, never a snippet of transcript/caption. */
export function safeDisplayTitle(asset: AvaMemoryAsset): string {
  if (asset.title && asset.title.trim()) return asset.title.trim().slice(0, 120);
  const byKind: Record<AssetKind, string> = {
    image: "Image", pdf: "PDF document", document: "Document", audio: "Audio recording", video: "Video recording",
  };
  return byKind[asset.kind] ?? "File";
}

export function sourceLinkFor(asset: AvaMemoryAsset): AssetSourceLink {
  return {
    media_id: asset.media_id,
    source_conversation: asset.source_conversation,
    source_message: asset.source_message,
    kind: asset.kind,
    title: safeDisplayTitle(asset),
  };
}
