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

/**
 * [CALL-PRESENCE-2 2026-08-08] Why a GET needs a DETAILED result.
 *
 * `redisGetJson` collapses five different things into one `null`: no
 * credentials, an HTTP error, a timeout, a JSON parse failure, and a genuine
 * cache miss. For a template cache that is exactly right. For the CALL PATH it
 * is a diagnostic dead end — on 2026-08-08 call avatok-33e7f239 read
 * `presence:'unknown'` (i.e. this function returned null) at 11:22:43 while the
 * callee's key demonstrably existed: 43 seconds later the very next call read
 * the SAME key and got a record stamped 11 minutes earlier. A key cannot
 * un-expire, so the first read did not miss — it FAILED, and the failure was
 * swallowed with no event anywhere.
 */
export type RedisReadOutcome = "hit" | "miss" | "unconfigured" | "error" | "timeout" | "malformed";

export interface RedisReadResult<T> {
  value: T | null;
  outcome: RedisReadOutcome;
  /** HTTP status when the REST call answered, else null. */
  status: number | null;
  ms: number;
}

/**
 * GET with the failure mode preserved.
 *
 * TIMEOUTS ARE EXPLICIT. There was no deadline before, and this read now sits on
 * the pre-ring critical path (routes/api.ts) — an Upstash hop that hangs would
 * hold the caller's dial, which is worse than answering "unknown" and ringing.
 * ONE retry, because the observed failure is a blip (a 429/5xx/connection reset),
 * and a single fast retry is the difference between "we don't know" and a wrong
 * routing decision. A MISS is never retried: absence is an answer.
 */
export async function redisGetJsonResult<T = unknown>(
  env: Env,
  key: string,
  opts?: { timeoutMs?: number; retryTimeoutMs?: number; retries?: number },
): Promise<RedisReadResult<T>> {
  const started = Date.now();
  const c = creds(env);
  if (!c) return { value: null, outcome: "unconfigured", status: null, ms: 0 };
  const first = Math.max(1, opts?.timeoutMs ?? 1200);
  const again = Math.max(1, opts?.retryTimeoutMs ?? 800);
  const retries = Math.max(0, opts?.retries ?? 1);

  let last: RedisReadResult<T> = { value: null, outcome: "error", status: null, ms: 0 };
  for (let attempt = 0; attempt <= retries; attempt++) {
    const budget = attempt === 0 ? first : again;
    let status: number | null = null;
    try {
      const res = await fetch(`${c.url}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${c.token}` },
        signal: AbortSignal.timeout(budget),
      });
      status = res.status;
      if (!res.ok) {
        last = { value: null, outcome: "error", status, ms: Date.now() - started };
        continue; // a 429/5xx is exactly the blip the retry exists for
      }
      const j: any = await res.json().catch(() => null);
      const raw = j?.result;
      // `result: null` from a 200 is the ONE unambiguous answer: the key is not
      // there. Return immediately — retrying an answer is how a cheap read
      // becomes an expensive one.
      if (raw == null) return { value: null, outcome: "miss", status, ms: Date.now() - started };
      try {
        return { value: JSON.parse(String(raw)) as T, outcome: "hit", status, ms: Date.now() - started };
      } catch {
        // Stored bytes we cannot read are not a miss and not a transient error;
        // retrying would return the same bytes.
        return { value: null, outcome: "malformed", status, ms: Date.now() - started };
      }
    } catch (e) {
      const timedOut = (e as { name?: string } | null)?.name === "TimeoutError"
        || (e as { name?: string } | null)?.name === "AbortError";
      last = {
        value: null,
        outcome: timedOut ? "timeout" : "error",
        status,
        ms: Date.now() - started,
      };
    }
  }
  return { ...last, ms: Date.now() - started };
}

// GET key → parsed JSON value, or null on miss/error/not-configured.
export async function redisGetJson<T = unknown>(env: Env, key: string): Promise<T | null> {
  return (await redisGetJsonResult<T>(env, key)).value;
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
