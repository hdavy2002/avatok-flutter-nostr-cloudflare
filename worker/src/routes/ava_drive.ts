// ava_drive.ts — AvaTOK's own-file storage in the user's Google Drive.
//   POST /api/ava/drive/connect           → { url } (Google OAuth; calendar+drive)
//   GET  /api/ava/drive/status            → { connected, avatokBytes, totalUsage, totalLimit }
//   GET  /api/ava/drive/list              → { files }
//   POST /api/ava/drive/upload {bucket,name,mime,contentB64} → { file }
//
// Connect reuses the existing Google OAuth (cal/gcal.ts gcalConnect) — the same
// consent grants calendar.events + drive.file. Shared chat media is NOT here
// (stays on encrypted R2); this is only the user's OWN files.

import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import {
  driveList, driveUpload, driveUsage,
  driveEnsureBackupFolder, driveBackupUpload, driveBackupDownload, driveBackupList,
  type DriveBucket,
} from "../lib/drive";

const BUCKETS: DriveBucket[] = ["Photos", "Videos", "Files", "Backups", "Docs"];

export async function driveStatus(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  if (!env.GOOGLE_CLIENT_ID) return json({ connected: false, configured: false });
  try {
    return json(await driveUsage(env, ctx.uid));
  } catch (e: any) {
    return json({ connected: false, error: String(e?.message ?? e).slice(0, 160) });
  }
}

export async function driveListRoute(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  try {
    return json({ ok: true, files: await driveList(env, ctx.uid) });
  } catch (e: any) {
    return json({ error: "list failed", detail: String(e?.message ?? e).slice(0, 160) }, 502);
  }
}

// ── FREE backup lane (separate "avatok-backup" folder) ──────────────────────
// POST /api/ava/drive/backup/ensure              → { ready, folderId? }
// POST /api/ava/drive/backup/upload {name,contentB64} → { ok, file }
// GET  /api/ava/drive/backup/download?name=...    → raw bytes (404 if absent)

export async function driveBackupEnsureRoute(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  try {
    return json(await driveEnsureBackupFolder(env, ctx.uid));
  } catch (e: any) {
    return json({ ready: false, error: String(e?.message ?? e).slice(0, 160) }, 502);
  }
}

// GET /api/ava/drive/backup/list?prefix=... → { ok, files: [{name,size}] }
export async function driveBackupListRoute(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const prefix = (new URL(req.url).searchParams.get("prefix") ?? "").trim();
  try {
    return json({ ok: true, files: await driveBackupList(env, ctx.uid, prefix || undefined) });
  } catch (e: any) {
    return json({ error: "list failed", detail: String(e?.message ?? e).slice(0, 160) }, 502);
  }
}

export async function driveBackupUploadRoute(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  let b: any;
  try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const name = String(b.name ?? "").trim();
  const b64 = typeof b.contentB64 === "string" ? b.contentB64 : "";
  if (!name || !b64) return json({ error: "name and contentB64 required" }, 400);
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = await driveBackupUpload(env, ctx.uid, name, bytes);
    return json({ ok: true, file });
  } catch (e: any) {
    return json({ error: "upload failed", detail: String(e?.message ?? e).slice(0, 200) }, 502);
  }
}

export async function driveBackupDownloadRoute(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const name = (new URL(req.url).searchParams.get("name") ?? "").trim();
  if (!name) return json({ error: "name required" }, 400);
  try {
    const bytes = await driveBackupDownload(env, ctx.uid, name);
    if (!bytes) return new Response(null, { status: 404 });
    return new Response(bytes, { status: 200, headers: { "content-type": "application/octet-stream" } });
  } catch (e: any) {
    return json({ error: "download failed", detail: String(e?.message ?? e).slice(0, 200) }, 502);
  }
}

export async function driveUploadRoute(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  let b: any;
  try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const name = String(b.name ?? "").trim();
  const b64 = typeof b.contentB64 === "string" ? b.contentB64 : "";
  if (!name || !b64) return json({ error: "name and contentB64 required" }, 400);
  const bucket: DriveBucket = BUCKETS.includes(b.bucket) ? b.bucket : "Files";
  const mime = String(b.mime ?? "application/octet-stream");
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = await driveUpload(env, ctx.uid, bucket, name, mime, bytes);
    return json({ ok: true, file });
  } catch (e: any) {
    return json({ error: "upload failed", detail: String(e?.message ?? e).slice(0, 200) }, 502);
  }
}
