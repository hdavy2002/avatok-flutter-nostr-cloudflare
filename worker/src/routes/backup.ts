// Backup & sync routes (Phase 10) — the PREMIUM R2 cross-device sync lane.
//
//   PUT  /api/backup         → backupPut    — store the caller's encrypted backup blob
//   GET  /api/backup         → backupGet    — return the caller's latest encrypted blob
//   GET  /api/backup/status  → backupStatus — manifest metadata (version/size/updated)
//
// All three are dual-auth (`requireUser` → verified Clerk uid). The uid scopes
// everything: R2 keys are `backup/<uid>/...` and the BackupDO is keyed by uid,
// so a user can only ever read/write their OWN backup.
//
// ENCRYPTION (zero-knowledge): the server stores CIPHERTEXT only. The Flutter
// client exports its on-device SQLite (the source of truth), encrypts it with
// AES-256-GCM under a key derived from a per-account passphrase that NEVER
// leaves the device, then PUTs the opaque blob here. Neither the Worker nor R2
// can read it. The DO holds only the small manifest (version, size, sha256,
// timestamps); R2 holds the encrypted bytes. See
// app/lib/features/ava_backup/backup_service.dart for the exact scheme.
//
// FREE Google Drive backup is a SEPARATE, client-only lane (the user's own
// Drive appDataFolder) and does NOT touch these routes — see
// app/lib/features/ava_backup/drive_client.dart.
//
// PREMIUM GATE — split client+server:
//   • Client: the "cross-device sync" action is wrapped in PaidFeature, so a
//     free user is sent to the top-up sheet before any upload.
//   • Server: backupPut additionally checks isEntitled(env, uid) and returns
//     402 for a non-entitled account (fail-safe; the wallet phase fills the real
//     check). GET/status are allowed regardless so an account that LAPSES can
//     still pull its last backup to restore (never strands a user's own data).
import type { Env } from "../types";
import { json, sha256Hex } from "../util";
import { requireUser, isFail } from "../authz";

// R2 object key for a uid's backup chunk. Single-blob today (idx 0); the
// manifest model supports multi-chunk if a backup ever exceeds a comfortable
// single-object size.
function chunkKey(uid: string, version: number, idx: number): string {
  return `backup/${uid}/${version}/${idx}`;
}

function doStub(env: Env, uid: string) {
  return env.BACKUP.get(env.BACKUP.idFromName(uid));
}

async function manifest(env: Env, uid: string): Promise<{
  exists: boolean; version: number; updatedAt: number; totalBytes: number;
  chunks: { idx: number; key: string; bytes: number; sha256: string }[];
  nextVersion: number;
}> {
  const r = await doStub(env, uid).fetch("https://do/manifest", {
    method: "POST",
    body: JSON.stringify({ op: "manifest" }),
  });
  return await r.json();
}

/** GET /api/backup/status — manifest metadata only (no bytes). */
export async function backupStatus(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const m = await manifest(env, ctx.uid);
  return json({
    ok: true,
    exists: m.exists,
    version: m.version,
    updatedAt: m.updatedAt,
    sizeBytes: m.totalBytes,
    chunks: m.chunks.length,
  });
}

/** GET /api/backup — stream back the latest encrypted backup blob. */
export async function backupGet(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const m = await manifest(env, ctx.uid);
  if (!m.exists || m.chunks.length === 0) return json({ error: "no backup" }, 404);

  // Single-blob fast path (the common case): stream the one object straight
  // through with the metadata headers the client needs to verify + decrypt.
  if (m.chunks.length === 1) {
    const c = m.chunks[0];
    const obj = await env.BACKUP_R2.get(c.key);
    if (!obj) return json({ error: "blob missing" }, 410);
    return new Response(obj.body, {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "x-backup-version": String(m.version),
        "x-backup-sha256": c.sha256,
        "x-backup-bytes": String(c.bytes),
        "x-backup-updated": String(m.updatedAt),
        // The blob is already encrypted client-side; do not let any layer cache it.
        "cache-control": "no-store",
      },
    });
  }

  // Multi-chunk: concatenate in order (chunks are small enough to hold; a
  // backup of this size is rare). Order is guaranteed by the DO's ORDER BY idx.
  const parts: Uint8Array[] = [];
  for (const c of m.chunks) {
    const obj = await env.BACKUP_R2.get(c.key);
    if (!obj) return json({ error: "blob missing", chunk: c.idx }, 410);
    parts.push(new Uint8Array(await obj.arrayBuffer()));
  }
  const total = parts.reduce((a, p) => a + p.length, 0);
  const all = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { all.set(p, off); off += p.length; }
  return new Response(all, {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "x-backup-version": String(m.version),
      "x-backup-bytes": String(m.totalBytes),
      "x-backup-updated": String(m.updatedAt),
      "cache-control": "no-store",
    },
  });
}

/** PUT /api/backup — store the caller's encrypted backup blob (premium). */
export async function backupPut(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);

  // Server-side premium gate (client also gates via PaidFeature). 402 → the
  // client routes to the top-up sheet. GET/status stay open so a lapsed account
  // can still restore its own last backup.
  if (!(await isEntitled(env, ctx.uid))) {
    return json({ error: "premium required", reason: "paid_sync" }, 402);
  }

  const buf = await req.arrayBuffer();
  if (buf.byteLength === 0) return json({ error: "empty body" }, 400);
  // Guardrail: a single PUT is one blob. ~95 MB ceiling keeps us well under
  // Worker/R2 single-request limits; larger devices should chunk client-side.
  if (buf.byteLength > 95 * 1024 * 1024) return json({ error: "backup too large; chunk it" }, 413);

  const bytes = new Uint8Array(buf);
  const digest = await sha256Hex(bytes);

  // Reserve a monotonic version, upload to R2 under it, then commit the manifest.
  const stub = doStub(env, ctx.uid);
  const bumpRes = await stub.fetch("https://do/bump", { method: "POST", body: JSON.stringify({ op: "bump" }) });
  const { version } = (await bumpRes.json()) as { version: number };

  const key = chunkKey(ctx.uid, version, 0);
  await env.BACKUP_R2.put(key, bytes, {
    httpMetadata: { contentType: "application/octet-stream" },
    customMetadata: { uid: ctx.uid, version: String(version), sha256: digest },
  });

  const commit = await stub.fetch("https://do/put-manifest", {
    method: "POST",
    body: JSON.stringify({
      op: "put-manifest",
      version,
      chunks: [{ idx: 0, key, bytes: bytes.length, sha256: digest }],
    }),
  });
  const out = (await commit.json()) as { ok: boolean; version: number; updatedAt: number; staleKeys?: string[] };

  // Best-effort GC of superseded versions' R2 objects (no egress cost; keeps
  // the bucket lean). Failure here never fails the backup.
  if (out.staleKeys && out.staleKeys.length) {
    try { await env.BACKUP_R2.delete(out.staleKeys); } catch { /* best-effort */ }
  }

  return json({ ok: true, version: out.version, updatedAt: out.updatedAt, sizeBytes: bytes.length, sha256: digest });
}

// ---------------------------------------------------------------------------
// Premium entitlement — mirrors routes/ava_tools.ts `isEntitled`. The real
// wallet/subscription authority lands with the wallet phase; until then this
// returns false (fail-safe: R2 sync requires an explicit premium signal, and
// the client PaidFeature wrap means the UX is the top-up sheet, not a dead end).
// The signature stays stable for the wallet phase to swap in a balance check.
// ---------------------------------------------------------------------------
async function isEntitled(_env: Env, _uid: string): Promise<boolean> {
  // TODO(wallet phase): check WalletDO balance / subscription entitlement for
  // _uid (e.g. a non-zero balance or an active "Ava premium" subscription row).
  return false;
}
