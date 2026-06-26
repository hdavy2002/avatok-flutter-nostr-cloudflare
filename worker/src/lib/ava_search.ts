// ava_search.ts — sharded, per-user Cloudflare AI Search access. This is the
// SINGLE tenancy boundary for all AI Search reads/writes/deletes
// (Specs/PROPOSAL-AI-SEARCH-SHARDING.md). Use ONLY these functions —
// ingestForUser / searchForUser / deleteForUser — so the per-user folder filter
// can never be omitted (omission = cross-user data leak).
//
// WHY (the scaling fix): CF AI Search caps at 5,000 instances/account, so one
// instance per user dies at 5,000 users. Instead we pool users into a FIXED set
// of SHARD_COUNT shared instances (`ava-shard-<n>`), map user→shard by a stable
// hash, store each user's docs under a `"<uid>/"` folder, and filter every search
// to that folder via the BUILT-IN `folder` attribute (no custom_metadata schema,
// so no forced re-index). Capacity = SHARD_COUNT × 1M docs.
//
// Account deletion: CF's Items API has delete-by-item-id but NO delete-by-folder,
// so ingestForUser records each item id in D1 (`ava_search_items`) and
// deleteForUser deletes them by id — no shard-wide scan. A cheap per-shard
// counter (`ava_search_shard_stats`) feeds CF-capacity telemetry.

import type { Env } from "../types";
import { metaSession } from "../db/shard";
import { instrument, type SearchOpMeta } from "./ava_search_telemetry";

// FIXED FOREVER. Changing this remaps users to different shards and hides their
// data until a full re-index. DO NOT CHANGE. (The env override exists ONLY so
// tests can run a tiny pool; production must use the constant.)
export const SHARD_COUNT = 1024;

function shardCount(env: Env): number {
  const n = Number((env as any).AI_SEARCH_SHARDS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : SHARD_COUNT;
}

// FNV-1a (32-bit, unsigned) — stable across runtimes and well-distributed.
// NOT JS String#hashCode (poor distribution, not portable).
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // h *= 16777619 (FNV prime) via shifts, kept unsigned 32-bit.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/** Sanitize a uid into a folder/key-safe token. */
export function safeUid(uid: string): string {
  return uid.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase().slice(0, 60);
}

/** The shard ordinal (0..N-1) a user maps to. */
export function shardOrd(env: Env, uid: string): number {
  return fnv1a(uid) % shardCount(env);
}

/** The shard instance id a user maps to, e.g. "ava-shard-7". */
export function shardId(env: Env, uid: string): string {
  return `ava-shard-${shardOrd(env, uid)}`;
}

// Get-or-create the user's shard instance (lazy, idempotent). Mirrors the
// existing get-or-create in ava_rag.ts / ava_memory.ts.
async function shard(env: Env, uid: string): Promise<any> {
  const ns: any = env.AI_SEARCH;
  const id = shardId(env, uid);
  try { const got = await ns.get(id); if (got) return got; } catch { /* not created yet */ }
  try { return await ns.create({ id }); } catch { return ns.get(id); }
}

// The folder filter that isolates a user inside a shared shard. Injected on
// EVERY read by searchForUser — callers cannot bypass it.
function folderFilter(uid: string): { folder: string } {
  return { folder: `${safeUid(uid)}/` };
}

// ─── D1: per-user item tracking + per-shard load counter (best-effort) ───────

async function recordItem(env: Env, uid: string, itemId: string, name: string, bytes: number): Promise<void> {
  try {
    const db = metaSession(env);
    const now = Date.now();
    const sid = shardId(env, uid);
    const ins = await db
      .prepare("INSERT OR IGNORE INTO ava_search_items (uid, shard, item_id, name, bytes, created_at) VALUES (?1,?2,?3,?4,?5,?6)")
      .bind(uid, sid, itemId, name, bytes, now)
      .run();
    const isNew = Number((ins as any)?.meta?.changes ?? 0) > 0;
    if (isNew) {
      await db
        .prepare(
          "INSERT INTO ava_search_shard_stats (shard, item_count, updated_at) VALUES (?1, 1, ?2) " +
            "ON CONFLICT(shard) DO UPDATE SET item_count = item_count + 1, updated_at = ?2",
        )
        .bind(sid, now)
        .run();
    } else {
      await db
        .prepare("UPDATE ava_search_items SET name = ?3, bytes = ?4, created_at = ?5 WHERE uid = ?1 AND item_id = ?2")
        .bind(uid, itemId, name, bytes, now)
        .run();
    }
  } catch { /* tracking is best-effort; never break ingest */ }
}

/** Per-user ingest usage (for free-tier quota): item count + total bytes. */
export async function ingestUsage(env: Env, uid: string): Promise<{ items: number; bytes: number }> {
  try {
    const r = await metaSession(env)
      .prepare("SELECT COUNT(*) AS items, COALESCE(SUM(bytes),0) AS bytes FROM ava_search_items WHERE uid = ?1")
      .bind(uid)
      .first<{ items: number; bytes: number }>();
    return { items: Number(r?.items ?? 0), bytes: Number(r?.bytes ?? 0) };
  } catch { return { items: 0, bytes: 0 }; }
}

/** Free-tier ingest cap (env-tunable): default 10 GB total / 10,000 items.
 *  Premium is uncapped (callers skip the check). The byte cap is the headline
 *  limit ("free users upload up to 10 GB, then upgrade"); the item cap is a high
 *  safety ceiling so bytes is normally the binding constraint. */
export function freeQuota(env: Env): { maxItems: number; maxBytes: number } {
  const mi = Number((env as any).AI_SEARCH_FREE_MAX_ITEMS);
  const mb = Number((env as any).AI_SEARCH_FREE_MAX_BYTES);
  return {
    maxItems: Number.isFinite(mi) && mi > 0 ? Math.floor(mi) : 10000,
    maxBytes: Number.isFinite(mb) && mb > 0 ? Math.floor(mb) : 10 * 1024 * 1024 * 1024,
  };
}

async function shardItemCount(env: Env, uid: string): Promise<number | undefined> {
  try {
    const r = await metaSession(env)
      .prepare("SELECT item_count FROM ava_search_shard_stats WHERE shard = ?1")
      .bind(shardId(env, uid))
      .first<{ item_count: number }>();
    return r?.item_count;
  } catch { return undefined; }
}

// ─── Public ops (the ONLY allowed read/write/delete paths) ───────────────────

export interface SearchCtx { waitUntil(p: Promise<unknown>): void; }

/** Index a note/file into the user's shard, under their `"<uid>/"` folder. */
export async function ingestForUser(
  env: Env,
  uid: string,
  name: string,
  content: unknown,
  ctx?: SearchCtx,
  extra?: Record<string, unknown>,
): Promise<any> {
  const key = `${safeUid(uid)}/${name}`.slice(0, 120);
  const bytes =
    typeof content === "string"
      ? content.length
      : Number((content as any)?.byteLength ?? (content as any)?.length ?? 0);
  const meta: SearchOpMeta = {
    shard: shardId(env, uid),
    shardOrd: shardOrd(env, uid),
    bytes,
    probeShardItems: () => shardItemCount(env, uid),
    ...(extra ? { extra } : {}),
  };
  return instrument(env, uid, "ingest", meta, async () => {
    const inst = await shard(env, uid);
    const item = await inst.items.uploadAndPoll(key, content);
    const itemId = String(item?.id ?? item?.item_id ?? key);
    await recordItem(env, uid, itemId, key, bytes);
    return item;
  }, ctx);
}

/** Semantic search over ONLY the user's own docs (folder-filtered). */
export async function searchForUser(
  env: Env,
  uid: string,
  query: string,
  ctx?: SearchCtx,
  extra?: Record<string, unknown>,
): Promise<any> {
  const meta: SearchOpMeta = {
    shard: shardId(env, uid),
    shardOrd: shardOrd(env, uid),
    probeShardItems: () => shardItemCount(env, uid),
    ...(extra ? { extra } : {}),
  };
  return instrument(env, uid, "search", meta, async () => {
    const inst = await shard(env, uid);
    const r = await inst.search({
      messages: [{ role: "user", content: query }],
      ai_search_options: { retrieval: { filters: folderFilter(uid) } },
    });
    meta.results = Array.isArray(r?.data)
      ? r.data.length
      : Array.isArray(r?.results)
        ? r.results.length
        : 0;
    return r;
  }, ctx);
}

/** Delete ALL of a user's AI Search docs (account deletion). Per-item via the
 *  D1-tracked ids — no shard-wide scan. Returns the count deleted. */
export async function deleteForUser(
  env: Env,
  uid: string,
  ctx?: SearchCtx,
): Promise<{ deleted: number }> {
  const sid = shardId(env, uid);
  const meta: SearchOpMeta = {
    shard: sid,
    shardOrd: shardOrd(env, uid),
    probeShardItems: () => shardItemCount(env, uid),
  };
  let deleted = 0;
  await instrument(env, uid, "delete", meta, async () => {
    const inst = await shard(env, uid);
    const db = metaSession(env);
    const rows = await db
      .prepare("SELECT item_id FROM ava_search_items WHERE uid = ?1")
      .bind(uid)
      .all<{ item_id: string }>();
    for (const r of rows.results ?? []) {
      try { await inst.items.delete(r.item_id); deleted++; } catch { /* keep going */ }
    }
    try {
      await db.prepare("DELETE FROM ava_search_items WHERE uid = ?1").bind(uid).run();
      if (deleted > 0) {
        await db
          .prepare("UPDATE ava_search_shard_stats SET item_count = MAX(0, item_count - ?2), updated_at = ?3 WHERE shard = ?1")
          .bind(sid, deleted, Date.now())
          .run();
      }
    } catch { /* best-effort */ }
    meta.deleted = deleted;
    return { deleted };
  }, ctx);
  return { deleted };
}
