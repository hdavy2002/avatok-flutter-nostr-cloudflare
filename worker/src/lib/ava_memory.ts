// Ava memory — server (premium / server-readable) lane (Phase 4).
//
// This is the SERVER half of the two-lane memory design. It is an INTERNAL
// library function, NOT a new route: `worker/src/index.ts` is frozen (Phase 0)
// and registered no `/api/ava/memory` route. Server-side callers — the in-thread
// Ava agent (`do/ava_agent.ts`, whose `brainSearch()` is a P4 no-op stub) and the
// Phase-5 `brain.search` AvaTool route — import and call `brainSearch()` directly.
//
// It mirrors the retrieval already proven in `do/user_brain.ts` (`rawMatches` /
// `vectorRecall`): embed the query with the same Workers-AI embedding model, then
// query Vectorize with a HARD uid filter so a user can only ever retrieve THEIR
// OWN vectors (tenant isolation). We do NOT touch `user_brain.ts` or `brain.ts`.
//
// Privacy: the on-device-only / private conversations are never indexed into
// Vectorize by the ingestion pipeline (gated by AvaBrain `avatok_dms` = on-device
// only / opt-in), so they are structurally absent from this lane. The client's
// router additionally never routes private convs here.

import type { Env } from "../types";
import { searchForUser } from "./ava_search";
import { avaReasonRaw } from "./ava_reason"; // One Brain B1: gateway for embeddings
import { aiRunOpts } from "./ai_gate";       // AI Gateway cost-logging opts

/** One server-lane hit. Shape aligns with the client `MemoryHit` + the brain
 *  `sources` cards so P3/P5 can render or feed it into a prompt uniformly. */
export interface BrainHit {
  /** Best-effort stable id for the matched item (media_id | conv | vector id). */
  messageId: string;
  /** Server conversation id when known ('dm_…' | 'g_…'); '' otherwise. */
  conv: string;
  /** Cosine/relevance score from Vectorize (higher = better). */
  score: number;
  /** Short human-readable snippet (summary/snippet metadata). */
  snippet: string;
  /** Coarse kind: 'message' | 'voicemail' | 'file' | 'memory'. */
  kind: string;
  /** Library deep-link id when the match is a file. */
  media_id?: string;
}

const DEFAULT_EMBED_MODEL = "@cf/baai/bge-small-en-v1.5";

/**
 * Uid-scoped semantic search over the user's own Vectorize index (the premium /
 * server-readable lane). Returns up to `topK` hits, best-first. Never throws —
 * returns `[]` on any error or when Vectorize/AI is unavailable, so callers can
 * treat retrieval as best-effort augmentation.
 *
 * @param env   Worker bindings (needs `AI` + `VECTOR_INDEX`).
 * @param uid   The authenticated user id. HARD filter — never optional.
 * @param query The search text.
 * @param topK  Max hits (default 5).
 */
// Core implementation shared by the public `brainSearch()` (back-compat, swallows
// errors → []) and `brainSearchTyped()` (F1 — surfaces WHY a result was empty, so a
// degraded Ava is distinguishable from a legitimately empty memory). Never throws.
async function brainSearchCore(
  env: Env,
  uid: string,
  query: string,
  topK: number,
): Promise<{ hits: BrainHit[]; error: string | null }> {
  const q = (query || "").trim();
  if (!uid || !q) return { hits: [], error: null };
  if (!env.VECTOR_INDEX || !env.AI) return { hits: [], error: null };

  try {
    // 1) Embed the query with the SAME model the ingestion pipeline used (so the
    //    query vector lives in the same space as the stored vectors).
    const model = env.BRAIN_EMBED_MODEL || DEFAULT_EMBED_MODEL;
    const emb = (await avaReasonRaw(env, {
      role: "brain", capability: "embed", trigger: "search", feature: "brain_embed",
      verb: "embed", model, uid, raw: { text: q }, aiRunOpts: aiRunOpts(env, uid),
    })) as any;
    const vec: number[] | undefined = emb?.data?.[0];
    if (!vec) return { hits: [], error: "embed_empty" };

    // 2) Query Vectorize with a HARD uid filter (tenant isolation) — identical
    //    to user_brain.ts. `uid` is the indexed metadata field on the index.
    const res = await env.VECTOR_INDEX.query(vec, {
      topK: Math.max(1, Math.min(topK, 24)),
      filter: { uid },
      returnMetadata: true,
    } as any);

    const hits: BrainHit[] = [];
    for (const m of res.matches ?? []) {
      const md = (m.metadata ?? {}) as Record<string, unknown>;
      const kind = String(md.kind ?? md.type ?? (md.media_id ? "file" : "memory"));
      const snippet = String(md.snippet ?? md.summary ?? "").slice(0, 300);
      const conv = md.conv != null ? String(md.conv) : "";
      const mediaId = md.media_id != null ? String(md.media_id) : undefined;
      const messageId = mediaId ?? (conv || String(m.id ?? ""));
      hits.push({
        messageId,
        conv,
        score: typeof m.score === "number" ? m.score : 0,
        snippet,
        kind,
        ...(mediaId ? { media_id: mediaId } : {}),
      });
    }
    return { hits, error: null };
  } catch (e: any) {
    return { hits: [], error: String(e?.message ?? e).slice(0, 200) };
  }
}

export async function brainSearch(
  env: Env,
  uid: string,
  query: string,
  topK = 5,
): Promise<BrainHit[]> {
  return (await brainSearchCore(env, uid, query, topK)).hits;
}

// ─── Cloudflare AI Search lane (2026-06-18, primary) ─────────────────────────
// The user's chat text + shared files are indexed into their shard, under their
// own `<uid>/` folder, by `routes/ava_rag.ts` (`/api/ava/rag/ingest` →
// ingestForUser). The in-thread agent and ChatAVA must SEARCH the SAME place,
// so we go through the single tenancy boundary `searchForUser` (lib/ava_search.ts),
// which targets the user's shard and injects the `<uid>/` folder filter — both
// halves point at the identical, isolated store.

/**
 * Uid-scoped search over the user's shard (folder-filtered), flattened to short
 * context lines. Never throws (→ []). This is the PRIMARY retrieval lane for
 * "@ava find my files / what did we discuss" — it covers older files/messages
 * beyond the in-thread recent window.
 */
// Core implementation shared by `aiSearchLines()` (back-compat, swallows errors →
// []) and `brainSearchTyped()` (F1 — surfaces the error so callers can tell a
// provider failure apart from a legitimately empty result). Never throws.
async function aiSearchCore(
  env: Env,
  uid: string,
  query: string,
  topK: number,
): Promise<{ lines: string[]; error: string | null }> {
  const q = (query || "").trim();
  if (!uid || !q) return { lines: [], error: null };
  try {
    const r: any = await searchForUser(env, uid, q);
    const out: string[] = [];
    const data = r?.data ?? r?.results ?? r?.matches ?? r?.documents ?? [];
    if (Array.isArray(data)) {
      for (const d of data.slice(0, topK)) {
        const name = String(d?.filename ?? d?.name ?? d?.title ?? "").trim();
        const snip = String(d?.content ?? d?.snippet ?? d?.text ?? d?.summary ?? "")
          .replace(/\s+/g, " ").trim().slice(0, 300);
        const line = name ? `File "${name}": ${snip}` : snip;
        if (line.trim()) out.push(line);
      }
    }
    // Some AI Search variants synthesise a single answer string instead of rows.
    if (out.length === 0 && typeof r?.response === "string" && r.response.trim()) {
      out.push(r.response.trim().slice(0, 500));
    }
    return { lines: out, error: null };
  } catch (e: any) {
    return { lines: [], error: String(e?.message ?? e).slice(0, 200) };
  }
}

export async function aiSearchLines(
  env: Env,
  uid: string,
  query: string,
  topK = 5,
): Promise<string[]> {
  return (await aiSearchCore(env, uid, query, topK)).lines;
}

/**
 * Convenience for prompt-stuffing: the user's own memory/files flattened to short
 * context lines. PRIMARY = Cloudflare AI Search (the lane the client ingests to);
 * FALLBACK = the Vectorize lane (kept so any legacy-indexed vectors still surface).
 * Back-compat string[] shape — kept EXACTLY as-is; see `brainSearchTyped()` below
 * for the typed variant that also reports availability/source/degraded_reason.
 */
export async function brainSearchLines(
  env: Env,
  uid: string,
  query: string,
  topK = 5,
): Promise<string[]> {
  const ai = await aiSearchCore(env, uid, query, topK);
  if (ai.lines.length) return ai.lines;
  const vec = await brainSearchCore(env, uid, query, topK);
  return vec.hits
    .map((h) => {
      if (h.media_id) return `File: ${h.snippet} [file:${h.media_id}]`;
      if (h.conv) return `[${h.kind} in ${h.conv}] ${h.snippet}`;
      return h.snippet;
    })
    .filter((s) => s && s.trim().length > 0);
}

// ─── Typed result (F1 — AVA-KIMI-GATEWAY-1) ──────────────────────────────────
// Additive: does NOT replace `brainSearchLines()` (kept for existing callers).
// Lets a caller (do/ava_agent.ts) tell "legitimately no memory" apart from "the
// retrieval pipeline failed/degraded", which the plain string[] shape could not
// express — the exact gap called out in the audit (F1): a degraded Ava silently
// looked like an amnesiac Ava.
export type MemorySource = "ai_search" | "vectorize" | "none";

export interface MemoryResult {
  available: boolean;      // false only when EVERY lane errored (degraded)
  source: MemorySource;    // which lane produced the returned lines ('none' = no hits)
  hits: number;
  degraded_reason?: string; // present only when `available` is false
  lines: string[];
}

export async function brainSearchTyped(
  env: Env,
  uid: string,
  query: string,
  topK = 5,
): Promise<MemoryResult> {
  const ai = await aiSearchCore(env, uid, query, topK);
  if (ai.lines.length) return { available: true, source: "ai_search", hits: ai.lines.length, lines: ai.lines };

  const vec = await brainSearchCore(env, uid, query, topK);
  const vecLines = vec.hits
    .map((h) => {
      if (h.media_id) return `File: ${h.snippet} [file:${h.media_id}]`;
      if (h.conv) return `[${h.kind} in ${h.conv}] ${h.snippet}`;
      return h.snippet;
    })
    .filter((s) => s && s.trim().length > 0);
  if (vecLines.length) return { available: true, source: "vectorize", hits: vecLines.length, lines: vecLines };

  // Both lanes returned nothing — distinguish a legitimately empty result from a
  // degraded one (either lane erroring, as opposed to a clean zero-hit query).
  if (ai.error || vec.error) {
    const reason = ai.error ? `ai_search:${ai.error}` : `vectorize:${vec.error}`;
    return { available: false, source: "none", hits: 0, degraded_reason: reason.slice(0, 160), lines: [] };
  }
  return { available: true, source: "none", hits: 0, lines: [] };
}
