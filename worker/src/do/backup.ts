// BackupDO — per-user backup/sync coordinator for the premium R2 cross-device
// sync lane (Phase 10). ONE DO per uid (keyed by the verified Clerk uid). The
// DO is SQLite-backed (matches wrangler `[[migrations]] tag = "v6"`) and holds
// the per-user backup MANIFEST: the latest version pointer, per-chunk metadata
// (R2 key, byte size, sha256), and timestamps. It is the restore-coordination
// authority — a device asks "what's the latest manifest?" then pulls the blob.
//
// What lives WHERE:
//   • The encrypted backup BLOB itself lives in R2 (env.BACKUP_R2), keyed
//     `backup/<uid>/<version>/<chunk>` — large, content bytes, no egress fee.
//   • The MANIFEST (small metadata) lives in this DO's SQLite — strictly
//     serialized per user, so two devices pushing at once can't corrupt the
//     pointer (last write wins on `version`, monotonic).
//
// The DO never sees plaintext: the client encrypts the SQLite export BEFORE
// upload (AES-GCM, key derived from a per-account passphrase that never leaves
// the device). The DO/R2 store ciphertext only. See routes/backup.ts +
// app/lib/features/ava_backup/backup_service.dart for the scheme.
//
// Reached via stub.fetch with JSON { op, ... }. Ops:
//   manifest      → { version, updatedAt, totalBytes, chunks:[{idx,key,bytes,sha256}] }
//   put-manifest  → record a new version's manifest (called by backupPut after
//                   the route streams the blob into R2). Returns the new manifest.
//   bump          → reserve the next monotonic version number for an upload.
import type { Env } from "../types";
import { json } from "../util";

interface ChunkMeta {
  idx: number;
  key: string;     // R2 object key
  bytes: number;
  sha256: string;  // sha256 hex of the (encrypted) chunk bytes
}

export class BackupDO {
  private env: Env;
  private state: DurableObjectState;
  private sql: SqlStorage;

  constructor(state: DurableObjectState, env: Env) {
    this.env = env;
    this.state = state;
    this.sql = state.storage.sql;
    // version pointer (single row, k=1) — the latest committed backup version.
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS meta (k INTEGER PRIMARY KEY, latest INTEGER NOT NULL DEFAULT 0, next INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL DEFAULT 0)",
    );
    this.sql.exec("INSERT OR IGNORE INTO meta (k, latest, next, updated_at) VALUES (1,0,1,0)");
    // per-version manifest — one row per chunk of a backup version.
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS chunks (version INTEGER NOT NULL, idx INTEGER NOT NULL, r2_key TEXT NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL DEFAULT '', PRIMARY KEY (version, idx))",
    );
  }

  private metaRow(): { latest: number; next: number; updated_at: number } {
    const r = this.sql.exec("SELECT latest, next, updated_at FROM meta WHERE k=1").one() as any;
    return { latest: Number(r.latest), next: Number(r.next), updated_at: Number(r.updated_at) };
  }

  /** The committed-latest manifest, or null when no backup exists yet. */
  private latestManifest(): {
    version: number;
    updatedAt: number;
    totalBytes: number;
    chunks: ChunkMeta[];
  } | null {
    const m = this.metaRow();
    if (m.latest <= 0) return null;
    const rows = this.sql.exec(
      "SELECT idx, r2_key, bytes, sha256 FROM chunks WHERE version=?1 ORDER BY idx ASC",
      m.latest,
    ).toArray() as any[];
    const chunks: ChunkMeta[] = rows.map((r) => ({
      idx: Number(r.idx),
      key: String(r.r2_key),
      bytes: Number(r.bytes),
      sha256: String(r.sha256 ?? ""),
    }));
    return {
      version: m.latest,
      updatedAt: m.updated_at,
      totalBytes: chunks.reduce((a, c) => a + c.bytes, 0),
      chunks,
    };
  }

  async fetch(req: Request): Promise<Response> {
    let body: any = {};
    try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }

    switch (body.op) {
      case "manifest": {
        const man = this.latestManifest();
        const m = this.metaRow();
        return json({
          ok: true,
          exists: !!man,
          version: man?.version ?? 0,
          updatedAt: man?.updatedAt ?? 0,
          totalBytes: man?.totalBytes ?? 0,
          chunks: man?.chunks ?? [],
          nextVersion: m.next,
        });
      }

      case "bump": {
        // Reserve the next version number (monotonic). The route uploads R2
        // objects under this version, then calls put-manifest to commit it.
        const m = this.metaRow();
        const reserved = m.next;
        this.sql.exec("UPDATE meta SET next=?1 WHERE k=1", reserved + 1);
        return json({ ok: true, version: reserved });
      }

      case "put-manifest": {
        // Commit a fully-uploaded version. body: { version, chunks:[{idx,key,bytes,sha256}] }
        const version = Number(body.version || 0);
        const chunks: ChunkMeta[] = Array.isArray(body.chunks) ? body.chunks : [];
        if (version <= 0 || chunks.length === 0) return json({ error: "version + chunks required" }, 400);
        const now = Date.now();
        // Replace any partial rows for this version, then insert the manifest.
        this.sql.exec("DELETE FROM chunks WHERE version=?1", version);
        for (const c of chunks) {
          this.sql.exec(
            "INSERT INTO chunks (version, idx, r2_key, bytes, sha256) VALUES (?1,?2,?3,?4,?5)",
            version, Number(c.idx), String(c.key), Number(c.bytes), String(c.sha256 ?? ""),
          );
        }
        // Advance the latest pointer (monotonic; never regress) + keep `next` ahead.
        const m = this.metaRow();
        const latest = Math.max(m.latest, version);
        const next = Math.max(m.next, version + 1);
        this.sql.exec("UPDATE meta SET latest=?1, next=?2, updated_at=?3 WHERE k=1", latest, next, now);
        // Best-effort prune of superseded older versions' chunk rows (keep the
        // latest only — restore always pulls latest; R2 GC of old objects is the
        // route's job via the returned staleKeys list).
        const staleRows = this.sql.exec(
          "SELECT r2_key FROM chunks WHERE version<>?1", latest,
        ).toArray() as any[];
        const staleKeys = staleRows.map((r) => String(r.r2_key));
        this.sql.exec("DELETE FROM chunks WHERE version<>?1", latest);
        return json({ ok: true, version: latest, updatedAt: now, staleKeys });
      }

      default:
        return json({ error: "unknown op", op: body.op ?? null }, 400);
    }
  }
}
