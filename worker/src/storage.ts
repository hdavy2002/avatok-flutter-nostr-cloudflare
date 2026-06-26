// AvaStorage (Phase 4) — ONE per-account storage pool, quota + live updates.
//
// Every upload path is already a single choke point (routes/media.ts inserts
// into user_media — "registerFile" IS that insert). This module adds what the
// phase needs around it:
//   • recomputeStorage(uid)  — dedup-counted Σ over user_media → storage_quota
//     summary row (the graphs repaint from THIS, never from user_media scans).
//   • checkUploadAllowed()   — 5 GB enforcement at upload: over quota with coins
//     ⇒ allowed (metered, billed monthly by consumers cron); empty wallet ⇒
//     413 quota_exceeded + read_only. Files are NEVER deleted (rulebook §3).
//   • pushStorage()          — live `{type:'storage', ...summary}` frame over the
//     user's InboxDO socket (the ONE multiplexed WS — perf budget §4) so open
//     AvaStorage screens animate on any upload from any app.
//   • GET /api/storage/summary — summary row + last-6-months trend.
import type { Env } from "./types";
import { json } from "./util";
import { mediaSession } from "./db/shard";
import { requireUser, isFail } from "./authz";
import { walletOp } from "./routes/wallet";
import { track } from "./hooks";

export const GB = 1024 * 1024 * 1024;
export type StorageState = "ok" | "over_quota_paying" | "read_only";

export interface StorageSummary {
  used_bytes: number;
  quota_bytes: number;
  state: StorageState;
  by_category: Record<string, { count: number; bytes: number }>;
}

function freeQuotaBytes(env: Env): number {
  return Number(env.STORAGE_FREE_GB || "10") * GB;
}

async function walletCoins(env: Env, uid: string): Promise<number> {
  try {
    const w = await walletOp(env, uid, { op: "balance", uid });
    return Number(w.body?.balance ?? w.body?.coins ?? w.body?.available ?? 0);
  } catch { return 0; } // wallet unavailable → treat as 0 (read-only beats surprise bills)
}

/** Full dedup recompute → upsert the storage_quota summary row. Returns the
 *  fresh summary. State: over quota + coins ⇒ over_quota_paying; over quota +
 *  empty wallet ⇒ read_only; else ok. */
export async function recomputeStorage(env: Env, uid: string): Promise<StorageSummary> {
  const mdb = mediaSession(env);
  // One physical copy per content key (shortcuts/copies don't double-count).
  const rs = await mdb.prepare(
    `WITH dedup AS (
       SELECT key, MIN(id) AS rep FROM user_media
       WHERE uid=?1 AND deleted_at IS NULL GROUP BY key
     )
     SELECT COALESCE(m.category,'other') AS category, COUNT(*) AS n, COALESCE(SUM(m.size_bytes),0) AS bytes
     FROM dedup d JOIN user_media m ON m.id = d.rep
     GROUP BY category`,
  ).bind(uid).all();
  const byCat: Record<string, { count: number; bytes: number }> = {};
  let used = 0;
  for (const r of (rs.results ?? []) as any[]) {
    byCat[r.category] = { count: Number(r.n), bytes: Number(r.bytes) };
    used += Number(r.bytes);
  }
  const prev = await mdb.prepare("SELECT quota_bytes, state FROM storage_quota WHERE uid=?1").bind(uid).first<any>();
  const quota = Number(prev?.quota_bytes || freeQuotaBytes(env));
  let state: StorageState = "ok";
  if (used > quota) state = (await walletCoins(env, uid)) > 0 ? "over_quota_paying" : "read_only";
  await mdb.prepare(
    `INSERT INTO storage_quota (uid, used_bytes, quota_bytes, state, by_category, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6)
     ON CONFLICT(uid) DO UPDATE SET used_bytes=?2, state=?4, by_category=?5, updated_at=?6`,
  ).bind(uid, used, quota, state, JSON.stringify(byCat), Date.now()).run();
  const summary = { used_bytes: used, quota_bytes: quota, state, by_category: byCat };
  if (prev && prev.state !== state) track(env, uid, "quota_state_changed", "avastorage", { state, used_bytes: used });
  return summary;
}

/** Cheap summary read (recompute only when the row doesn't exist yet). */
export async function storageSummary(env: Env, uid: string): Promise<StorageSummary> {
  const row = await mediaSession(env).prepare(
    "SELECT used_bytes, quota_bytes, state, by_category FROM storage_quota WHERE uid=?1",
  ).bind(uid).first<any>();
  if (!row) return recomputeStorage(env, uid);
  let byCat: StorageSummary["by_category"] = {};
  try { byCat = JSON.parse(row.by_category || "{}"); } catch { /* repaired on next recompute */ }
  return { used_bytes: Number(row.used_bytes), quota_bytes: Number(row.quota_bytes), state: row.state as StorageState, by_category: byCat };
}

/** Quota gate at upload time. `addBytes` only grows usage for NEW content keys —
 *  the caller passes dedup=true when the key already exists for this user. */
export async function checkUploadAllowed(
  env: Env, uid: string, addBytes: number, dedup: boolean,
): Promise<{ ok: true } | { ok: false; resp: Response }> {
  if (dedup || addBytes <= 0) return { ok: true }; // same content → no growth, always fine
  const s = await storageSummary(env, uid);
  if (s.used_bytes + addBytes <= s.quota_bytes) return { ok: true };
  // Would exceed the free quota → needs a funded wallet (20 coins/GB/mo, billed
  // by the consumers monthly cron). Empty wallet ⇒ reject; NEVER delete files.
  if ((await walletCoins(env, uid)) > 0) return { ok: true };
  await mediaSession(env).prepare(
    `INSERT INTO storage_quota (uid, used_bytes, quota_bytes, state, updated_at)
     VALUES (?1, ?2, ?3, 'read_only', ?4)
     ON CONFLICT(uid) DO UPDATE SET state='read_only', updated_at=?4`,
  ).bind(uid, s.used_bytes, s.quota_bytes, Date.now()).run();
  track(env, uid, "quota_state_changed", "avastorage", { state: "read_only", used_bytes: s.used_bytes });
  return {
    ok: false,
    resp: json({ error: "quota_exceeded", used_bytes: s.used_bytes, quota_bytes: s.quota_bytes, state: "read_only" }, 413),
  };
}

/** Push the fresh summary over the user's InboxDO socket (system event — not
 *  persisted in the message log; open AvaStorage screens animate live). */
export async function pushStorage(env: Env, uid: string, summary: StorageSummary): Promise<void> {
  try {
    const stub = env.INBOX.get(env.INBOX.idFromName(uid));
    await stub.fetch("https://inbox/event", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "storage", ...summary }),
    });
  } catch { /* best-effort — screens also refresh on open */ }
}

/** Post-registerFile hook: recompute → live push → analytics. Run via
 *  exec.waitUntil so the upload response never waits on it. */
export async function afterRegisterFile(
  env: Env, uid: string,
  file?: { kind: string; bytes: number; source_app: string; dedup: boolean },
): Promise<void> {
  const summary = await recomputeStorage(env, uid);
  await pushStorage(env, uid, summary);
  if (file) track(env, uid, "file_registered", file.source_app, { kind: file.kind, bytes: file.bytes, source_app: file.source_app, dedup: file.dedup });
}

// GET /api/storage/summary — used/quota/state/per-kind {count,bytes} + the
// last-6-months trend for the AvaStorage mini-bars. Reads the summary row only.
export async function getStorageSummary(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const s = await storageSummary(env, ctx.uid);
  const snaps = await mediaSession(env).prepare(
    "SELECT month, used_bytes FROM storage_snapshots WHERE uid=?1 ORDER BY month DESC LIMIT 6",
  ).bind(ctx.uid).all();
  const trend = ((snaps.results ?? []) as any[]).reverse();
  return json({ ...s, trend, free_gb: Number(env.STORAGE_FREE_GB || "5"), coins_per_gb_month: Number(env.STORAGE_COINS_PER_GB || "20") });
}
