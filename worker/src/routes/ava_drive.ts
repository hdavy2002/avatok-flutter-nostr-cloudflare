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
import { driveList, driveUpload, driveUsage, type DriveBucket } from "../lib/drive";

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
