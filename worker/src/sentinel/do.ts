// Guardian Sentinel — S1 SentinelDO: per-user HOT CACHE ONLY.
//
// CONSTITUTIONAL RULE (do not violate): this DO is NEVER a system of record. It
// holds only ephemeral hot state — velocity windows, a last-N event-id dedup ring,
// and a per-bucket score cache. On crash/eviction it REHYDRATES from D1 (the
// append-only evidence log is the single owner of truth). If this DO's SQLite were
// wiped, nothing durable is lost: every score refolds from sentinel_evidence.
//
// One DO per user (idFromName(uid)). Internal ops (Worker → DO fetch):
//   POST /ingest  {event:{type,uid,payload,ts,source_event}}  → {ok, evidenceAdded, deduped}
//   GET  /score?bucket=<b>            → {bucket, score, band}
//   GET  /score                       → {buckets:{<b>:{score,band}}}  (all buckets)
//
// DARK behind sentinelEnabled — the Worker gates before routing here; the DO also
// self-checks via sentinelIngest's own gate. SQLite-backed class (wrangler migration
// v12) so it gets the durable-SQLite backend; it stores only hot caches.

import type { Env } from "../types";
import { track } from "../hooks";
import { SENTINEL_BUCKETS, isSentinelBucket, type SentinelBucket } from "./evidence";
import { score as foldScore, verifyReplay } from "./fold";
import { sentinelIngest } from "./ingest";
import type { SentinelEvent } from "./extractors";

const DEDUP_RING = 100;       // last-N processed event ids for idempotency
const CACHE_TTL_MS = 60_000;  // bucket score cache freshness

export class SentinelDO {
  private state: DurableObjectState;
  private sql: SqlStorage;
  private env: Env;
  // In-memory hot caches (lost on hibernation → rehydrated from SQLite/D1 on wake).
  private recentIds: string[] = [];
  private scoreCache = new Map<SentinelBucket, { score: number; band: string; at: number }>();
  private uid: string | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.sql = state.storage.sql;
    // Hot-cache tables only. NOT authoritative — pure caches, rebuildable from D1.
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS hot_meta (k TEXT PRIMARY KEY, v TEXT);
       CREATE TABLE IF NOT EXISTS hot_dedup (id TEXT PRIMARY KEY, at INTEGER NOT NULL);
       CREATE TABLE IF NOT EXISTS hot_score (
         bucket TEXT PRIMARY KEY, score REAL NOT NULL, band TEXT NOT NULL, at INTEGER NOT NULL
       );`,
    );
    // Rehydrate the dedup ring from SQLite (survives hibernation cheaply). A DO
    // eviction that also loses SQLite is fine — dedup is a best-effort optimisation;
    // appendEvidence is itself idempotent on the evidence id.
    try {
      const rows = this.sql.exec(`SELECT id FROM hot_dedup ORDER BY at DESC LIMIT ?`, DEDUP_RING).toArray();
      this.recentIds = rows.map((r) => String((r as { id: string }).id));
    } catch { /* fresh DO */ }
  }

  private getMeta(k: string): string | null {
    try { return String((this.sql.exec(`SELECT v FROM hot_meta WHERE k=?`, k).one() as { v: string }).v); }
    catch { return null; }
  }
  private setMeta(k: string, v: string): void {
    try { this.sql.exec(`INSERT INTO hot_meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=?`, k, v, v); }
    catch { /* best-effort */ }
  }

  private seen(id: string): boolean {
    if (!id) return false;
    if (this.recentIds.includes(id)) return true;
    try {
      const r = this.sql.exec(`SELECT id FROM hot_dedup WHERE id=?`, id).toArray();
      return r.length > 0;
    } catch { return false; }
  }
  private remember(id: string): void {
    if (!id) return;
    this.recentIds.unshift(id);
    if (this.recentIds.length > DEDUP_RING) this.recentIds.length = DEDUP_RING;
    try {
      this.sql.exec(`INSERT OR IGNORE INTO hot_dedup (id, at) VALUES (?, ?)`, id, Date.now());
      // Trim the persisted ring opportunistically.
      this.sql.exec(
        `DELETE FROM hot_dedup WHERE id NOT IN (SELECT id FROM hot_dedup ORDER BY at DESC LIMIT ?)`,
        DEDUP_RING,
      );
    } catch { /* best-effort */ }
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (url.pathname.endsWith("/ingest") && req.method === "POST") {
        return await this.ingest(await req.json());
      }
      if (url.pathname.endsWith("/score")) {
        return await this.scores(url.searchParams.get("bucket"));
      }
      if (url.pathname.endsWith("/replay")) {
        // Debug/verification: refold + compare, emit sentinel_replay_mismatch on drift.
        return await this.replay(url.searchParams.get("bucket"));
      }
    } catch (e: any) {
      return json({ error: String(e?.message ?? e) }, 500);
    }
    return json({ error: "not found" }, 404);
  }

  private async ingest(b: { event?: SentinelEvent }): Promise<Response> {
    const event = b?.event;
    if (!event || !event.uid || !event.type) return json({ ok: false, error: "bad event" }, 400);
    if (!this.uid) { this.uid = event.uid; if (!this.getMeta("uid")) this.setMeta("uid", event.uid); }

    // Dedup on the source_event id (cheap idempotency in the hot path; the durable
    // log is idempotent on the evidence id too).
    const dedupKey = String(event.source_event ?? `${event.type}:${event.ts ?? ""}`);
    if (this.seen(dedupKey)) {
      return json({ ok: true, evidenceAdded: 0, deduped: true });
    }
    this.remember(dedupKey);

    const res = await sentinelIngest(this.env, event, { source: "sentinel_do" });
    // Invalidate the bucket score cache so /score re-folds fresh next read.
    this.scoreCache.clear();
    try { this.sql.exec(`DELETE FROM hot_score`); } catch { /* */ }

    if (!res.ingested && res.reason === "error") {
      // A rehydration-worthy failure: surface it (telemetry) but never throw.
      void track(this.env, event.uid, "sentinel_do_rehydrated", "sentinel", { reason: "ingest_error" });
    }
    return json({ ok: res.ingested, evidenceAdded: res.evidenceAdded, reason: res.reason ?? null });
  }

  private async oneScore(bucket: SentinelBucket): Promise<{ score: number; band: string }> {
    const now = Date.now();
    const cached = this.scoreCache.get(bucket);
    if (cached && now - cached.at < CACHE_TTL_MS) return { score: cached.score, band: cached.band };
    // Cache miss → fold from D1 (the owner of truth). This IS the rehydration path.
    const s = await foldScore(this.env, this.uid ?? this.getMeta("uid") ?? "", bucket, now);
    this.scoreCache.set(bucket, { score: s.score, band: s.band, at: now });
    try { this.sql.exec(`INSERT INTO hot_score (bucket,score,band,at) VALUES (?,?,?,?)
      ON CONFLICT(bucket) DO UPDATE SET score=?, band=?, at=?`, bucket, s.score, s.band, now, s.score, s.band, now); }
    catch { /* */ }
    return { score: s.score, band: s.band };
  }

  private async scores(bucketParam: string | null): Promise<Response> {
    if (!this.uid) this.uid = this.getMeta("uid");
    if (bucketParam) {
      if (!isSentinelBucket(bucketParam)) return json({ error: "unknown bucket" }, 400);
      const s = await this.oneScore(bucketParam);
      return json({ bucket: bucketParam, ...s });
    }
    const buckets: Record<string, { score: number; band: string }> = {};
    for (const b of SENTINEL_BUCKETS) buckets[b] = await this.oneScore(b);
    return json({ buckets });
  }

  private async replay(bucketParam: string | null): Promise<Response> {
    const uid = this.uid ?? this.getMeta("uid");
    if (!uid) return json({ error: "no uid" }, 400);
    const targets = bucketParam && isSentinelBucket(bucketParam) ? [bucketParam as SentinelBucket] : SENTINEL_BUCKETS;
    const results: Record<string, { cached: number; folded: number; mismatch: boolean }> = {};
    for (const b of targets) {
      const r = await verifyReplay(this.env, uid, b);
      results[b] = r;
      if (r.mismatch) {
        void track(this.env, uid, "sentinel_replay_mismatch", "sentinel", {
          bucket: b, cached: r.cached, folded: r.folded,
        });
      }
    }
    return json({ ok: true, results });
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
