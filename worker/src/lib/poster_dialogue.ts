// [POSTER-FILMY-1 2026-09-05] The line under the title.
//
// It used to be the creator's own blurb, verbatim — "Chicken curry recipe new".
// Accurate, and completely dead on a film poster. Owner decision 2026-09-05: the
// listing name stays as the big text (a buyer has to recognise what is being
// sold), and the line under it becomes a filmy dialogue with Hindi slang, the
// way a real poster carries a punch line rather than a product description.
//
// Script: Hinglish in Latin OR Devanagari, the model's choice per poster (owner
// decision). Devanagari is riskier — image models garble it more often, and
// poster_verify.ts will fail those and burn a retry — but the variety was worth
// it to him, and the verifier is exactly the thing that catches the garbling.
//
// This module NEVER throws. A failure returns null and the caller keeps the
// blurb, which is the old behaviour: a boring poster beats no poster.
import type { Env } from "../types";
import { generateContentVia } from "./vertex";

const DEFAULT_MODEL = "gemini-3.7-flash";

/** Hard cap. Long lines get lettered small, and small lettering is what the
 *  model garbles — so the length limit is a legibility rule, not a style one. */
const MAX_LINE = 40;

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
    "poster shouts. Hindi slang is welcome. Write it in Latin script (Hinglish)",
    "or in Devanagari, whichever suits the line better.",
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
    return line;
  } catch {
    return null;
  }
}
