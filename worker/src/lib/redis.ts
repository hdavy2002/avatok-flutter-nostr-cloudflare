// redis.ts — tiny Upstash Redis REST client for the global GenUI template cache.
// Workers can't hold TCP sockets, so we use Upstash's HTTP REST API. Used to
// store the COMPOSED DESIGN TEMPLATE (no user data) keyed by tool+shape, so one
// Gemini compose serves every user worldwide that hits the same data shape.
//
// Resilient by design: if the URL/token aren't configured, every call no-ops
// (get → null, set → ignored) so the feature still works (just composes each
// time) and never throws into a turn.

import type { Env } from "../types";

function creds(env: Env): { url: string; token: string } | null {
  const url = (env.UPSTASH_REDIS_REST_URL ?? "").replace(/\/+$/, "");
  const token = env.UPSTASH_REDIS_REST_TOKEN ?? "";
  return url && token ? { url, token } : null;
}

// GET key → parsed JSON value, or null on miss/error/not-configured.
export async function redisGetJson<T = unknown>(env: Env, key: string): Promise<T | null> {
  const c = creds(env);
  if (!c) return null;
  try {
    const res = await fetch(`${c.url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${c.token}` },
    });
    if (!res.ok) return null;
    const j: any = await res.json().catch(() => null);
    const raw = j?.result;
    if (raw == null) return null;
    return JSON.parse(String(raw)) as T;
  } catch {
    return null;
  }
}

// SET key = JSON(value) with an expiry (seconds). Best-effort; never throws.
export async function redisSetJson(env: Env, key: string, value: unknown, ttlSeconds: number): Promise<void> {
  const c = creds(env);
  if (!c) return;
  try {
    // Upstash REST: POST body is the value; ?EX=<ttl> sets expiry.
    await fetch(`${c.url}/set/${encodeURIComponent(key)}?EX=${Math.max(1, Math.floor(ttlSeconds))}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${c.token}`, "content-type": "text/plain" },
      body: JSON.stringify(value),
    });
  } catch {
    /* best-effort cache write */
  }
}
