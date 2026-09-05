// [POSTER-FIRST-1 2026-09-05] The read-back pass.
//
// A generated poster is handed straight back to Gemini as an IMAGE INPUT with
// one instruction: read every piece of text you can see and return it as JSON.
// We then diff that against the exact strings the prompt was built from.
//
// WHY this exists when the poster only carries two short strings:
//
// The dangerous failure is not a typo in the title — a slightly restyled title
// is fine and hand-lettering legitimately restyles. The dangerous failure is
// INVENTED TEXT. Asked for a 1970s film poster, the model imitates the whole
// poster OBJECT, and real film posters are dense with cast lists, studio names
// and a painter's signature. On 2026-09-05 the first test poster lettered both
// requested strings perfectly and still carried a fabricated pencil signature
// in the bottom margin. It passed every check a person makes in three seconds.
// A fake credit on a real listing is worse than a typo, and nobody was ever
// going to catch it by eye at card size. Hence: automatic, every poster.
//
// This module NEVER throws and NEVER writes D1 — same contract as
// listing_poster.ts, because the callers commit in different batches. A
// verifier that cannot run must not block a listing, so an unavailable provider
// returns `ok: true` with `skipped: true` rather than failing the poster: an
// outage in the checker is not evidence that the poster is wrong. It is
// recorded either way, so a silently-skipping verifier shows up in telemetry
// instead of looking like a clean pass.
import type { Env } from "../types";
import { generateContentVia } from "./vertex";
import type { PosterCopy } from "./listing_poster";

const DEFAULT_VERIFY_MODEL = "gemini-3.7-flash";

/** Hand-lettering restyles: ligatures, dropped punctuation, a stylised ampersand.
 *  The title threshold is deliberately looser than exact and tighter than vibes. */
const TITLE_MIN = 0.90;
const TAGLINE_MIN = 0.85;

export type PosterVerdict = {
  ok: boolean;
  skipped?: boolean;
  attempt?: number;
  /** Everything the model reported reading, verbatim, for the audit trail. */
  read?: { title?: string; tagline?: string; other?: string[] };
  title_score?: number;
  tagline_score?: number;
  extra_text_found?: string[];
  mismatches?: string[];
  /** Fed back into the next generation attempt. Empty when ok. */
  retry_hint?: string;
  error?: string;
  checked_at?: number;
};

// --------------------------------------------------------------------------
// String comparison
// --------------------------------------------------------------------------

/** Normalise the way a sign painter would: case, spacing and punctuation are
 *  not information here, so they must not count as mismatches. */
function norm(s: unknown): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[’'`]/g, "")
    .replace(/[^a-z0-9ऀ-ॿ]+/gu, " ")
    .trim();
}

/** Levenshtein similarity in [0,1]. Small strings only (titles are <= 60 chars),
 *  so the O(n*m) table is not worth optimising and stays readable. */
function similarity(a: string, b: string): number {
  const s = norm(a), t = norm(b);
  if (!s && !t) return 1;
  if (!s || !t) return 0;
  if (s === t) return 1;
  const m = s.length, n = t.length;
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const cur = new Array(n + 1);
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}

/** Text the model reports that is really just an echo of what we asked for —
 *  a title split across painted lines, the tagline repeated in a banner — must
 *  not be counted as invented. Only genuinely foreign strings are extra. */
function isEchoOfCopy(fragment: string, copy: PosterCopy): boolean {
  const f = norm(fragment);
  if (!f) return true;
  const title = norm(copy.title);
  const tagline = norm(copy.tagline);
  if (!f) return true;
  if (title.includes(f) || (f.length > 2 && title && similarity(f, title) >= 0.8)) return true;
  if (tagline && (tagline.includes(f) || similarity(f, tagline) >= 0.8)) return true;
  return false;
}

// --------------------------------------------------------------------------
// The call
// --------------------------------------------------------------------------

const INSTRUCTION = [
  "You are a proof-reader checking a printed poster. Read the image and report",
  "EVERY piece of visible text, including small, faint, decorative or",
  "hand-written marks, signatures, credits and anything printed in the margins.",
  "Do not translate. Do not tidy up spelling. Report exactly what is painted.",
  "If a piece of text is illegible, report it as \"[illegible mark]\".",
  "Respond with STRICT JSON and nothing else, in this exact shape:",
  '{"title":"<the largest display text, or empty>",',
  ' "tagline":"<the secondary line under the title, or empty>",',
  ' "other":["<every other piece of text, one per entry>"]}',
].join(" ");

function parseJsonLoose(raw: string): any | null {
  // Models wrap JSON in ```json fences often enough that failing on it would
  // make the verifier report false failures — which would burn real retries.
  const cleaned = String(raw || "").replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "").trim();
  try { return JSON.parse(cleaned); } catch { /* fall through */ }
  const a = cleaned.indexOf("{"), b = cleaned.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(cleaned.slice(a, b + 1)); } catch { /* ignore */ } }
  return null;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function verifyPosterText(
  env: Env,
  bytes: Uint8Array,
  copy: PosterCopy,
  attempt = 1,
): Promise<PosterVerdict> {
  const model = String((env as any).AVA_VERTEX_TEXT_MODEL || "").trim() || DEFAULT_VERIFY_MODEL;
  const base: PosterVerdict = { ok: true, attempt, checked_at: Date.now() };
  try {
    const r = await generateContentVia(env, model, {
      contents: [{
        role: "user",
        parts: [
          { text: INSTRUCTION },
          { inlineData: { mimeType: "image/png", data: toBase64(bytes) } },
        ],
      }],
      generationConfig: { responseModalities: ["TEXT"], temperature: 0 },
    }, "generateContent", { timeoutMs: 45_000 });

    const text = (r.out?.candidates?.[0]?.content?.parts ?? [])
      .map((p: any) => p?.text).filter(Boolean).join("\n");
    const parsed = r.ok ? parseJsonLoose(text) : null;
    if (!parsed) {
      // Could not read the checker's answer. NOT a poster failure — see header.
      return {
        ...base, skipped: true,
        error: r.ok ? "verifier returned unparseable output" :
          String(r.out?.error?.message ?? `verifier ${r.status}`).slice(0, 180),
      };
    }

    const readTitle = String(parsed.title ?? "");
    const readTagline = String(parsed.tagline ?? "");
    const readOther: string[] = Array.isArray(parsed.other)
      ? parsed.other.map((x: unknown) => String(x ?? "").trim()).filter(Boolean).slice(0, 30)
      : [];

    const titleScore = similarity(readTitle, copy.title);
    const taglineScore = copy.tagline ? similarity(readTagline, copy.tagline) : 1;
    const extra = readOther.filter((frag) => !isEchoOfCopy(frag, copy));

    const mismatches: string[] = [];
    const hints: string[] = [];
    if (titleScore < TITLE_MIN) {
      mismatches.push("title");
      hints.push(`the previous attempt lettered the title as "${readTitle}"; it must read exactly "${copy.title}"`);
    }
    if (copy.tagline && taglineScore < TAGLINE_MIN) {
      mismatches.push("tagline");
      hints.push(`the previous attempt lettered the tagline as "${readTagline}"; it must read exactly "${copy.tagline}"`);
    }
    if (extra.length) {
      mismatches.push("extra_text");
      hints.push(
        `the previous attempt added text that must not appear: ${extra.slice(0, 6).map((e) => `"${e}"`).join(", ")}. ` +
        "Render no credits, no studio name, no signature, no printer's marks and no text in the margins",
      );
    }

    return {
      ...base,
      ok: mismatches.length === 0,
      read: { title: readTitle, tagline: readTagline, other: readOther },
      title_score: Math.round(titleScore * 100) / 100,
      tagline_score: Math.round(taglineScore * 100) / 100,
      extra_text_found: extra,
      mismatches,
      retry_hint: hints.join(". ").slice(0, 600),
    };
  } catch (e) {
    return { ...base, skipped: true, error: String((e as any)?.message || e).slice(0, 180) };
  }
}
