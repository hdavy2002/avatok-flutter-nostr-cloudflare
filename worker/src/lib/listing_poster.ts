// [MKT-POSTER-AUTO-1] Shared listing-poster generation. Extracted from the
// inline logic that used to live in admin_listings.ts (generate_poster
// action) so it can be called from TWO places with different transaction
// shapes:
//   1. the admin "regenerate" action (still writes its own D1 row), and
//   2. the auto-generate-on-submit path in routes/listings.ts, which sets
//      status='generating' synchronously and then finishes the write
//      detached (see submitListingForApproval).
//
// This module NEVER writes to D1 — the caller owns the DB write, on purpose,
// because the two callers commit in different batches/transactions. It also
// NEVER throws: any failure is folded into a `PosterState` with
// status:'failed' so a caller can always persist a terminal state instead of
// leaving a listing stuck on "generating" forever.
import type { Env } from "../types";
import { sha256Hex } from "../util";
import { generateImage } from "../routes/ava_image";

export type PosterState = {
  status: "generating" | "draft" | "approved" | "rejected" | "failed";
  generated_at?: number;
  completed_at?: number;
  provider?: string;
  prompt_hash?: string;
  prompt?: string;
  url?: string;
  key?: string;
  bytes?: number;
  error?: string;
  feedback?: string;
  rejected_reason?: string;
  attempt?: number;
  auto?: boolean;
};

export type CoverMediaItem = {
  type: string;
  url: string;
  source: string;
  generated: boolean;
};

// Curated, bounded inputs only — never free text beyond what's already on the
// listing row. Keeps the same safety framing as the original inline prompt:
// fictional characters only, bold readable typography, printed-poster
// texture, no real celebrity likenesses. The moderation gate inside
// generateImage() (obviousSexualImagePrompt + moderate()) is untouched and
// must never be bypassed here.
export function buildPosterPrompt(row: Record<string, any>): string {
  const title = String(row?.title || "Untitled listing").trim();
  const parts: string[] = [
    `Create a vivid Indian film-poster artwork for the listing titled "${title}".`,
  ];

  const sceneBits: string[] = [];
  if (row?.blurb) sceneBits.push(String(row.blurb).trim());
  if (row?.description) sceneBits.push(String(row.description).trim());
  if (sceneBits.length) {
    parts.push(`Scene and mood: ${sceneBits.join(" — ")}.`);
  } else {
    parts.push("Scene and mood: a lively creator marketplace experience.");
  }

  if (row?.category) parts.push(`Category: ${String(row.category).trim()}.`);
  if (row?.kind) parts.push(`Format: ${String(row.kind).trim()}.`);

  if (row?.vibe_tags) {
    let tags: unknown = row.vibe_tags;
    if (typeof tags === "string") { try { tags = JSON.parse(tags); } catch { tags = null; } }
    if (Array.isArray(tags) && tags.length) {
      const clean = tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 4);
      if (clean.length) parts.push(`Vibe: ${clean.join(", ")}.`);
    }
  }

  if (row?.spoken_lang) parts.push(`Spoken language: ${String(row.spoken_lang).trim()}.`);

  parts.push(
    "Use fictional characters only, bold readable typography, printed-poster texture, and no real celebrity likenesses.",
  );

  return parts.join(" ").slice(0, 1800);
}

export async function generateListingPoster(
  env: Env,
  opts: {
    listingId: string;
    ownerUid: string;
    row: Record<string, any>;
    prompt?: string;
    actorUid: string;
    auto?: boolean;
    attempt?: number;
  },
): Promise<{ poster: PosterState; coverMedia: CoverMediaItem[] | null }> {
  const prompt = (opts.prompt || buildPosterPrompt(opts.row)).slice(0, 1800);
  const base: PosterState = {
    status: "generating",
    generated_at: Date.now(),
    provider: "vertex",
    prompt_hash: await sha256Hex(prompt),
    prompt,
    auto: opts.auto,
    attempt: opts.attempt,
  };
  try {
    const generated = await generateImage(env, "", prompt, opts.actorUid);
    const hash = await sha256Hex(generated.bytes);
    // Keyed by the listing OWNER, not the actor performing the generation —
    // an auto-generation on submit has no admin in the request, and even for
    // the admin-triggered path the asset belongs to the creator's listing,
    // not the admin who happened to click regenerate.
    const key = `u/${opts.ownerUid}/public/posters/${opts.listingId}/${hash}.png`;
    await env.BLOBS.put(key, generated.bytes, { httpMetadata: { contentType: "image/png" } });
    const url = `${env.BLOSSOM_BASE_URL}/${key}`;

    const poster: PosterState = {
      ...base,
      status: "draft",
      url,
      key,
      bytes: generated.bytes.byteLength,
      completed_at: Date.now(),
    };

    let covers: any[] = [];
    try {
      const raw = opts.row?.cover_media;
      covers = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : [];
    } catch { covers = []; }
    covers = Array.isArray(covers) ? covers.filter((c) => c && c.url !== url && c.source !== "ai_poster") : [];
    const coverMedia: CoverMediaItem[] = [
      { type: "image", url, source: "ai_poster", generated: true },
      ...covers,
    ];

    return { poster, coverMedia };
  } catch (e) {
    const poster: PosterState = {
      ...base,
      status: "failed",
      error: String((e as any)?.message || "provider unavailable").slice(0, 180),
    };
    return { poster, coverMedia: null };
  }
}
