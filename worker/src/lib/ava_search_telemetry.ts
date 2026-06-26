// ava_search_telemetry.ts — rich PostHog telemetry envelope for the sharded AI
// Search layer (Specs/PROPOSAL-AI-SEARCH-SHARDING.md). Wraps every AI Search op
// so we can pinpoint, per user (email+phone stamped) and per shard:
//   • errors           — message + class + a `cf_limit` flag for CF limit/quota hits
//   • speed            — duration_ms per op
//   • load             — ingest payload bytes, search result counts, items deleted
//   • CF limits        — per-shard item_count vs the 1,000,000 files/instance cap,
//                        capacity %, and an `ava_search_capacity_warn` at 80%
//
// All telemetry is best-effort and runs OFF the user's request path (via
// ctx.waitUntil when available); it never throws and never blocks the op. The
// wrapped op's own error is always re-thrown so callers handle it normally.

import type { Env } from "../types";
import { trackUserContact, metric } from "../hooks";
import { contactFor } from "./identity";

export type SearchOp = "ingest" | "search" | "delete" | "store";

export interface SearchOpMeta {
  /** Instance id, e.g. "ava-shard-7". */
  shard: string;
  /** Shard ordinal 0..N-1. */
  shardOrd: number;
  /** Ingest payload size in bytes (load signal). */
  bytes?: number;
  /** Search hit count (set inside the op). */
  results?: number;
  /** Items deleted (set inside the op). */
  deleted?: number;
  /** Running per-shard item count (CF capacity signal); set directly or via probe. */
  shardItems?: number;
  /** Off-path probe to read the shard's item count without slowing the user op. */
  probeShardItems?: () => Promise<number | undefined>;
  /** Anything extra to attach to the event. */
  extra?: Record<string, unknown>;
}

/** CF AI Search files-per-instance cap (Workers Paid). */
export const SHARD_FILE_CAP = 1_000_000;
const CAP_WARN = 0.8;

/** Best-effort classification so dashboards can split CF-limit/rate errors out. */
function classifyError(msg: string): { cf_limit: boolean; klass: string } {
  const m = msg.toLowerCase();
  let klass = "error";
  if (/\b429\b|rate.?limit|too many requests/.test(m)) klass = "rate_limited";
  else if (/limit|quota|exceed|capacity|too many/.test(m)) klass = "cf_limit";
  else if (/timeout|timed out|deadline/.test(m)) klass = "timeout";
  else if (/not found|\b404\b/.test(m)) klass = "not_found";
  else if (/network|fetch failed|econn|socket/.test(m)) klass = "network";
  const cf_limit = klass === "cf_limit" || klass === "rate_limited";
  return { cf_limit, klass };
}

/**
 * Time `fn`, capture errors, and emit a rich PostHog event + Analytics Engine
 * point. Returns `fn`'s result; re-throws `fn`'s error unchanged.
 *
 * `meta` is read AFTER `fn` resolves, so an op may mutate `meta` (e.g. set
 * `meta.results` / `meta.deleted`) inside `fn` and have it reflected in telemetry.
 */
export async function instrument<T>(
  env: Env,
  uid: string,
  op: SearchOp,
  meta: SearchOpMeta,
  fn: () => Promise<T>,
  ctx?: { waitUntil(p: Promise<unknown>): void },
): Promise<T> {
  const t0 = Date.now();
  let ok = true;
  let errMsg = "";
  try {
    return await fn();
  } catch (e: any) {
    ok = false;
    errMsg = String(e?.message ?? e).slice(0, 300);
    throw e;
  } finally {
    const dur = Date.now() - t0;
    const send = (async () => {
      // Resolve the per-shard item count off the user path (capacity signal).
      let shardItems = meta.shardItems;
      if (shardItems == null && meta.probeShardItems) {
        try { shardItems = await meta.probeShardItems(); } catch { /* ignore */ }
      }
      const capPct = shardItems != null ? +(shardItems / SHARD_FILE_CAP).toFixed(4) : undefined;

      let email: string | null = null;
      let phone: string | null = null;
      try { const c = await contactFor(env, uid); email = c.email; phone = c.phone; } catch { /* ignore */ }

      const props: Record<string, unknown> = {
        op,
        shard: meta.shard,
        shard_ord: meta.shardOrd,
        duration_ms: dur,
        ok,
        ...(meta.bytes != null ? { bytes: meta.bytes } : {}),
        ...(meta.results != null ? { results: meta.results } : {}),
        ...(meta.deleted != null ? { deleted: meta.deleted } : {}),
        ...(shardItems != null ? { shard_items: shardItems, shard_capacity_pct: capPct } : {}),
        ...(meta.extra ?? {}),
      };

      try {
        if (!ok) {
          const { cf_limit, klass } = classifyError(errMsg);
          props.error = errMsg;
          props.error_class = klass;
          props.cf_limit = cf_limit;
          await trackUserContact(env, uid, email, phone, "ava_search_error", "avaai", props);
        } else {
          await trackUserContact(env, uid, email, phone, "ava_search_op", "avaai", props);
          if (capPct != null && capPct >= CAP_WARN) {
            await trackUserContact(env, uid, email, phone, "ava_search_capacity_warn", "avaai", {
              shard: meta.shard,
              shard_ord: meta.shardOrd,
              shard_items: shardItems,
              shard_capacity_pct: capPct,
            });
          }
        }
      } catch { /* best-effort */ }

      try {
        metric(env, "ava_search_latency", [dur, ok ? 1 : 0], [op, meta.shard]);
        if (shardItems != null && capPct != null) {
          metric(env, "ava_search_capacity", [shardItems, capPct], [meta.shard]);
        }
      } catch { /* best-effort */ }
    })();

    if (ctx?.waitUntil) ctx.waitUntil(send);
    else void send;
  }
}
