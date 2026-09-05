// [POSTER-FILMY-1 2026-09-05] The line under the title.
//
// It used to be the creator's own blurb, verbatim — "Chicken curry recipe new".
// Accurate, and completely dead on a film poster. Owner decision 2026-09-05: the
// listing name stays as the big text (a buyer has to recognise what is being
// sold), and the line under it becomes a filmy dialogue with Hindi slang, the
// way a real poster carries a punch line rather than a product description.
//
// Script: LATIN ONLY — English or Hinglish. Devanagari was allowed for a few
// hours on 2026-09-05 and then withdrawn by the owner, because image models
// garble it far more than Latin: the poster still generates and still looks
// good while carrying lettering that is not what was asked for, and the only
// thing standing between that and a live listing is poster_verify.ts failing it
// and burning a retry. Hindi slang is still wanted — it is spelled out in Latin
// ("aaj kuch toofani karte hain"), which is how people write it in chat anyway.
//
// The rule is enforced TWICE on purpose: asked for in the brief, and checked on
// the way out. A brief is a request, not a guarantee — a model that answers in
// Devanagari once in fifty would put a garbled poster on a real listing, and the
// check costs one regex.
//
// This module NEVER throws. A failure returns null and the caller keeps the
// blurb, which is the old behaviour: a boring poster beats no poster.
import type { Env } from "../types";
import { generateContentVia } from "./vertex";

const DEFAULT_MODEL = "gemini-3.7-flash";

/** Hard cap. Long lines get lettered small, and small lettering is what the
 *  model garbles — so the length limit is a legibility rule, not a style one. */
const MAX_LINE = 40;

/** Anything outside Latin-1 plus the punctuation a poster line legitimately
 *  uses. Deliberately a whitelist of what IS allowed rather than a blacklist of
 *  Devanagari: the failure mode is any script an image model letters badly, and
 *  naming them one by one would miss the next one. Accented Latin is fine —
 *  "café" is not a garbling risk. */
const NON_LATIN = /[^\p{Script=Latin}\p{Nd}\s'’!?.,:;&()"«»…\-—–%+#@]/u;

function parseJsonLoose(raw: string): any | null {
  const cleaned = String(raw || "").replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "").trim();
  try { return JSON.parse(cleaned); } catch { /* fall through */ }
  const a = cleaned.indexOf("{"), b = cleaned.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(cleaned.slice(a, b + 1)); } catch { /* ignore */ } }
  return null;
}

/**
 * Write the poster's punch line from what the creator actually wrote.
 *
 * Note what is NOT here: no house style, no list of approved phrases, no tone
 * adjectives beyond the genre itself. The brief hands over the listing's own
 * facts and the one hard constraint (length), because a prompt that dictates
 * the joke gets the same joke every time — which is the failure this whole
 * change exists to undo.
 */
export async function writePosterDialogue(
  env: Env,
  row: Record<string, any>,
): Promise<string | null> {
  const title = String(row?.title || "").trim().slice(0, 80);
  const blurb = String(row?.blurb || "").trim().slice(0, 160);
  const description = String(row?.description || "").trim().slice(0, 400);
  const category = String(row?.category || "").trim().slice(0, 60);
  if (!title && !blurb && !description) return null;

  const brief = [
    "You are writing the punch line for a Bollywood film poster.",
    "The poster advertises a real live session that a real person is hosting.",
    "Here is what the host wrote about it:",
    title ? `TITLE: ${title}` : "",
    blurb ? `ONE-LINER: ${blurb}` : "",
    description ? `DESCRIPTION: ${description}` : "",
    category ? `CATEGORY: ${category}` : "",
    "",
    "Write ONE short line to sit under the title — the sort of filmy dialogue a",
    "poster shouts. Hindi slang is welcome, but spell it in the Latin alphabet",
    "the way people type it in chat — \"aaj kuch toofani karte hain\", not",
    "Devanagari. Latin letters only: no Devanagari, no other scripts.",
    `It must be at most ${MAX_LINE} characters, and it must fit THIS session,`,
    "not a generic one.",
    "Do not repeat the title. Do not mention a price, a date or a time.",
    'Respond with STRICT JSON and nothing else: {"line":"<the line>"}',
  ].filter(Boolean).join("\n");

  const model = String((env as any).AVA_VERTEX_TEXT_MODEL || "").trim() || DEFAULT_MODEL;
  try {
    const r = await generateContentVia(env, model, {
      contents: [{ role: "user", parts: [{ text: brief }] }],
      // Warm, not wild. At temperature 0 every cooking listing gets the same
      // line, which is the staleness being fixed; far above this it starts
      // inventing facts about the session.
      generationConfig: { responseModalities: ["TEXT"], temperature: 0.9 },
    }, "generateContent", { timeoutMs: 20_000 });
    if (!r.ok) return null;

    const text = (r.out?.candidates?.[0]?.content?.parts ?? [])
      .map((p: any) => p?.text).filter(Boolean).join("\n");
    const parsed = parseJsonLoose(text);
    const line = String(parsed?.line ?? "").trim().replace(/^["'“”]+|["'“”]+$/g, "");
    if (!line) return null;
    // Over-length is a rejection, not a truncation: cutting mid-word produces a
    // line the verifier will then read back as a mismatch, failing the poster
    // over our own edit.
    if (line.length > MAX_LINE) return null;
    // Latin-only, enforced. Rejecting rather than transliterating: a machine
    // transliteration would change the words the verifier is about to check
    // for, and a wrong-but-plausible line is worse than the blurb we fall back
    // to. See the header for why Devanagari is out.
    if (NON_LATIN.test(line)) return null;
    return line;
  } catch {
    return null;
  }
}
