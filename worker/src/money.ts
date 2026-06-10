// Money-route middleware (Phase 2, audit items A1 + A3).
//
//   withIdempotency — every mutating money endpoint requires header
//     `Idempotency-Key: <uuid>` (the client generates one per tap). The response
//     is stored in KV for 24 h; a replay returns the stored response and NEVER
//     re-executes. Missing header → 400. (WalletDO additionally dedupes op_ids,
//     so even a lost-KV race cannot double-apply money.)
//
//   rateLimit — KV sliding window. Defaults: topup 5/h, withdraw 3/h,
//     bookings 10/h, donations 10/min. Returns retry-after seconds when blocked.
import type { Env } from "./types";
import { json } from "./util";

const IDEM_TTL_S = 86_400; // 24 h

export async function withIdempotency(req: Request, env: Env, uid: string, fn: () => Promise<Response>): Promise<Response> {
  const key = req.headers.get("idempotency-key");
  if (!key || key.length > 128) {
    return json({ error: "Idempotency-Key header required on money routes" }, 400);
  }
  const kvKey = `idem:${uid}:${key}`;
  const stored = await env.TOKENS.get(kvKey);
  if (stored) {
    const s = JSON.parse(stored) as { status: number; body: unknown };
    return json(s.body, s.status, { "x-idempotent-replay": "1" });
  }
  const res = await fn();
  // Store only settled outcomes (2xx/4xx). 5xx/network errors may be retried for real.
  if (res.status < 500) {
    const body = await res.clone().json().catch(() => null);
    if (body !== null) {
      await env.TOKENS.put(kvKey, JSON.stringify({ status: res.status, body }), { expirationTtl: IDEM_TTL_S });
    }
  }
  return res;
}

/** Sliding-window limiter on KV. Returns null when allowed, or a 429 Response. */
export async function rateLimit(env: Env, key: string, max: number, windowSec: number): Promise<Response | null> {
  const kvKey = `rl:${key}`;
  const now = Date.now();
  const lo = now - windowSec * 1000;
  let stamps: number[] = [];
  try { stamps = JSON.parse((await env.TOKENS.get(kvKey)) || "[]").filter((t: number) => t > lo); } catch { /* reset */ }
  if (stamps.length >= max) {
    const retryAfter = Math.max(1, Math.ceil((stamps[0] + windowSec * 1000 - now) / 1000));
    return json({ error: "rate limited", retry_after: retryAfter }, 429, { "retry-after": String(retryAfter) });
  }
  stamps.push(now);
  await env.TOKENS.put(kvKey, JSON.stringify(stamps), { expirationTtl: windowSec + 60 });
  return null;
}

export const RL = {
  topup: { max: 5, windowSec: 3600 },
  withdraw: { max: 3, windowSec: 3600 },
  booking: { max: 10, windowSec: 3600 },
  donation: { max: 10, windowSec: 60 },
} as const;
