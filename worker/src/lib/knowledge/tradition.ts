// [AUMFE-KNOWLEDGE-VECTOR-1 2026-10-01] Approved tradition library -> Vectorize `aumfe-tradition`.
// D1 (tradition_corpus) is the truth; Vectorize is the finder. A hit is only returned when its D1
// row is still status='approved'.
import type { Env } from "../../types";
import { chunkText, embedOne, embedTexts } from "./embed";
import { TRADITION_INDEX } from "./indexes";
import {
  APP, buildFilter, cleanMeta, clampK, logIndex, normKey, trackSearchFail, trackSearchOk, trackSearchUnbound,
} from "./common";
import { trackException } from "../../hooks";

export interface TraditionRow {
  id: string; topic: string; title: string; text: string; source: string; lang: string;
  graha: string | null; weekday: string | null; deity: string | null; status: string; chunk_count: number;
}
export interface TraditionHit { id: string; title: string; text: string; source: string; topic: string; score: number }
export interface TraditionQuery { query: string; topic?: string; graha?: string; weekday?: string; deity?: string; k?: number }

export const tradVectorId = (id: string, n: number) => `trad:${id}:${n}`;
export const tradChunkIds = (id: string, count: number): string[] => Array.from({ length: Math.max(0, count) }, (_, i) => tradVectorId(id, i));
/** `trad:<id>:<n>` -> {id, n}; null when not ours. */
export function parseTradVectorId(vid: string): { id: string; n: number } | null {
  const m = /^trad:(.+):(\d+)$/.exec(vid);
  return m ? { id: m[1], n: Number(m[2]) } : null;
}

/** The exact chunks that get embedded (title + text); hydrate re-derives the matched chunk from these. */
export const traditionChunks = (r: Pick<TraditionRow, "title" | "text">): string[] => chunkText(`${r.title}\n\n${r.text}`);

export function traditionMetadata(row: Pick<TraditionRow, "id" | "topic" | "lang" | "graha" | "weekday" | "deity">, n: number) {
  return cleanMeta({
    entry_id: row.id, chunk: n, topic: row.topic, lang: row.lang || "en",
    graha: normKey(row.graha), weekday: normKey(row.weekday), deity: normKey(row.deity), status: "approved",
  });
}

export const traditionFilter = (q: Omit<TraditionQuery, "query" | "k">) =>
  buildFilter({ status: "approved", topic: normKey(q.topic), graha: normKey(q.graha), weekday: normKey(q.weekday), deity: normKey(q.deity) });

/**
 * Merge Vectorize matches with D1 rows: keep approved rows only, best chunk per entry, ordered by score.
 * Pure (rows are passed in). `text` is the matched chunk when it can be re-derived, else the full text.
 */
export function hydrateTradition(
  matches: Array<{ id: string; score: number }>, rows: Map<string, TraditionRow>, k: number,
  chunker: (r: TraditionRow) => string[] = traditionChunks,
): TraditionHit[] {
  const best = new Map<string, { n: number; score: number }>();
  for (const m of matches) {
    const p = parseTradVectorId(m.id);
    if (!p) continue;
    const cur = best.get(p.id);
    if (!cur || m.score > cur.score) best.set(p.id, { n: p.n, score: m.score });
  }
  const out: TraditionHit[] = [];
  for (const [id, b] of best) {
    const row = rows.get(id);
    if (!row || row.status !== "approved") continue;
    const chunk = chunker(row)[b.n];
    out.push({ id, title: row.title, text: chunk ?? row.text, source: row.source, topic: row.topic, score: b.score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, k);
}

async function loadRows(env: Env, ids: string[]): Promise<Map<string, TraditionRow>> {
  const map = new Map<string, TraditionRow>();
  if (!ids.length) return map;
  const ph = ids.map((_, i) => `?${i + 1}`).join(",");
  const rs = await env.DB_META.prepare(
    `SELECT id, topic, title, text, source, lang, graha, weekday, deity, status, chunk_count FROM tradition_corpus WHERE id IN (${ph})`,
  ).bind(...ids).all<TraditionRow>();
  for (const r of rs.results ?? []) map.set(r.id, r);
  return map;
}

/** Index one APPROVED entry. Returns chunks written (0 when not approved / unbound). */
export async function indexTraditionEntry(env: Env, id: string): Promise<{ ok: boolean; chunks: number; reason?: string }> {
  const idx = env.VEC_TRADITION;
  const t0 = Date.now();
  try {
    const row = (await loadRows(env, [id])).get(id);
    if (!row) return { ok: false, chunks: 0, reason: "not_found" };
    if (row.status !== "approved") return { ok: false, chunks: 0, reason: "not_approved" };
    if (!idx) return { ok: false, chunks: 0, reason: "unbound" };
    const chunks = traditionChunks(row);
    if (!chunks.length) return { ok: false, chunks: 0, reason: "empty" };
    const vectors = await embedTexts(env, chunks, "tradition");
    await idx.upsert(vectors.map((values, n) => ({ id: tradVectorId(id, n), values, metadata: traditionMetadata(row, n) })));
    const stale = row.chunk_count > chunks.length ? tradChunkIds(id, row.chunk_count).slice(chunks.length) : [];
    if (stale.length) await idx.deleteByIds(stale);
    const now = Date.now();
    await env.DB_META.prepare(`UPDATE tradition_corpus SET chunk_count=?1, indexed_at=?2 WHERE id=?3`).bind(chunks.length, now, id).run();
    await logIndex(env, TRADITION_INDEX, id, "upsert", true, now - t0);
    return { ok: true, chunks: chunks.length };
  } catch (err) {
    await logIndex(env, TRADITION_INDEX, id, "upsert", false, Date.now() - t0, err);
    void trackException(env, err, { route: "knowledge.indexTraditionEntry", handled: true, app_name: APP, extra: { id } });
    return { ok: false, chunks: 0, reason: "error" };
  }
}

/** Remove every vector of an entry (archive / delete). Uses the stored chunk_count. */
export async function removeTraditionEntry(env: Env, id: string): Promise<{ ok: boolean; removed: number }> {
  const idx = env.VEC_TRADITION;
  const t0 = Date.now();
  try {
    const row = (await loadRows(env, [id])).get(id);
    const count = row?.chunk_count ?? 0;
    if (!idx) return { ok: false, removed: 0 };
    if (count > 0) await idx.deleteByIds(tradChunkIds(id, count));
    await env.DB_META.prepare(`UPDATE tradition_corpus SET chunk_count=0, indexed_at=NULL WHERE id=?1`).bind(id).run();
    await logIndex(env, TRADITION_INDEX, id, "delete", true, Date.now() - t0);
    return { ok: true, removed: count };
  } catch (err) {
    await logIndex(env, TRADITION_INDEX, id, "delete", false, Date.now() - t0, err);
    void trackException(env, err, { route: "knowledge.removeTraditionEntry", handled: true, app_name: APP, extra: { id } });
    return { ok: false, removed: 0 };
  }
}

export async function searchTradition(env: Env, q: TraditionQuery): Promise<TraditionHit[]> {
  const idx = env.VEC_TRADITION;
  if (!idx) { trackSearchUnbound(env, TRADITION_INDEX); return []; }
  const query = String(q.query ?? "").trim();
  if (!query) return [];
  const t0 = Date.now();
  try {
    const k = clampK(q.k);
    const vec = await embedOne(env, query, "tradition_query");
    const res = await idx.query(vec, { topK: Math.min(20, k * 3), filter: traditionFilter(q) as any, returnMetadata: "none" });
    const matches = (res.matches ?? []).map((m) => ({ id: m.id, score: m.score }));
    const ids = [...new Set(matches.map((m) => parseTradVectorId(m.id)?.id).filter((x): x is string => !!x))];
    const hits = hydrateTradition(matches, await loadRows(env, ids), k);
    trackSearchOk(env, TRADITION_INDEX, Date.now() - t0, hits.length, hits[0]?.score ?? null);
    return hits;
  } catch (err) {
    trackSearchFail(env, TRADITION_INDEX, Date.now() - t0, err);
    return [];
  }
}
