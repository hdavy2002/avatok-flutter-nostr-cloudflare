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
//
// ── [COPY-AI-STATUS-1 2026-09-13] WHY THE MODEL HALF WAS ALWAYS SILENT ────────
// Every response came back `source:"rules"` and the wizard printed "LENGTH CHECK
// ONLY — AVA WAS UNAVAILABLE", while PostHog showed the matching `ava_reason_call`
// as ok:true, provider cf_ai, tokens_out 700 — i.e. the model ran and was BILLED.
// The reasoner primary `@cf/google/gemma-4-26b-a4b-it` answers in the OpenAI
// chat-completions shape (`choices[0].message.content`), and lib/ava_reason/
// types.ts `cfText()` read only `response`, so `avaReason()` resolved to "" and
// `parseJsonObject("")` returned null. Fixed in cfText (see [REASONER-CHOICES-1]).
//
// [COPY-LADDER-INVERT-1] And because gemma-4 is a thinking model that cannot be
// told to stop thinking on Workers AI, this feature's ladder is now inverted in
// lib/ava_reason/policy.ts: non-thinking OpenRouter google/gemini-2.5-flash-lite
// PRIMARY, gemma-4 ALT. That is a UX decision, not a bug fix — ~35 s per button
// press across three buttons, with step 2 gated on all three, is not a creator
// flow anyone would ship. The two actual defects are fixed separately and stay
// fixed for every other caller.
//
// The reason it took a production dig to find is THIS file: the model half sat
// inside a bare `catch {}` whose only content was a comment, and all three
// silent-downgrade branches (`gate.ok === false`, a throw, `parsed === null`)
// collapsed into one indistinguishable `source:"rules"`. So the route now
// reports `ai_status`, a non-sensitive machine code, on every response, and
// records the real reason via trackException/track. Provider error strings,
// prompts and keys stay server-side — the client only ever sees the code.
//
// ── [COPY-FIELD-1 2026-09-13, owner decision] ONE FIELD AT A TIME ─────────────
// Optional `field: "title" | "blurb" | "description"` in the body. When present
// the route reviews ONLY that field and returns the other two keys as `null`
// (NOT as unchanged-suggestion objects), so a client physically cannot render a
// card for a field the creator never asked about — "Write my title for me" used
// to pop all three. When absent the behaviour is exactly as before, so every
// already-deployed client keeps working.
//
// And the quality bug that per-field requests exposed: asking to "review" an
// EMPTY field produced "Empty — the card falls back to a generic line for your
// lane." next to an unchanged empty value, which the UI then decorated with
// "Nothing to change — this one already fits." Nonsense. A creator who clicks
// "Write my blurb for me" on an empty blurb wants it WRITTEN, from the listing's
// own context. The system prompt's "if a field is empty, leave it empty" rule is
// right for a bulk review and wrong for an explicit per-field request, so it is
// now conditional. Rule 3 is untouched in both modes: a written blurb or
// description may only restate what the title/other fields already say — never
// a price, date, duration, guarantee, rating or credential.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { readConfig } from "./config";
import { avaReason } from "../lib/ava_reason";
import { guardInput, guardOutput } from "../lib/ai_gate";
import { track, trackException } from "../hooks";

/** The card's geometry, in characters. Derived from ListingTile.tsx: an Anton
 *  title at 1.4375rem clamped to 2 lines, and a 0.875rem body clamped to 2. */
const TITLE_MAX = 58;
const TITLE_MIN = 12;
const BLURB_MAX = 110;
const BLURB_MIN = 45;
/** The detail page's body, not the card's — a much looser range. */
const DESC_MAX = 900;
const DESC_MIN = 220;

/** [COPY-FIELD-1] The three reviewable fields, by wire name. */
export type CopyReviewFieldName = "title" | "blurb" | "description";
const FIELD_NAMES: readonly CopyReviewFieldName[] = ["title", "blurb", "description"] as const;

/**
 * [COPY-AI-STATUS-1] Why the model half did or did not produce this answer, as a
 * stable machine code the wizard can turn into a truthful line. NON-SENSITIVE by
 * construction: it never carries a provider message, a status code, a prompt or a
 * key — those go to trackException, server-side only.
 *
 *   ok                 — the model answered and its answer was used (source:"ai").
 *   disabled           — aiEnabled / listingAiReviewEnabled is off, or there was
 *                        nothing to review. No provider call was made.
 *   moderation_blocked — the safety gate refused the creator's input, or refused
 *                        the model's own output. The rules answer still stands.
 *   provider_error     — the reasoner ladder threw (both rungs). An outage.
 *   bad_json           — the model answered but not with parseable JSON (this is
 *                        also what an empty completion looks like from here).
 */
export type CopyReviewAiStatus =
  | "ok"
  | "disabled"
  | "moderation_blocked"
  | "provider_error"
  | "bad_json";

export interface CopyReviewField {
  /** What the creator typed, normalised (whitespace collapsed, trimmed). */
  original: string;
  /** What we suggest. Equal to `original` when nothing needed changing. */
  suggested: string;
  /** Human-readable reason, or null when unchanged. */
  note: string | null;
}

export interface CopyReviewResult {
  /** null when a per-field request did not ask about this field ([COPY-FIELD-1]). */
  title: CopyReviewField | null;
  blurb: CopyReviewField | null;
  description: CopyReviewField | null;
  /** 'ai' when the model produced the suggestions, 'rules' when only the
   *  deterministic pass ran. The UI prints this — never claim an AI review that
   *  did not happen. */
  source: "ai" | "rules";
  /** [COPY-AI-STATUS-1] Why — so the UI can say something truer than "unavailable". */
  ai_status: CopyReviewAiStatus;
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

/** The per-field deterministic verdicts — one function each so `rulesPass` can
 *  build a whole result or a single field from the SAME code. Length only: they
 *  never rewrite wording, because a rule cannot know what the creator meant. */
function titleRule(title: string): CopyReviewField {
  const fit = clampWords(title, TITLE_MAX);
  return {
    original: title,
    suggested: fit,
    note: fit !== title
      ? `Trimmed to ${TITLE_MAX} characters — the card gives a title two lines and clips the rest.`
      : title.length < TITLE_MIN ? "Short for a card title — a few more words read better in the grid." : null,
  };
}

function blurbRule(blurb: string): CopyReviewField {
  const fit = clampWords(blurb, BLURB_MAX);
  return {
    original: blurb,
    suggested: fit,
    note: fit !== blurb
      ? `Trimmed to ${BLURB_MAX} characters — the card gives the blurb two lines.`
      : blurb.length === 0 ? "Empty — the card falls back to a generic line for your lane."
        : blurb.length < BLURB_MIN ? "Short — the blurb has room for about twice this." : null,
  };
}

function descriptionRule(description: string): CopyReviewField {
  const fit = clampSentences(description, DESC_MAX);
  return {
    original: description,
    suggested: fit,
    note: fit !== description
      ? `Trimmed to ${DESC_MAX} characters at a sentence break.`
      : description.length < DESC_MIN ? "Thin — buyers decide on this paragraph; aim for a few sentences." : null,
  };
}

/** Normalise the three raw inputs the same way every path expects. */
function normalise(input: { title: string; blurb: string; description: string }) {
  return {
    title: squash(input.title),
    blurb: squash(input.blurb),
    description: String(input.description ?? "").replace(/[ \t]+/g, " ").trim(),
  };
}

/** The deterministic half — rule 2, and the FLOOR every answer builds on. When
 *  `field` is given, the other two keys are null rather than unchanged objects
 *  ([COPY-FIELD-1]); the per-field verdict itself is byte-identical to the one
 *  the all-three pass would have produced. */
function rulesPass(
  input: { title: string; blurb: string; description: string },
  field?: CopyReviewFieldName | null,
): CopyReviewResult {
  const n = normalise(input);
  const want = (f: CopyReviewFieldName) => !field || field === f;
  return {
    title: want("title") ? titleRule(n.title) : null,
    blurb: want("blurb") ? blurbRule(n.blurb) : null,
    description: want("description") ? descriptionRule(n.description) : null,
    source: "rules",
    ai_status: "disabled",
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

/** Accept the body of a per-field request only when it names one of the three
 *  real fields. An unknown string is treated as ABSENT (→ all three), never as
 *  an error: a client on a newer build asking for a field we do not have should
 *  still get a usable answer rather than a 400. */
export function parseFieldName(v: unknown): CopyReviewFieldName | null {
  const s = squash(v).toLowerCase();
  return (FIELD_NAMES as readonly string[]).includes(s) ? (s as CopyReviewFieldName) : null;
}

const FIELD_SPEC: Record<CopyReviewFieldName, { label: string; target: string; clamp: (s: string) => string }> = {
  title: {
    label: "TITLE",
    target: `${TITLE_MIN}-${TITLE_MAX} characters, fits two lines on the card`,
    clamp: (s) => clampWords(squash(s), TITLE_MAX),
  },
  blurb: {
    label: "BLURB",
    target: `${BLURB_MIN}-${BLURB_MAX} characters, one punchy line`,
    clamp: (s) => clampWords(squash(s), BLURB_MAX),
  },
  description: {
    label: "DESCRIPTION",
    target: `${DESC_MIN}-${DESC_MAX} characters`,
    clamp: (s) => clampSentences(String(s ?? "").trim(), DESC_MAX),
  },
};

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
 *
 * `meta.field` ([COPY-FIELD-1]) narrows the whole pass to one field. Server
 * callers (listings.ts `polishListingCopy`) omit it and get all three, as before.
 */
export async function reviewListingCopy(
  env: Env,
  uid: string,
  input: { title: string; blurb: string; description: string },
  meta: { kind?: string; category?: string; freeEntry?: boolean; field?: CopyReviewFieldName | null } = {},
): Promise<CopyReviewResult> {
  const kind = squash(meta.kind) || "live_event";
  const category = squash(meta.category);
  const freeEntry = Boolean(meta.freeEntry);
  const field = meta.field ?? null;
  const u = { uid };
  const n = normalise(input);

  // Rule 2: this result is the floor. Everything below can only improve on it.
  let out = rulesPass(input, field);

  const cfg = await readConfig(env);
  const modelAllowed = cfg.aiEnabled && (cfg as any).listingAiReviewEnabled !== false;
  // In per-field WRITE mode the requested field is empty by definition, so
  // "something to review" means the listing has SOME context to write from.
  const hasSomethingToReview = n.title.length > 0 || n.blurb.length > 0 || n.description.length > 0;

  // [COPY-AI-STATUS-1] One variable, set on every path, returned to the client.
  let aiStatus: CopyReviewAiStatus = "disabled";
  /** Non-sensitive detail for OUR telemetry only — never put on the response. */
  let failDetail: string | null = null;

  if (modelAllowed && hasSomethingToReview) {
    // Only the copy actually under review is sent to the safety gate — a
    // per-field request must not be blocked by a field it never asked about.
    const reviewed = field ? n[field] : `${n.title}\n${n.blurb}\n${n.description}`;
    // [COPY-FIELD-1] WRITE mode: the creator clicked "Write my <field> for me" on
    // an empty field. The model must author it from the listing's other context
    // rather than "review" a blank string into a blank string.
    const writeMode = Boolean(field) && reviewed.length === 0;
    const gateText = writeMode ? `${n.title}\n${n.blurb}\n${n.description}` : reviewed;
    try {
      const gate = await guardInput(env, gateText);
      if (!gate.ok) {
        aiStatus = "moderation_blocked";
        failDetail = `input:${gate.reason ?? "unsafe"}`;
      } else {
        const { system, user } = buildPrompt({ n, field, writeMode, kind, category, freeEntry });

        const raw = await avaReason(env, {
          role: "listing", capability: "listing_copy_review", trigger: "wizard_review",
          feature: "listing_copy_review", uid: u.uid,
          system, user, temperature: 0.2,
          // [COPY-LADDER-INVERT-1] Sized for a NON-THINKING model. The primary
          // rung for `feature: "listing_copy_review"` is now OpenRouter
          // google/gemini-2.5-flash-lite (see lib/ava_reason/policy.ts), which
          // emits the answer and nothing else — so the budget only has to cover
          // the JSON we actually asked for.
          //
          // Honest arithmetic rather than a round number: the clamps above cap
          // the payload at title 58 + blurb 110 + description 900 characters,
          // plus one short note each and the JSON scaffolding — about 1.4 KB, or
          // ~400 output tokens, for the three-field shape. A per-field reply is
          // at worst the description one, ~1 KB / ~300 tokens. 900 and 600 give
          // roughly 2x headroom on each without pretending to need more.
          //
          // These deliberately do NOT budget for the gemma-4 ALT rung. That
          // model is a thinking model whose scratchpad is billed against the same
          // completion budget and emitted first (the whole story, with the
          // measurements, is in policy.ts [COPY-LADDER-INVERT-1]); it needs ~1900
          // tokens for a single field and spirals past 5000 on three. Paying that
          // ceiling on every call to make a fallback rung comfortable would put
          // the ~35 s wait back on the common path. So if the ALT does fire it
          // will most likely truncate to an empty answer — which now surfaces
          // honestly and FAST as `ai_status:"bad_json"` on top of the
          // deterministic floor, instead of a ninety-second stall.
          maxTokens: field ? 600 : 900,
          // Applies for real now: the OpenRouter adapter honours req.timeoutMs
          // (AbortSignal.timeout), while the cf_ai adapter ignores it entirely —
          // so while Workers AI was the primary rung this number did nothing.
          // 15 s is a ceiling, not a target: flash-lite answers a prompt this
          // size in single-digit seconds, and a call still open at 15 s is stuck,
          // not slow. Keeping it tight matters because a primary that hangs to
          // its deadline is time spent BEFORE the ALT rung even starts.
          timeoutMs: 15000,
        });
        const parsed = parseJsonObject(String(raw ?? ""));
        if (!parsed) {
          aiStatus = "bad_json";
          failDetail = String(raw ?? "").trim().length ? "unparseable" : "empty_completion";
        } else {
          const picked = pickSuggestions(parsed, field, out, n);
          const outGate = await guardOutput(env, Object.values(picked).map((p) => p?.suggested ?? "").join(" "));
          if (!outGate.ok) {
            aiStatus = "moderation_blocked";
            failDetail = `output:${outGate.reason ?? "unsafe"}`;
          } else {
            out = {
              title: out.title ? picked.title ?? out.title : null,
              blurb: out.blurb ? picked.blurb ?? out.blurb : null,
              description: out.description ? picked.description ?? out.description : null,
              source: "ai",
              ai_status: "ok",
            };
            aiStatus = "ok";
          }
        }
      }
    } catch (err) {
      // Rule 2 again: a provider failure is not an error for the creator, it is
      // a downgrade to the deterministic result they already have. But it is NOT
      // invisible any more — the reason goes to PostHog error tracking, and the
      // client gets a code (never the provider's message).
      aiStatus = "provider_error";
      failDetail = "throw";
      try {
        void trackException(env, err, {
          uid: u.uid, route: "listings.copy-review", method: "POST", handled: true,
          app_name: "web",
          extra: { stage: "ava_reason", feature: "listing_copy_review", field: field ?? "all", kind },
        });
      } catch { /* telemetry is never the reason a review fails */ }
    }
  }

  out.ai_status = aiStatus;

  // [COPY-FIELD-1] An explicit "Write my <field> for me" that the model could not
  // answer must NOT come back reading as "nothing to change, this one already
  // fits" — that was the exact nonsense the empty-field bug produced. Say plainly
  // that nothing was written; `ai_status` above carries the machine-readable why.
  if (field && aiStatus !== "ok") {
    const f = out[field];
    if (f && f.original.length === 0 && f.suggested.length === 0) {
      f.note = "Nothing here yet — Ava could not draft one just now, so write a line yourself.";
    }
  }

  // [COPY-AI-STATUS-1] A non-`ok` status that is not a provider throw never
  // reached trackException above, and a run of them is exactly the signal that
  // went missing for a week. Emit it as a first-class event so a moderation
  // block or a junk completion is as visible as an outage.
  if (aiStatus !== "ok" && aiStatus !== "disabled") {
    try {
      track(env, u.uid, "listing_copy_review_degraded", "web", {
        ai_status: aiStatus,
        detail: failDetail,
        field: field ?? "all",
        kind,
      });
    } catch { /* best-effort */ }
  }

  // [WEB-POSTHOG-1] Every surface emits. `source` is the value that matters:
  // a run of source=rules means the model half is silently down.
  try {
    // track(env, uid, event, app_name, props) — five args, in THAT order. Three
    // args puts the props object in the `app_name` slot and the event goes out
    // malformed (CLAUDE.md, the 2026-08-01 green-deploy incident).
    track(env, u.uid, "listing_copy_review", "web", {
      source: out.source,
      ai_status: out.ai_status,
      field: field ?? "all",
      kind,
      title_changed: !!out.title && out.title.suggested !== out.title.original,
      blurb_changed: !!out.blurb && out.blurb.suggested !== out.blurb.original,
      description_changed: !!out.description && out.description.suggested !== out.description.original,
      title_len: out.title?.suggested.length ?? null,
      blurb_len: out.blurb?.suggested.length ?? null,
      description_len: out.description?.suggested.length ?? null,
    });
  } catch { /* telemetry is never the reason a review fails */ }

  return out;
}

/**
 * The prompt. `field` scopes it to ONE field; `writeMode` flips the empty-field
 * rule from "leave it empty" (correct for a bulk review, where an unasked-for
 * invention is a lie) to "write it" (correct for an explicit "Write my blurb for
 * me", where leaving it empty is a non-answer). Rule 3 holds in BOTH modes.
 */
function buildPrompt(args: {
  n: { title: string; blurb: string; description: string };
  field: CopyReviewFieldName | null;
  writeMode: boolean;
  kind: string;
  category: string;
  freeEntry: boolean;
}): { system: string; user: string } {
  const { n, field, writeMode, kind, category, freeEntry } = args;

  const base =
    "You are a marketplace copy editor for avaTOK, an Indian live-session marketplace. " +
    "You edit ONLY for length, clarity and sentence case; you NEVER invent facts. " +
    "Do not add prices, dates, times, durations, guarantees, credentials, ratings or claims about the seller. " +
    "Keep the creator's own voice, including Hinglish. Never use emoji.";

  const emptyRule = writeMode
    // Per-field, explicitly requested, currently empty: WRITE it. Rule 3 is the
    // hard boundary — the new text may only restate the context given below.
    ? ` The ${field} is EMPTY and the creator has explicitly asked you to WRITE it. ` +
      "Write it from the CONTEXT below and from nothing else: restate, in fewer or different words, " +
      "only what the other fields and the listing type already say. If the context does not support a " +
      "claim, it does not go in. Never state a price, a date, a time, a duration, a guarantee, a rating " +
      "or a credential, even if one would sound plausible."
    : field
      // Per-field, non-empty: a review, and only of this one field.
      ? ` Edit ONLY the ${field}. Return only that field.` +
        (field === "description"
          ? " You may expand it ONLY by restating what the title and blurb already say."
          : "")
      // Bulk review: the original rule, unchanged.
      : " If a field is empty, leave it empty rather than writing one from nothing — except the description, which " +
        "you may expand ONLY by restating what the title and blurb already say.";

  const system = base + emptyRule;

  const header =
    `Listing type: ${kind}${category ? `, category: ${category}` : ""}${freeEntry ? ", free entry" : ""}.\n`;

  if (!field) {
    const user =
      header +
      `TITLE (target ${FIELD_SPEC.title.target}): ${JSON.stringify(n.title)}\n` +
      `BLURB (target ${FIELD_SPEC.blurb.target}): ${JSON.stringify(n.blurb)}\n` +
      `DESCRIPTION (target ${FIELD_SPEC.description.target}): ${JSON.stringify(n.description)}\n` +
      `Respond with ONLY JSON: {"title":"…","blurb":"…","description":"…",` +
      `"notes":{"title":"…","blurb":"…","description":"…"}} ` +
      `where each note is one short sentence saying what you changed, or "" when unchanged.`;
    return { system, user };
  }

  const spec = FIELD_SPEC[field];
  // CONTEXT is included only where the field genuinely cannot be produced
  // without it: writing an empty field from scratch, and the description (which
  // is allowed to restate the title and blurb). A plain review of a non-empty
  // title or blurb sends that field and nothing else.
  const needsContext = writeMode || field === "description";
  const context = needsContext
    ? "CONTEXT — background only, never edit or return these:\n" +
      FIELD_NAMES.filter((f) => f !== field && n[f].length > 0)
        .map((f) => `  ${FIELD_SPEC[f].label}: ${JSON.stringify(n[f])}\n`)
        .join("")
    : "";

  const user =
    header +
    context +
    `${writeMode ? "WRITE THIS FIELD" : "EDIT THIS FIELD"} — ${spec.label} (target ${spec.target}): ` +
    `${JSON.stringify(n[field])}\n` +
    `Respond with ONLY JSON: {"text":"…","note":"…"} where "text" is the ${field} and "note" is one short ` +
    `sentence saying what you ${writeMode ? "wrote" : "changed"}, or "" when unchanged. ` +
    `Do not return any other field.`;

  return { system, user };
}

/**
 * Turn the model's JSON into suggestion objects for exactly the fields under
 * review. Every model string goes back through the SAME deterministic clamp: the
 * model is asked for a length and often misses it, and a suggestion that
 * overflows the card is the exact bug this route exists to fix.
 *
 * A field the model left blank falls back to the deterministic suggestion, so a
 * partial answer degrades per field instead of discarding the whole reply.
 */
function pickSuggestions(
  parsed: Record<string, unknown>,
  field: CopyReviewFieldName | null,
  floor: CopyReviewResult,
  n: { title: string; blurb: string; description: string },
): Partial<Record<CopyReviewFieldName, CopyReviewField>> {
  const notes = (parsed.notes ?? {}) as Record<string, unknown>;
  const targets: CopyReviewFieldName[] = field ? [field] : [...FIELD_NAMES];
  const picked: Partial<Record<CopyReviewFieldName, CopyReviewField>> = {};

  for (const f of targets) {
    const floorField = floor[f];
    if (!floorField) continue;
    // Per-field mode asks for {"text","note"}; bulk mode for {"<field>","notes"}.
    // Accept either shape from either mode — a model that answers in the other
    // one is still giving us a usable answer.
    const rawText = field ? (parsed.text ?? parsed[f]) : parsed[f];
    const rawNote = field ? (parsed.note ?? notes[f]) : notes[f];
    const suggested = FIELD_SPEC[f].clamp(String(rawText ?? "")) || floorField.suggested;
    const wrote = n[f].length === 0 && suggested.length > 0;
    picked[f] = {
      original: n[f],
      suggested,
      note: suggested !== n[f]
        ? (squash(rawNote) || (wrote
          ? "Written from the rest of your listing — check it before you accept."
          : f === "description" ? "Adjusted for length." : "Adjusted to fit the card."))
        : null,
    };
  }
  return picked;
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
    // [COPY-FIELD-1] Absent → all three, exactly as before this change.
    field: parseFieldName(body?.field),
  });
  return json(out);
}
