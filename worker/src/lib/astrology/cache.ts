// [AUMFE-ASTRO-CLIENT-1] D1 cache (DB_META.astro_api_cache) for AstrologyAPI answers. Natal data never changes
// so it is cached forever; daily data (panchang, daily horoscope) expires at the next IST midnight.
// A cache failure is reported and treated as a miss: it must never fail the astrology call itself.
import type { Env } from "../../types";
import { sha256Hex } from "../../util";
import { trackException } from "../../hooks";

export type AstroTtl = "forever" | "day" | "none";

const IST_MS = 330 * 60_000;
const DAY_MS = 86_400_000;

export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}

export function istDate(now = Date.now()): string {
  return new Date(now + IST_MS).toISOString().slice(0, 10);
}

/** Epoch ms of the next 00:00 IST. */
export function nextIstMidnight(now = Date.now()): number {
  return Math.floor((now + IST_MS) / DAY_MS) * DAY_MS + DAY_MS - IST_MS;
}

export async function cacheKey(endpoint: string, body: unknown, ttl: AstroTtl, now = Date.now()): Promise<string> {
  return sha256Hex(endpoint + stableStringify(body) + (ttl === "day" ? istDate(now) : ""));
}

export async function cacheGet<T>(env: Env, endpoint: string, body: unknown, ttl: AstroTtl): Promise<T | null> {
  if (ttl === "none") return null;
  try {
    const now = Date.now();
    const key = await cacheKey(endpoint, body, ttl, now);
    const row = await env.DB_META.prepare("SELECT json, expires_at FROM astro_api_cache WHERE key=?1")
      .bind(key).first<{ json: string; expires_at: number | null }>();
    if (!row) return null;
    if (row.expires_at !== null && row.expires_at <= now) return null;
    return JSON.parse(row.json) as T;
  } catch (e) {
    void trackException(env, e, { handled: true, route: "astro_cache_get", extra: { endpoint } });
    return null;
  }
}

export async function cachePut(env: Env, endpoint: string, body: unknown, ttl: AstroTtl, data: unknown): Promise<void> {
  if (ttl === "none") return;
  try {
    const now = Date.now();
    const key = await cacheKey(endpoint, body, ttl, now);
    const expires = ttl === "forever" ? null : nextIstMidnight(now);
    await env.DB_META.prepare(
      "INSERT OR REPLACE INTO astro_api_cache (key, endpoint, json, created_at, expires_at) VALUES (?1,?2,?3,?4,?5)",
    ).bind(key, endpoint, JSON.stringify(data), now, expires).run();
  } catch (e) {
    void trackException(env, e, { handled: true, route: "astro_cache_put", extra: { endpoint } });
  }
}

/** Housekeeping for a cron to call later; not wired anywhere yet. */
export async function cachePurgeExpired(env: Env): Promise<void> {
  await env.DB_META.prepare("DELETE FROM astro_api_cache WHERE expires_at IS NOT NULL AND expires_at <= ?1").bind(Date.now()).run();
}
