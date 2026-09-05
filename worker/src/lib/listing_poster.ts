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
import { verifyPosterText, type PosterVerdict } from "./poster_verify";
import type { PosterSubject } from "./poster_subject";
import { writePosterDialogue } from "./poster_dialogue";
import { track } from "../hooks";

/** [POSTER-FIRST-1] The three shapes a poster is rendered at. Portrait is the
 *  canonical one — it is what `PosterState.url` points at, so every reader that
 *  predates variants keeps working with no change. */
export const POSTER_RATIOS = {
  portrait: "2:3",
  tablet: "4:3",
  wide: "16:9",
} as const;
export type PosterRatio = keyof typeof POSTER_RATIOS;

export type PosterVariants = Partial<Record<PosterRatio, { url: string; key: string; bytes: number }>>;

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
  // --- [POSTER-FIRST-1 2026-09-05] ---
  /** Per-ratio renders. `url` above stays the portrait. */
  variants?: PosterVariants;
  /** Verdict of the last read-back pass. Persisted even when it passed, so a
   *  drifting prompt shows up as a pattern instead of a one-off complaint. */
  verify?: PosterVerdict;
  /** "baked" = the model lettered the title itself (the good case).
   *  "overlay" = it could not be trusted to, so the artwork is textless and the
   *  CLIENT draws the title and tagline over it. See buildPosterArtOnlyPrompt. */
  lettering?: "baked" | "overlay";
  /** The copy the client needs when lettering === "overlay". */
  copy?: PosterCopy;
  style_version?: number;
};

/** Flags + inputs for one generation run. All optional so the existing admin
 *  caller keeps compiling; defaults are the conservative, flags-off behaviour. */
export type PosterGenerateOptions = {
  listingId: string;
  ownerUid: string;
  row: Record<string, any>;
  prompt?: string;
  actorUid: string;
  auto?: boolean;
  attempt?: number;
  /** posterVerifyEnabled */
  verify?: boolean;
  /** posterVerifyMaxAttempts */
  maxAttempts?: number;
  /** posterVariantsEnabled — render tablet + wide as well as portrait */
  variants?: boolean;
  /** posterComposeFallbackEnabled — textless artwork + client lettering */
  composeFallback?: boolean;
  /** A creator-uploaded photo, so the portrait is painted from their face. */
  editRef?: string;
  /** [POSTER-SUBJECT-1] Who the poster is of — resolved by the caller from the
   *  creator's profile (see lib/poster_subject.ts). Its `photoUrl`, when the
   *  face check passed, becomes the editRef; its `gender` becomes a prompt
   *  clause that works with or without the photo. */
  subject?: PosterSubject | null;
  /** [POSTER-FILMY-1] posterDialogueEnabled — replace the creator's blurb with
   *  an LLM-written filmy punch line as the poster's tagline. */
  dialogue?: boolean;
  /** [POSTER-CHECKPOINT-1 2026-09-05] Called the moment the PORTRAIT is in R2
   *  and is therefore a usable poster, BEFORE the tablet/wide reframes run.
   *
   *  It exists because the auto-generate caller runs this whole function
   *  detached on `ctx.waitUntil`, and a detached isolate can be killed at any
   *  point with no `catch` and no `finally`. When that happened on 2026-09-05
   *  (listing 845567cb) the portrait had already generated and PASSED
   *  verification 22s in — and was thrown away, because the only D1 write came
   *  after two more Vertex calls. The row sat on `generating` until the 5-minute
   *  cron swept it to "Poster generation was interrupted."
   *
   *  So: persist the portrait as soon as it exists. Variants are an enhancement
   *  and are written by a second, later call. A checkpoint that throws is
   *  swallowed — failing to save early must never lose the run that follows. */
  onPortrait?: (r: { poster: PosterState; coverMedia: CoverMediaItem[] }) => Promise<void>;
};

export type CoverMediaItem = {
  type: string;
  url: string;
  source: string;
  generated: boolean;
};

// ---------------------------------------------------------------------------
// [POSTER-FIRST-1 2026-09-05] The poster carries the TITLE and the TAGLINE and
// nothing else.
//
// Every fact a buyer needs — price, duration, language, category, house rules —
// renders as HTML text in the More info panel, from the D1 row. It is
// DELIBERATE that no number reaches the model: an image model asked to letter
// "₹250" will sometimes produce "₹25O" or "₹280", and a wrong price on a live
// listing is a money bug, not a cosmetic one. Two short strings handed over
// verbatim is a problem the model can actually get right, and the read-back
// pass in poster_verify.ts checks that it did.
//
// [POSTER-FILMY-1 2026-09-05] STOP DICTATING THE LOOK. This is the second time
// this prompt has been over-specified into a corner, and the lesson is the same
// both times.
//
// v1 asked for "printed-poster texture" and got an aged sepia thing nobody
// wanted. v2 over-corrected into a recipe: "THREE-COLOUR SCREEN PRINT", "ink
// palette limited to three flat poster inks only — vermilion red, chrome green
// and black", "coarse halftone dot screen", "hard outlines, heavy black
// linework, no soft shading, no gradients, no airbrush". Every one of those
// lines was followed exactly, so EVERY poster came out the same red/green/white
// object — and "flat ink, hard outlines, no shading" is a precise description of
// a cartoon, which is what the owner said they looked like. The prompt also
// carried "NOT a cartoon", so it was arguing with itself and losing.
//
// What the reference posters he wants actually are: PAINTED. Modelled faces,
// real light and shadow, full colour, and a different palette, era and display
// face on every single one — because they were painted by different artists for
// different films.
//
// So the style block now names the genre, insists on paint rather than flat
// print, and hands the choice of palette, era, lettering and composition to the
// model. Owner instruction, verbatim: "please dont hard code instructions to AI,
// let ai think, you just give what content to fill in". If a future poster looks
// wrong, the fix is to give it better CONTENT (a truer scene, a better line, the
// right subject), not to add another adjective here. Adding adjectives is what
// produced the identical red-and-green cartoons.
//
// The negative list is not decoration either. Left to itself the model imitates
// the whole poster OBJECT, which means inventing a cast list, a studio name and
// a painter's signature in the margin. Fabricated credits on a real listing are
// worse than a typo and are the failure a human reviewer skims straight past —
// verified for real on the 2026-09-05 test poster, which passed every visible
// check and still carried an invented signature.
//
// The moderation gate inside generateImage() (obviousSexualImagePrompt +
// moderate() on the prompt, moderateGeneratedImage() on the output) is
// untouched and must never be bypassed here.
// ---------------------------------------------------------------------------

/** Bump when the prompt changes shape, so telemetry can separate style eras.
 *  3 = [POSTER-SUBJECT-1], which added the WHO block (creator likeness + gender).
 *  4 = [POSTER-FILMY-1], which deleted the dictated three-ink screen-print look
 *      and the blurb-as-tagline. */
export const POSTER_STYLE_VERSION = 4;

export type PosterCopy = { title: string; tagline: string };

/** The exact strings the poster must letter — and the only ones verification
 *  will accept. Kept separate from the prompt so poster_verify.ts diffs against
 *  the same values the prompt was built from, never a re-derived copy. */
export function posterCopy(row: Record<string, any>): PosterCopy {
  const title = String(row?.title || "Untitled listing").trim().slice(0, 60);
  // The wizard's one-line blurb is the tagline. Description is deliberately NOT
  // a fallback: it runs to paragraphs and a model asked to letter a paragraph
  // produces exactly the dense invented-text failure this design avoids.
  const tagline = String(row?.blurb || "").trim().slice(0, 40);
  return { title, tagline };
}

/** [POSTER-SUBJECT-1 2026-09-05] The direction that says WHO is in the poster.
 *
 *  Without it the model invents a person from the title and the category, which
 *  in practice means inventing from a stereotype: "Cooking with Davy", filed
 *  under Cooking, in India, came back as a woman in a sari. Davy is a man, and
 *  both his profile gender and a photo of his face were sitting unread in the
 *  users table.
 *
 *  Wording matters here. The likeness line is emphatic because an image model
 *  handed a reference photo will otherwise "improve" the person — younger,
 *  lighter, more symmetrical — and a poster of a prettier stranger is not a
 *  poster of the creator. The gender line is separate and survives on its own,
 *  so the fallback path still gets the one fact that was actually wrong. */
function subjectDirection(subject?: PosterSubject | null): string[] {
  if (!subject) return [];
  const out: string[] = [];
  if (subject.photoUrl) {
    out.push(
      "THE SUBJECT IS THE PERSON IN THE SUPPLIED REFERENCE PHOTOGRAPH. Repaint",
      "that same person as the poster's subject — the same face, the same",
      "apparent age, the same skin tone, the same hair and the same build —",
      "painted in whatever technique you have chosen for this poster. Do NOT substitute",
      "a different person, do NOT make them younger, lighter-skinned or more",
      "conventionally attractive, and do NOT add a second person.",
    );
  }
  if (subject.gender === "male") {
    out.push("The person in the poster is a MAN. Do not paint a woman.");
  } else if (subject.gender === "female") {
    out.push("The person in the poster is a WOMAN. Do not paint a man.");
  }
  return out;
}

export function buildPosterPrompt(
  row: Record<string, any>,
  subject?: PosterSubject | null,
  /** [POSTER-FILMY-1] The resolved copy, when the caller already has it (the
   *  filmy dialogue is written by an LLM and must reach the prompt and the
   *  verifier as the SAME strings). Falls back to the row's own fields. */
  copyOverride?: PosterCopy | null,
): string {
  const { title, tagline } = copyOverride ?? posterCopy(row);

  // Scene direction only — these shape the ARTWORK and are never lettered.
  const scene: string[] = [];
  if (row?.description) scene.push(String(row.description).trim().slice(0, 300));
  else if (row?.blurb) scene.push(String(row.blurb).trim().slice(0, 300));
  if (row?.category) scene.push(`Subject area: ${String(row.category).trim()}`);
  if (row?.vibe_tags) {
    let tags: unknown = row.vibe_tags;
    if (typeof tags === "string") { try { tags = JSON.parse(tags); } catch { tags = null; } }
    if (Array.isArray(tags) && tags.length) {
      const clean = tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 3);
      if (clean.length) scene.push(`Mood: ${clean.join(", ")}`);
    }
  }

  const parts: string[] = [
    // --- what it is (the genre, and nothing beyond it) ---
    "A hand-painted Bollywood film poster, painted by a studio poster artist for",
    "a cinema hoarding.",
    // --- the ONE aesthetic constraint, because it is the failure mode ---
    // Painted vs printed is not a style preference, it is the difference between
    // the reference posters and the flat red/green cartoons v2 produced. Left
    // unsaid, image models drift to flat vector fills, which is precisely what
    // "cartoon" means here.
    "PAINTED, NOT PRINTED: real brushwork, faces modelled with light and shadow,",
    "believable skin tones, depth. The people must look like real people who were",
    "painted — not flat vector shapes, not cel-shaded, not a comic panel, not a",
    "sticker, not a 3D render.",
    // --- everything else is the model's call, ON PURPOSE ---
    "Everything else is YOUR choice, and should suit THIS poster and no other:",
    "the palette, the decade it evokes, the composition, and above all the",
    "display lettering — invent a face for this title rather than reaching for a",
    "default. Real posters look nothing like each other, and neither should",
    "these. Do not limit yourself to two or three flat inks.",
    // --- what goes in it ---
    scene.length
      ? `Scene: ${scene.join(". ")}.`
      : "Scene: a lively creator at work, large in frame.",
    ...subjectDirection(subject),
    // --- the safety rules, which are NOT style and stay verbatim ---
    "Render EXACTLY this text and NOTHING ELSE — no cast list, no studio name, no",
    "credits, no price, no dates, no signature, no artist's mark, no printer's",
    "marks, no watermark, no invented words, no filler lettering, and no text of",
    "any kind in the margins:",
    `  TITLE: "${title}"`,
    tagline ? `  TAGLINE: "${tagline}"` : "  (no tagline — render the title only)",
    "The title is the largest thing on the poster.",
    "CRISP AND NEW: no sepia, no foxing, no tears, no fading, no dust, no scratches.",
    "No real celebrity likenesses.",
  ];

  return parts.join(" ").slice(0, 1800);
}

/** The fallback prompt: the same poster, painted with NO LETTERING AT ALL.
 *
 *  Reached only after the model has failed verification `maxAttempts` times.
 *  The client then draws the title and tagline over the reserved bands as real
 *  HTML text, which is why this asks for flat empty colour fields top and
 *  bottom rather than a full-bleed painting.
 *
 *  NOTE this is deliberately NOT a pixel compositor running in the Worker.
 *  Workers have no canvas and no SVG rasteriser, so "composite the text" would
 *  mean shipping a rendering library into the isolate to produce a WORSE result
 *  than the browser already gives for free — text baked into a PNG is blurry
 *  when scaled, unselectable, untranslatable and invisible to a screen reader.
 *  Letting the client letter it keeps the text real text at every size. */
export function buildPosterArtOnlyPrompt(
  row: Record<string, any>,
  subject?: PosterSubject | null,
): string {
  const artwork = buildPosterPrompt(row, subject);
  // Strip the "render exactly this text" block and replace the whole
  // instruction with its opposite, rather than appending a contradiction the
  // model gets to choose between.
  const cut = artwork.indexOf("Render EXACTLY this text");
  const base = cut > 0 ? artwork.slice(0, cut) : artwork;
  return [
    base,
    "ABSOLUTELY NO TEXT ANYWHERE IN THE IMAGE. No title, no tagline, no words,",
    "no letters, no numbers, no credits, no signature, no printer's marks, no",
    "watermark, no lettering of any kind.",
    "COMPOSITION: keep the subject in the middle band. Leave the top 18% and the",
    "bottom 28% as flat, uncluttered fields of a single poster ink with no faces,",
    "no hands and no fine detail — lettering is added afterwards.",
  ].join(" ").slice(0, 1800);
}

// --------------------------------------------------------------------------
// Storage
// --------------------------------------------------------------------------

/** Content-addressed, so a regenerated poster is always a NEW key. That is what
 *  makes the immutable cache header below safe: nothing behind a given URL ever
 *  changes, so neither the CDN nor a phone can serve a stale poster. */
async function putPoster(
  env: Env, ownerUid: string, listingId: string, ratio: PosterRatio, bytes: Uint8Array,
): Promise<{ url: string; key: string; bytes: number }> {
  const hash = await sha256Hex(bytes);
  const key = `u/${ownerUid}/public/posters/${listingId}/${hash}-${ratio}.png`;
  await env.BLOBS.put(key, bytes, {
    httpMetadata: {
      contentType: "image/png",
      cacheControl: "public, max-age=31536000, immutable",
    },
  });
  return { url: `${env.BLOSSOM_BASE_URL}/${key}`, key, bytes: bytes.byteLength };
}

function toDataUrl(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:image/png;base64,${btoa(binary)}`;
}

export async function generateListingPoster(
  env: Env,
  opts: PosterGenerateOptions,
): Promise<{ poster: PosterState; coverMedia: CoverMediaItem[] | null }> {
  // [POSTER-FILMY-1] The copy is resolved FIRST and once, because three things
  // must agree on the exact strings: the image prompt, the read-back verifier
  // (poster_verify.ts diffs against these), and `PosterState.copy`, which the
  // client letters over the artwork on the compose-fallback path. Deriving it
  // twice is how a poster ends up failing verification against a tagline it was
  // never asked to paint.
  let copy = posterCopy(opts.row);
  if (opts.dialogue) {
    const line = await writePosterDialogue(env, opts.row);
    // A null line means the writer was unavailable or returned something
    // unusable. Keep the blurb — a plain tagline is a duller poster, not a
    // broken one, and it is exactly what shipped before this change.
    if (line) copy = { ...copy, tagline: line };
  }
  const basePrompt = (opts.prompt || buildPosterPrompt(opts.row, opts.subject, copy)).slice(0, 1800);
  // [POSTER-SUBJECT-1] An explicit editRef still wins (the admin override), but
  // with none supplied the creator's own vetted photo is the reference.
  const editRef = opts.editRef || opts.subject?.photoUrl || undefined;
  const maxAttempts = Math.max(1, Math.min(5, Math.trunc(opts.maxAttempts ?? 1)));
  const base: PosterState = {
    status: "generating",
    generated_at: Date.now(),
    provider: "vertex",
    prompt_hash: await sha256Hex(basePrompt),
    prompt: basePrompt,
    auto: opts.auto,
    attempt: opts.attempt,
    style_version: POSTER_STYLE_VERSION,
    copy,
  };
  const t0 = Date.now();

  try {
    // ---------------------------------------------------------------
    // 1. Portrait, with the generate -> verify -> retry loop.
    //
    // Portrait is generated FIRST and alone because it is the canonical
    // render: the other two ratios are reframed from it, so a portrait that
    // fails verification must never become the source three times over.
    // ---------------------------------------------------------------
    let bytes: Uint8Array | null = null;
    let verdict: PosterVerdict | undefined;
    let lettering: "baked" | "overlay" = "baked";
    let hint = "";
    let used = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      used = attempt;
      const prompt = hint
        ? `${basePrompt} CORRECTION for this attempt: ${hint}.`.slice(0, 1800)
        : basePrompt;
      const generated = await generateImage(
        env, "", prompt, opts.actorUid, editRef, { aspectRatio: POSTER_RATIOS.portrait },
      );
      bytes = generated.bytes;
      if (!opts.verify) break;

      verdict = await verifyPosterText(env, generated.bytes, copy, attempt);
      void track(env, opts.actorUid, "poster_verify", "avatok", {
        listing_id: opts.listingId, ratio: "portrait", attempt,
        ok: verdict.ok, skipped: !!verdict.skipped,
        title_score: verdict.title_score ?? null,
        extra_text_found: verdict.extra_text_found?.length ?? 0,
        mismatches: (verdict.mismatches || []).join(","),
        style_version: POSTER_STYLE_VERSION,
      });
      if (verdict.ok) break;
      hint = verdict.retry_hint || "";
    }

    // ---------------------------------------------------------------
    // 2. Fallback: the model would not letter it correctly, so stop asking.
    //    One textless render, and the client draws the copy over it.
    // ---------------------------------------------------------------
    if (opts.verify && opts.composeFallback && verdict && !verdict.ok && !verdict.skipped) {
      const artOnly = buildPosterArtOnlyPrompt(opts.row, opts.subject);
      const generated = await generateImage(
        env, "", artOnly, opts.actorUid, editRef, { aspectRatio: POSTER_RATIOS.portrait },
      );
      bytes = generated.bytes;
      lettering = "overlay";
      void track(env, opts.actorUid, "poster_compose_fallback", "avatok", {
        listing_id: opts.listingId, attempts_used: used,
        reason: (verdict.mismatches || []).join(",") || "unknown",
        style_version: POSTER_STYLE_VERSION,
      });
    }

    if (!bytes) throw new Error("no image produced");

    const portrait = await putPoster(env, opts.ownerUid, opts.listingId, "portrait", bytes);
    const variants: PosterVariants = { portrait };

    // [POSTER-CHECKPOINT-1] Build the terminal result NOW, from the portrait
    // alone, and hand it to the caller to persist. Everything below only ADDS
    // variants; if the isolate dies from here on, the listing already has a
    // complete, usable poster instead of nothing. See `onPortrait`.
    const settle = (): { poster: PosterState; coverMedia: CoverMediaItem[] } => {
      const poster: PosterState = {
        ...base,
        status: "draft",
        url: portrait.url,
        key: portrait.key,
        bytes: portrait.bytes,
        variants: { ...variants },
        verify: verdict,
        lettering,
        attempt: used,
        completed_at: Date.now(),
      };
      let covers: any[] = [];
      try {
        const raw = opts.row?.cover_media;
        covers = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : [];
      } catch { covers = []; }
      covers = Array.isArray(covers)
        ? covers.filter((c) => c && c.url !== portrait.url && c.source !== "ai_poster")
        : [];
      return {
        poster,
        coverMedia: [
          { type: "image", url: portrait.url, source: "ai_poster", generated: true },
          ...covers,
        ],
      };
    };

    if (opts.onPortrait) {
      try {
        await opts.onPortrait(settle());
      } catch (e) {
        // Never fatal. The final write below is still coming, and losing the
        // checkpoint only costs us the safety net, not the poster.
        void track(env, opts.actorUid, "poster_checkpoint", "avatok", {
          listing_id: opts.listingId, ok: false,
          error: String((e as any)?.message || e).slice(0, 180),
          style_version: POSTER_STYLE_VERSION,
        });
      }
    }

    // ---------------------------------------------------------------
    // 3. Tablet and wide, REFRAMED from the approved portrait rather than
    //    generated fresh. Three independent generations would give three
    //    different-looking posters and three chances to letter it wrong; an
    //    editRef reframe carries the artwork and the lettering across, so the
    //    ratios read as one object and normally verify first time.
    //
    //    A variant that fails is DROPPED, never fatal — the client falls back
    //    to the portrait for that breakpoint, which is merely less ideal.
    // ---------------------------------------------------------------
    if (opts.variants) {
      const ref = toDataUrl(bytes);
      for (const ratio of ["tablet", "wide"] as const) {
        try {
          const reframe = [
            "Re-frame this exact poster to a", POSTER_RATIOS[ratio], "aspect ratio.",
            "Keep the identical artwork, the identical hand-painted lettering, the",
            "identical ink palette and the identical print texture — extend the",
            "painted background outwards to fill the new shape. Do not redraw the",
            "subject, do not change any words, and do not add any new text.",
          ].join(" ");
          const g = await generateImage(
            env, "", reframe, opts.actorUid, ref, { aspectRatio: POSTER_RATIOS[ratio] },
          );
          variants[ratio] = await putPoster(env, opts.ownerUid, opts.listingId, ratio, g.bytes);
        } catch (e) {
          void track(env, opts.actorUid, "poster_generate", "avatok", {
            listing_id: opts.listingId, ratio, ok: false,
            error: String((e as any)?.message || e).slice(0, 180),
            style_version: POSTER_STYLE_VERSION,
          });
        }
      }
    }

    const settled = settle();

    void track(env, opts.actorUid, "poster_generate", "avatok", {
      listing_id: opts.listingId, ratio: "portrait", ok: true,
      attempt: used, lettering, verified: !!opts.verify,
      variants: Object.keys(variants).join(","),
      latency_ms: Date.now() - t0, style_version: POSTER_STYLE_VERSION,
    });

    return settled;
  } catch (e) {
    const poster: PosterState = {
      ...base,
      status: "failed",
      error: String((e as any)?.message || "provider unavailable").slice(0, 180),
    };
    void track(env, opts.actorUid, "poster_generate", "avatok", {
      listing_id: opts.listingId, ratio: "portrait", ok: false,
      error: poster.error, latency_ms: Date.now() - t0,
      style_version: POSTER_STYLE_VERSION,
    });
    return { poster, coverMedia: null };
  }
}
