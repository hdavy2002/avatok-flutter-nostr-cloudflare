// [AUMFE-KNOWLEDGE-VECTOR-1 2026-10-01] Embeddings for the shared knowledge layer.
// Model: Workers AI @cf/baai/bge-m3 (1024 dims, multilingual, <=512 input tokens per text).
import type { Env } from "../../types";
import { BRAND } from "../brand";
import { track, trackException } from "../../hooks";
import { aiRunOpts } from "../ai_gate";

export const EMBED_MODEL = "@cf/baai/bge-m3";
export const EMBED_DIMS = 1024;
/** Texts per AI.run call. */
export const EMBED_BATCH = 16;

const APP = BRAND.slug;

/**
 * Split text into chunks of at most `maxChars`, on paragraph then sentence boundaries, carrying
 * roughly `overlap` trailing characters of the previous chunk into the next one. Pure.
 */
export function chunkText(text: string, maxChars = 1200, overlap = 150): string[] {
  const clean = String(text ?? "").replace(/\r\n/g, "\n").trim();
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];
  const ov = Math.max(0, Math.min(overlap, Math.floor(maxChars / 2)));

  // 1. Break into atoms no longer than maxChars: paragraphs, then sentences, then hard slices.
  const atoms: string[] = [];
  for (const para of clean.split(/\n{2,}/)) {
    const p = para.trim();
    if (!p) continue;
    if (p.length <= maxChars) { atoms.push(p); continue; }
    const sentences = p.match(/[^.!?।\n]+[.!?।]*\s*/g) ?? [p];
    for (const s of sentences) {
      const t = s.trim();
      if (!t) continue;
      if (t.length <= maxChars) { atoms.push(t); continue; }
      for (let i = 0; i < t.length; i += maxChars) atoms.push(t.slice(i, i + maxChars));
    }
  }

  // 2. Pack atoms greedily; each new chunk starts with an overlap tail of the previous chunk.
  const chunks: string[] = [];
  let cur = "";
  for (const a of atoms) {
    const joined = cur ? `${cur}\n${a}` : a;
    if (joined.length <= maxChars) { cur = joined; continue; }
    if (cur) chunks.push(cur);
    const tail = ov && cur ? cur.slice(Math.max(0, cur.length - ov)).trim() : "";
    const seeded = tail ? `${tail}\n${a}` : a;
    cur = seeded.length <= maxChars ? seeded : a;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/** Pull the vectors out of a bge-m3 response ({data:number[][]}). Throws on a shape we do not know. */
export function parseEmbedResponse(out: unknown, expected: number): number[][] {
  const data = (out as { data?: unknown } | null)?.data;
  if (!Array.isArray(data) || data.length !== expected) {
    throw new Error(`embed_bad_response: expected ${expected} vectors`);
  }
  for (const v of data) {
    if (!Array.isArray(v) || v.length !== EMBED_DIMS) throw new Error(`embed_bad_dims: expected ${EMBED_DIMS}`);
  }
  return data as number[][];
}

/** Embed many texts (batched). Reports one `knowledge_embed` event with ms + count. */
export async function embedTexts(env: Env, texts: string[], purpose = "index"): Promise<number[][]> {
  if (!texts.length) return [];
  const t0 = Date.now();
  try {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      const slice = texts.slice(i, i + EMBED_BATCH);
      const res = await env.AI.run(EMBED_MODEL as any, { text: slice }, aiRunOpts(env));
      out.push(...parseEmbedResponse(res, slice.length));
    }
    void track(env, "server", "knowledge_embed", APP, { model: EMBED_MODEL, purpose, count: texts.length, ms: Date.now() - t0, ok: true });
    return out;
  } catch (err) {
    void track(env, "server", "knowledge_embed", APP, { model: EMBED_MODEL, purpose, count: texts.length, ms: Date.now() - t0, ok: false });
    void trackException(env, err, { route: "knowledge.embedTexts", handled: true, app_name: APP, extra: { purpose, count: texts.length } });
    throw err;
  }
}

export async function embedOne(env: Env, text: string, purpose = "query"): Promise<number[]> {
  const [v] = await embedTexts(env, [text], purpose);
  return v;
}
