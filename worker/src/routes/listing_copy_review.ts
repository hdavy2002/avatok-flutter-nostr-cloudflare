// [CARD-AI-REVIEW-1 2026-09-03, owner decision] AI review of a listing's COPY,
// called from the creator wizard before publish.
//
//   POST /api/listings/copy-review   (auth)
//
// The owner's ask, verbatim: "I want all these cards to be reviewed by ai before
// it gets published. this means when filling the form. Ai will auto adjust the
// title size, auto increase or decrease the description."
//
// What this route is FOR: making the marketplace card render evenly. A card
// gives the title two lines and the blurb two lines (components/ListingTile.tsx,
// [CARD-UNIFORM-1]) — anything longer is clipped, anything much shorter leaves
// the tile looking half-built next to its neighbours. So the target lengths
// below are not taste; they are the card's geometry.
//
// THREE RULES THIS ROUTE KEEPS, in order of how badly each bites:
//
//  1. IT SUGGESTS, IT NEVER SAVES. The response is returned to the wizard and
//     the creator accepts or rejects each field. Nothing here writes to
//     `listings`. A route that silently rewrote a creator's own words into their
//     published listing would be putting words in their mouth.
//  2. THE DETERMINISTIC PASS ALWAYS RUNS; THE MODEL IS THE OPTIONAL HALF. Length
//     fitting, whitespace collapse and sentence-boundary trimming are plain
//     string work and run with no provider call. If the model is off, over
//     budget, unreachable or answers with junk, the creator still gets a
//     correctly-sized title and description — `source` says which half produced
//     the answer so the UI never claims an AI review that did not happen.
//  3. IT NEVER INVENTS FACTS. The prompt may compress, expand from what is
//     already written, and fix case — it may not add a price, a time, a
//     credential, a guarantee or a claim about the creator. An expanded
//     description that invents "10 years of experience" is a lie the platform
//     published on a creator's behalf.
//
// Flag: `listingAiReviewEnabled` (DEFAULTS in routes/config.ts). Declared in the
// PlatformConfig interface AND in DEFAULTS in the same change — an undeclared
// key is a FAKE flag that `putConfig` rejects with 400 and can never be flipped
// (CLAUDE.md). With the flag off, the deterministic pass still answers; only the
// model call is skipped.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { readConfig } from "./config";
import { avaReason } from "../lib/ava_reason";
import { guardInput, guardOutput } from "../lib/ai_gate";
import { track } from "../hooks";

/** The card's geometry, in characters. Derived from ListingTile.tsx: an Anton
 *  title at 1.4375rem clamped to 2 lines, and a 0.875rem body clamped to 2. */
const TITLE_MAX = 58;
const TITLE_MIN = 12;
const BLURB_MAX = 110;
const BLURB_MIN = 45;
/** The detail page's body, not the card's — a much looser range. */
const DESC_MAX = 900;
const DESC_MIN = 220;

export interface CopyReviewField {
  /** What the creator typed, normalised (whitespace collapsed, trimmed). */
  original: string;
  /** What we suggest. Equal to `original` when nothing needed changing. */
  suggested: string;
  /** Human-readable reason, or null when unchanged. */
  note: string | null;
}

export interface CopyReviewResult {
  title: CopyReviewField;
  blurb: CopyReviewField;
  description: CopyReviewField;
  /** 'ai' when the model produced the suggestions, 'rules' when only the
   *  deterministic pass ran. The UI prints this — never claim an AI review that
   *  did not happen. */
  source: "ai" | "rules";
}

function squash(s: unknown): string {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

/** Cut to `max` characters on a word boundary, never mid-word, no ellipsis
 *  (the card clips visually; a "…" inside the string would double up). */
function clampWords(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:–—-]+$/, "");
}

/** Cut to `max` characters at the last SENTENCE end, so a trimmed description
 *  still reads as finished prose rather than stopping mid-thought. */
function clampSentences(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  if (stop > max * 0.5) return cut.slice(0, stop + 1);
  return clampWords(cut, max);
}

/** The deterministic half — rule 2. Length only: it never rewrites wording,
 *  because a rule cannot know what the creator meant. */
function rulesPass(input: { title: string; blurb: string; description: string }): CopyReviewResult {
  const title = squash(input.title);
  const blurb = squash(input.blurb);
  const description = String(input.description ?? "").replace(/[ \t]+/g, " ").trim();

  const titleFit = clampWords(title, TITLE_MAX);
  const blurbFit = clampWords(blurb, BLURB_MAX);
  const descFit = clampSentences(description, DESC_MAX);

  return {
    title: {
      original: title,
      suggested: titleFit,
      note: titleFit !== title
        ? `Trimmed to ${TITLE_MAX} characters — the card gives a title two lines and clips the rest.`
        : title.length < TITLE_MIN ? "Short for a card title — a few more words read better in the grid." : null,
    },
    blurb: {
      original: blurb,
      suggested: blurbFit,
      note: blurbFit !== blurb
        ? `Trimmed to ${BLURB_MAX} characters — the card gives the blurb two lines.`
        : blurb.length === 0 ? "Empty — the card falls back to a generic line for your lane."
          : blurb.length < BLURB_MIN ? "Short — the blurb has room for about twice this." : null,
    },
    description: {
      original: description,
      suggested: descFit,
      note: descFit !== description
        ? `Trimmed to ${DESC_MAX} characters at a sentence break.`
        : description.length < DESC_MIN ? "Thin — buyers decide on this paragraph; aim for a few sentences." : null,
    },
    source: "rules",
  };
}

/** Pull the first JSON object out of a model reply that may be fenced or
 *  prefixed with chatter. Returns null on anything unparseable — the caller
 *  then keeps the deterministic result rather than guessing. */
function parseJsonObject(raw: string): Record<string, unknown> | null {
  const text = String(raw ?? "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(text.slice(start, end + 1));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch { return null; }
}

/**
 * [COPY-PIPELINE-1 2026-09-05] The review, callable from the SERVER.
 *
 * Extracted from the route body unchanged so the submit path can run the exact
 * same pass a creator gets in the wizard. Previously this logic was reachable
 * only over HTTP by a signed-in creator clicking a button, which is why the
 * polish was optional in practice: a creator who never clicked simply shipped
 * their raw text, and nothing in the pipeline ever looked at it again.
 *
 * Still suggests rather than saves — the CALLER decides what to do with the
 * result. That is deliberate: this function has no idea whether it is being run
 * for a preview, a submit, or an admin regenerate.
 */
export async function reviewListingCopy(
  env: Env,
  uid: string,
  input: { title: string; blurb: string; description: string },
  meta: { kind?: string; category?: string; freeEntry?: boolean } = {},
): Promise<CopyReviewResult> {
  const kind = squash(meta.kind) || "live_event";
  const category = squash(meta.category);
  const freeEntry = Boolean(meta.freeEntry);
  const u = { uid };

  // Rule 2: this result is the floor. Everything below can only improve on it.
  let out = rulesPass(input);

  const cfg = await readConfig(env);
  const modelAllowed = cfg.aiEnabled && (cfg as any).listingAiReviewEnabled !== false;
  const hasSomethingToReview = input.title.length > 0 || input.blurb.length > 0 || input.description.length > 0;

  if (modelAllowed && hasSomethingToReview) {
    const creatorText = `${input.title}\n${input.blurb}\n${input.description}`;
    try {
      const gate = await guardInput(env, creatorText);
      if (gate.ok) {
        const system =
          "You are a marketplace copy editor for avaTOK, an Indian live-session marketplace. " +
          "You edit ONLY for length, clarity and sentence case; you NEVER invent facts. " +
          "Do not add prices, dates, times, durations, guarantees, credentials, ratings or claims about the seller. " +
          "If a field is empty, leave it empty rather than writing one from nothing — except the description, which " +
          "you may expand ONLY by restating what the title and blurb already say. " +
          "Keep the creator's own voice, including Hinglish. Never use emoji.";
        const user =
          `Listing type: ${kind}${category ? `, category: ${category}` : ""}${freeEntry ? ", free entry" : ""}.\n` +
          `TITLE (target ${TITLE_MIN}-${TITLE_MAX} chars, fits two lines on the card): ${JSON.stringify(input.title)}\n` +
          `BLURB (target ${BLURB_MIN}-${BLURB_MAX} chars, one punchy line): ${JSON.stringify(input.blurb)}\n` +
          `DESCRIPTION (target ${DESC_MIN}-${DESC_MAX} chars): ${JSON.stringify(input.description)}\n` +
          `Respond with ONLY JSON: {"title":"…","blurb":"…","description":"…",` +
          `"notes":{"title":"…","blurb":"…","description":"…"}} ` +
          `where each note is one short sentence saying what you changed, or "" when unchanged.`;

        const raw = await avaReason(env, {
          role: "listing", capability: "listing_copy_review", trigger: "wizard_review",
          feature: "listing_copy_review", uid: u.uid,
          system, user, temperature: 0.2, maxTokens: 700, timeoutMs: 20000,
        });
        const parsed = parseJsonObject(String(raw ?? ""));
        if (parsed) {
          const outGate = await guardOutput(env, `${parsed.title ?? ""} ${parsed.blurb ?? ""} ${parsed.description ?? ""}`);
          if (outGate.ok) {
            const notes = (parsed.notes ?? {}) as Record<string, unknown>;
            // Every model string is put back through the SAME deterministic
            // clamp. The model is asked for a length and often misses it, and a
            // suggestion that overflows the card is the exact bug being fixed.
            const t = clampWords(squash(parsed.title), TITLE_MAX) || out.title.suggested;
            const b = clampWords(squash(parsed.blurb), BLURB_MAX) || out.blurb.suggested;
            const d = clampSentences(String(parsed.description ?? "").trim(), DESC_MAX) || out.description.suggested;
            out = {
              title: { original: input.title, suggested: t, note: t !== input.title ? (squash(notes.title) || "Adjusted to fit the card.") : null },
              blurb: { original: input.blurb, suggested: b, note: b !== input.blurb ? (squash(notes.blurb) || "Adjusted to fit the card.") : null },
              description: { original: input.description, suggested: d, note: d !== input.description ? (squash(notes.description) || "Adjusted for length.") : null },
              source: "ai",
            };
          }
        }
      }
    } catch {
      // Rule 2 again: a provider failure is not an error for the creator, it is
      // a downgrade to the deterministic result they already have.
    }
  }

  // [WEB-POSTHOG-1] Every surface emits. `source` is the value that matters:
  // a run of source=rules means the model half is silently down.
  try {
    // track(env, uid, event, app_name, props) — five args, in THAT order. Three
    // args puts the props object in the `app_name` slot and the event goes out
    // malformed (CLAUDE.md, the 2026-08-01 green-deploy incident).
    track(env, u.uid, "listing_copy_review", "web", {
      source: out.source,
      kind,
      title_changed: out.title.suggested !== out.title.original,
      blurb_changed: out.blurb.suggested !== out.blurb.original,
      description_changed: out.description.suggested !== out.description.original,
      title_len: out.title.suggested.length,
      blurb_len: out.blurb.suggested.length,
      description_len: out.description.suggested.length,
    });
  } catch { /* telemetry is never the reason a review fails */ }

  return out;
}

export async function listingCopyReview(req: Request, env: Env): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return json({ error: u.error }, u.status);

  let body: any = {};
  try { body = await req.json(); } catch { /* empty body → rules pass on empty strings */ }

  const out = await reviewListingCopy(env, u.uid, {
    title: squash(body?.title),
    blurb: squash(body?.blurb),
    description: String(body?.description ?? "").trim(),
  }, {
    kind: squash(body?.kind),
    category: squash(body?.category),
    freeEntry: Boolean(body?.free_entry),
  });
  return json(out);
}
