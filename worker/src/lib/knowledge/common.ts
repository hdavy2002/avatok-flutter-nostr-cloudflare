// [AUMFE-KNOWLEDGE-VECTOR-1 2026-10-01] Shared helpers: index log, search telemetry, small parsers.
import type { Env } from "../../types";
import { BRAND } from "../brand";
import { track, trackException } from "../../hooks";
import { SEARCH_DEFAULT_K, SEARCH_MAX_K } from "./indexes";

export const APP = BRAND.slug;

export const clampK = (k: unknown): number => {
  const n = Math.floor(Number(k));
  return Number.isFinite(n) && n > 0 ? Math.min(n, SEARCH_MAX_K) : SEARCH_DEFAULT_K;
};

export const parseJsonArray = (s: unknown): unknown[] => {
  if (typeof s !== "string" || !s) return [];
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
};
export const parseStrings = (s: unknown): string[] =>
  parseJsonArray(s).filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim());

/** Drop undefined/empty-string values: Vectorize metadata must not carry nulls. */
export function cleanMeta(m: Record<string, string | number | boolean | null | undefined>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(m)) {
    if (v === null || v === undefined || v === "") continue;
    out[k] = v;
  }
  return out;
}

/** Equality filter from only the defined, non-empty values. */
export function buildFilter(parts: Record<string, string | boolean | undefined | null>): Record<string, string | boolean> {
  const f: Record<string, string | boolean> = {};
  for (const [k, v] of Object.entries(parts)) {
    if (v === undefined || v === null || v === "") continue;
    f[k] = v;
  }
  return f;
}

export async function logIndex(
  env: Env, indexName: string, subjectId: string, action: "upsert" | "delete", ok: boolean, ms: number, error?: unknown,
): Promise<void> {
  try {
    await env.DB_META.prepare(
      `INSERT INTO knowledge_index_log (index_name, subject_id, action, ok, error, ms, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)`,
    ).bind(indexName, subjectId, action, ok ? 1 : 0, error ? String((error as Error)?.message ?? error).slice(0, 500) : null, ms, Date.now()).run();
  } catch (e) {
    void trackException(env, e, { route: "knowledge.logIndex", handled: true, app_name: APP });
  }
}

/** Telemetry for every search: unbound => ok:false reason:'unbound'. */
export function trackSearchUnbound(env: Env, index: string): void {
  void track(env, "server", "vector_search", APP, { index, ok: false, reason: "unbound" });
}
export function trackSearchOk(env: Env, index: string, ms: number, hits: number, topScore: number | null): void {
  void track(env, "server", "vector_search", APP, { index, ms, hits, top_score: topScore, ok: true });
}
export function trackSearchFail(env: Env, index: string, ms: number, err: unknown): void {
  void track(env, "server", "vector_search", APP, { index, ms, ok: false, reason: "error" });
  void trackException(env, err, { route: `knowledge.search.${index}`, handled: true, app_name: APP });
}

export const nowMs = () => Date.now();
