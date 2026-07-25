// [AVABRAIN-ASSET-1] consumers/src/brain_assets.ts
//
// Queue-side processing for AvaMemoryAsset derivatives: image captions/OCR,
// PDF text extraction, audio transcript indexing, and embeddings. The
// canonical asset/derivative SCHEMA, consent checks and lifecycle rules live
// in worker/src/lib/brain_assets.ts. `consumers` is a SEPARATE Worker package
// and cannot cross-import that file (same constraint already documented at
// the top of brain.ts for worker/src/lib/brain_domains.ts), so the handful of
// D1 statements this file needs are re-implemented here against the SAME
// `brain_assets` / `brain_asset_derivatives` tables
// (worker/migrations/2026-07-25-brain-assets.sql) — keep the two files'
// column/status vocabulary in sync if either changes.
//
// Consent is NEVER re-checked here. Ingestion consent (assetIngestConsentAllows
// in the worker lib) is the PRODUCER's job, before a job/asset row is ever
// created (worker/src/routes/brain_media.ts). By the time a message reaches
// this consumer, the asset row already exists — this file only PROCESSES and
// records status/derivatives, mirroring how consumers/src/brain.ts's
// ingestMediaMemory never re-checks media_memory consent either.
import type { Env } from "./types";
import { transcribeBuffer, captionImageBuffer, extractDocumentBuffer, embed, chunkText, recordVector } from "./brain";

export type AssetIndexStatus =
  | "pending" | "processing" | "ready" | "failed" | "unsupported_visual_indexing" | "deleted";

export type AssetKind = "image" | "pdf" | "document" | "audio" | "video";

// Mirrors worker/src/lib/brain_assets.ts CAPABILITY_BY_KIND / SENSITIVE_MEDIA_CAPABILITY.
// Used ONLY by deleteAssetsForOwnerByKind below (consent-revoke cascade), never
// to gate ingestion (see file header).
export const ASSET_KINDS_FOR_CAPABILITY: Record<string, AssetKind[]> = {
  brain_image_analysis: ["image"],
  brain_file_indexing: ["pdf", "document"],
  brain_audio_transcription: ["audio", "video"],
};
export const SENSITIVE_MEDIA_CAPABILITY = "brain_sensitive_media";

async function setAssetStatus(
  env: Env, ownerUid: string, assetId: string, status: AssetIndexStatus,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const now = Date.now();
  const cols = Object.keys(extra);
  const setSql = ["index_status=?3", "updated_at=?4", ...cols.map((c, i) => `${c}=?${i + 5}`)].join(", ");
  try {
    await env.DB_BRAIN.prepare(`UPDATE brain_assets SET ${setSql} WHERE asset_id=?1 AND owner_uid=?2`)
      .bind(assetId, ownerUid, status, now, ...cols.map((c) => (extra as any)[c])).run();
  } catch (e) { console.error("[brain-assets] status update failed:", String(e)); }
}

async function addDerivative(env: Env, ownerUid: string, assetId: string, kind: string, ref: string): Promise<void> {
  try {
    await env.DB_BRAIN.prepare(
      `INSERT INTO brain_asset_derivatives (derivative_id, asset_id, owner_uid, kind, ref, created_at)
       VALUES (?1,?2,?3,?4,?5,?6)`,
    ).bind(crypto.randomUUID(), assetId, ownerUid, kind, ref, Date.now()).run();
  } catch (e) { console.error("[brain-assets] derivative insert failed:", String(e)); }
}

export async function getAssetByMediaId(env: Env, ownerUid: string, mediaId: string): Promise<{ asset_id: string; kind: string } | null> {
  try {
    return await env.DB_BRAIN.prepare(
      "SELECT asset_id, kind FROM brain_assets WHERE owner_uid=?1 AND media_id=?2 AND deleted_at IS NULL",
    ).bind(ownerUid, mediaId).first<{ asset_id: string; kind: string }>();
  } catch { return null; }
}

async function embedAndUpsertChunks(
  env: Env, ownerUid: string, assetId: string, mediaId: string, kind: string, text: string,
): Promise<number> {
  const chunks = chunkText(text, 480).slice(0, 8); // bounded, mirrors every other ingest path in this package
  const vectors: any[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const values = await embed(env, chunks[i]);
    if (values) {
      vectors.push({
        id: `${ownerUid}:asset:${assetId}:${i}`, values,
        metadata: { uid: ownerUid, kind: "brain_asset", asset_kind: kind, media_id: mediaId, asset_id: assetId, type: kind, snippet: chunks[i].slice(0, 480) },
      });
    }
  }
  if (!vectors.length || !env.VECTOR_INDEX) return 0;
  try {
    await env.VECTOR_INDEX.upsert(vectors);
    for (const v of vectors) await recordVector(env, ownerUid, v.id, "brain_asset", kind, "brain_asset", assetId);
    return vectors.length;
  } catch (e) {
    console.error("[brain-assets] vector upsert failed:", String(e));
    return 0;
  }
}

// ---- image ----
// Caption + OCR via captionImageBuffer (reuses the SAME Gemma-4 vision call as
// the existing AvaLibrary image pipeline in brain.ts — no second vision stack).
export async function indexImageAsset(env: Env, p: { uid: string; assetId: string; mediaId: string; buf: ArrayBuffer; mime: string }): Promise<void> {
  try {
    await setAssetStatus(env, p.uid, p.assetId, "processing");
    const caption = await captionImageBuffer(env, p.buf, p.mime);
    if (!caption) { await setAssetStatus(env, p.uid, p.assetId, "ready"); return; }
    const n = await embedAndUpsertChunks(env, p.uid, p.assetId, p.mediaId, "image", caption);
    const ref = `asset_caption:${p.assetId}`;
    await addDerivative(env, p.uid, p.assetId, "caption", ref);
    if (n) await addDerivative(env, p.uid, p.assetId, "embedding", `${p.uid}:asset:${p.assetId}:0`);
    await setAssetStatus(env, p.uid, p.assetId, "ready", { caption_ref: ref });
  } catch (e) {
    console.error("[brain-assets] image index failed:", String(e));
    await setAssetStatus(env, p.uid, p.assetId, "failed");
  }
}

// ---- pdf / document ----
export async function indexPdfAsset(env: Env, p: { uid: string; assetId: string; mediaId: string; buf: ArrayBuffer; mime: string; name: string }): Promise<void> {
  try {
    await setAssetStatus(env, p.uid, p.assetId, "processing");
    const text = await extractDocumentBuffer(env, p.buf, p.mime, p.name);
    if (!text) { await setAssetStatus(env, p.uid, p.assetId, "ready"); return; }
    const n = await embedAndUpsertChunks(env, p.uid, p.assetId, p.mediaId, "document", text);
    const ref = `asset_text:${p.assetId}`;
    await addDerivative(env, p.uid, p.assetId, "extracted_text", ref);
    if (n) await addDerivative(env, p.uid, p.assetId, "embedding", `${p.uid}:asset:${p.assetId}:0`);
    await setAssetStatus(env, p.uid, p.assetId, "ready", { extracted_text_ref: ref });
  } catch (e) {
    console.error("[brain-assets] pdf index failed:", String(e));
    await setAssetStatus(env, p.uid, p.assetId, "failed");
  }
}

// ---- audio: record a transcript ALREADY COMPUTED by the caller ----
// Split from a full transcribe-then-index pipeline on purpose: the ONE real
// audio producer in the repo today (consumers/src/brain.ts ingestMediaMemory,
// the media_memory recording pipeline) already calls transcribeBuffer() itself
// for its own brain_transcripts row — calling it AGAIN here would double the
// Whisper cost for the exact same bytes. ingestMediaMemory instead calls this
// with the transcript it already has. A future standalone audio-asset
// producer (no pre-existing transcript) should call [indexAudioAssetTranscript]
// below, which transcribes THEN delegates here.
export async function recordAudioAssetDerivative(env: Env, p: { uid: string; assetId: string; mediaId: string; transcript: string }): Promise<void> {
  if (!p.transcript) { await setAssetStatus(env, p.uid, p.assetId, "ready"); return; }
  try {
    const n = await embedAndUpsertChunks(env, p.uid, p.assetId, p.mediaId, "audio", p.transcript);
    const ref = `asset_transcript:${p.assetId}`;
    await addDerivative(env, p.uid, p.assetId, "transcript", ref);
    if (n) await addDerivative(env, p.uid, p.assetId, "embedding", `${p.uid}:asset:${p.assetId}:0`);
    await setAssetStatus(env, p.uid, p.assetId, "ready", { transcript_ref: ref });
  } catch (e) {
    console.error("[brain-assets] audio derivative record failed:", String(e));
    await setAssetStatus(env, p.uid, p.assetId, "failed");
  }
}

export async function indexAudioAssetTranscript(env: Env, p: { uid: string; assetId: string; mediaId: string; plainBuf: ArrayBuffer; mime: string }): Promise<string> {
  try {
    await setAssetStatus(env, p.uid, p.assetId, "processing");
    const transcript = (await transcribeBuffer(env, p.plainBuf, p.mime)).slice(0, 8000);
    await recordAudioAssetDerivative(env, { uid: p.uid, assetId: p.assetId, mediaId: p.mediaId, transcript });
    return transcript;
  } catch (e) {
    console.error("[brain-assets] audio index failed:", String(e));
    await setAssetStatus(env, p.uid, p.assetId, "failed");
    return "";
  }
}

// ---- video: honesty gate (Part VI §40/§47) ----
// "Replace the current metadata-only/zero-frame video behavior with an
// explicit unsupported_visual_indexing status — do not claim video visual
// search works when it does not." Called by ingestMediaMemory AFTER (if the
// recording had one) recordAudioAssetDerivative, so index_status ends on
// 'unsupported_visual_indexing' (the true, limiting statement about this
// asset) while transcript_ref (if set) still lets the audio track stay
// text-searchable — the status documents the VISUAL gap specifically, it does
// not claim the whole asset failed.
export async function markVideoVisualUnsupported(env: Env, uid: string, assetId: string): Promise<void> {
  await setAssetStatus(env, uid, assetId, "unsupported_visual_indexing");
}

export async function markAssetFailed(env: Env, uid: string, assetId: string): Promise<void> {
  await setAssetStatus(env, uid, assetId, "failed");
}

// ---- per-item deletion (worker/src/routes/brain_media.ts DELETE
// /api/brain/media/:id → consumers/src/brain.ts deleteMediaMemory) ----
// Mirrors deleteAssetsForOwnerByKind's cleanup shape but scoped to the ONE
// asset linked to this media_id, so deleting a single recording/file also
// removes its canonical asset row + derivatives, not just the legacy
// brain_media/brain_vectors/brain_facts/brain_transcripts rows.
export async function deleteAssetForMedia(env: Env, ownerUid: string, mediaId: string): Promise<{ deleted: boolean; vectors: number }> {
  const asset = await getAssetByMediaId(env, ownerUid, mediaId);
  if (!asset) return { deleted: false, vectors: 0 };
  let vectors = 0;
  try {
    const dr = await env.DB_BRAIN.prepare(
      "SELECT ref FROM brain_asset_derivatives WHERE owner_uid=?1 AND asset_id=?2 AND kind='embedding'",
    ).bind(ownerUid, asset.asset_id).all<{ ref: string }>();
    const vecIds = ((dr.results ?? []) as Array<{ ref: string }>).map((x) => x.ref);
    for (let i = 0; i < 8; i++) vecIds.push(`${ownerUid}:asset:${asset.asset_id}:${i}`);
    if (env.VECTOR_INDEX) {
      const uniq = [...new Set(vecIds)];
      for (let i = 0; i < uniq.length; i += 1000) {
        try { await env.VECTOR_INDEX.deleteByIds(uniq.slice(i, i + 1000)); vectors += uniq.slice(i, i + 1000).length; } catch { /* best-effort */ }
      }
    }
    await env.DB_BRAIN.prepare("DELETE FROM brain_asset_derivatives WHERE owner_uid=?1 AND asset_id=?2").bind(ownerUid, asset.asset_id).run();
    await env.DB_BRAIN.prepare(
      `UPDATE brain_assets SET index_status='deleted', transcript_ref=NULL, extracted_text_ref=NULL,
         caption_ref=NULL, embedding_ref=NULL, deleted_at=?3, updated_at=?3
       WHERE owner_uid=?1 AND asset_id=?2`,
    ).bind(ownerUid, asset.asset_id, Date.now()).run();
  } catch (e) { console.error("[brain-assets] per-item delete failed:", String(e)); }
  return { deleted: true, vectors };
}

// ---- consent-revoke cascade (Part VI §40 "revoking consent must enqueue
// deletion of every derivative"; task brief item 9 "clear revoke action that
// deletes derived indexes while preserving the original file") ----
// Called from consumers/src/brain.ts retroDelete() when one of the four
// brain_assets capability keys is toggled off. Deletes every asset of the
// matching kind(s) for this owner: its Vectorize ids, its
// brain_asset_derivatives rows, and soft-deletes the brain_assets row itself
// (index_status='deleted', ref pointers cleared, deleted_at set). NEVER
// touches user_media / brain_media / R2 — the original file is a completely
// separate store this module has no reference to.
export async function deleteAssetsForOwnerByKind(env: Env, ownerUid: string, kinds: AssetKind[] | null, sensitivityOnly?: "sensitive"): Promise<{ assets: number; derivatives: number; vectors: number }> {
  let rows: Array<{ asset_id: string }> = [];
  try {
    if (sensitivityOnly) {
      const rs = await env.DB_BRAIN.prepare(
        "SELECT asset_id FROM brain_assets WHERE owner_uid=?1 AND sensitivity_class='sensitive' AND deleted_at IS NULL",
      ).bind(ownerUid).all<{ asset_id: string }>();
      rows = (rs.results ?? []) as Array<{ asset_id: string }>;
    } else if (kinds && kinds.length) {
      const ph = kinds.map((_, i) => `?${i + 2}`).join(",");
      const rs = await env.DB_BRAIN.prepare(
        `SELECT asset_id FROM brain_assets WHERE owner_uid=?1 AND kind IN (${ph}) AND deleted_at IS NULL`,
      ).bind(ownerUid, ...kinds).all<{ asset_id: string }>();
      rows = (rs.results ?? []) as Array<{ asset_id: string }>;
    }
  } catch (e) { console.error("[brain-assets] revoke lookup failed:", String(e)); return { assets: 0, derivatives: 0, vectors: 0 }; }

  let derivatives = 0, vectors = 0;
  for (const r of rows) {
    try {
      const dr = await env.DB_BRAIN.prepare(
        "SELECT ref FROM brain_asset_derivatives WHERE owner_uid=?1 AND asset_id=?2 AND kind='embedding'",
      ).bind(ownerUid, r.asset_id).all<{ ref: string }>();
      const vecIds = ((dr.results ?? []) as Array<{ ref: string }>).map((x) => x.ref);
      for (let i = 0; i < 8; i++) vecIds.push(`${ownerUid}:asset:${r.asset_id}:${i}`); // sweep even if the derivative row is missing
      const countRow = await env.DB_BRAIN.prepare(
        "SELECT COUNT(*) AS n FROM brain_asset_derivatives WHERE owner_uid=?1 AND asset_id=?2",
      ).bind(ownerUid, r.asset_id).first<{ n: number }>();
      derivatives += Number(countRow?.n ?? 0);
      if (env.VECTOR_INDEX) {
        const uniq = [...new Set(vecIds)];
        for (let i = 0; i < uniq.length; i += 1000) {
          try { await env.VECTOR_INDEX.deleteByIds(uniq.slice(i, i + 1000)); vectors += uniq.slice(i, i + 1000).length; } catch { /* best-effort */ }
        }
      }
      await env.DB_BRAIN.prepare("DELETE FROM brain_asset_derivatives WHERE owner_uid=?1 AND asset_id=?2").bind(ownerUid, r.asset_id).run();
      await env.DB_BRAIN.prepare(
        `UPDATE brain_assets SET index_status='deleted', transcript_ref=NULL, extracted_text_ref=NULL,
           caption_ref=NULL, embedding_ref=NULL, deleted_at=?3, updated_at=?3
         WHERE owner_uid=?1 AND asset_id=?2`,
      ).bind(ownerUid, r.asset_id, Date.now()).run();
    } catch (e) { console.error("[brain-assets] revoke delete failed for asset", r.asset_id, String(e)); }
  }
  return { assets: rows.length, derivatives, vectors };
}
