// drive.ts — AvaTOK file storage in the user's OWN Google Drive (Hybrid model).
//
// The user's own files (AvaChat attachments, backups, things they save) live in
// an "AvaTOK" folder in THEIR Google Drive, via the `drive.file` scope (we can
// only see/touch files AvaTOK created — privacy-friendly + no restricted-scope
// verification). Shared chat media stays on encrypted R2 (cross-user). The
// Google connection + token refresh is reused from cal/gcal.ts (gcalAccessToken).

import type { Env } from "../types";
import { gcalAccessToken } from "../cal/gcal";

const DRIVE = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";

/** Valid AvaTOK subfolders (kept tidy so the user sees clear buckets). */
export type DriveBucket = "Photos" | "Videos" | "Files" | "Backups" | "Docs";

async function findFolder(at: string, name: string, parentId: string): Promise<string | null> {
  const q = `name='${name.replace(/'/g, "")}' and mimeType='${FOLDER_MIME}' and trashed=false and '${parentId}' in parents`;
  const r = await fetch(`${DRIVE}/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`, {
    headers: { Authorization: `Bearer ${at}` },
  });
  if (!r.ok) return null;
  const j: any = await r.json();
  return j?.files?.[0]?.id ?? null;
}

async function createFolder(at: string, name: string, parentId: string): Promise<string> {
  const r = await fetch(`${DRIVE}/files?fields=id`, {
    method: "POST",
    headers: { Authorization: `Bearer ${at}`, "content-type": "application/json" },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
  });
  if (!r.ok) throw new Error(`drive folder ${r.status}: ${(await r.text().catch(() => "")).slice(0, 160)}`);
  return (await r.json() as any).id;
}

async function ensureFolder(at: string, name: string, parentId: string): Promise<string> {
  return (await findFolder(at, name, parentId)) ?? (await createFolder(at, name, parentId));
}

/** Get-or-create the AvaTOK root folder (+ optional bucket subfolder). */
export async function ensureAvatokFolder(at: string, bucket?: DriveBucket): Promise<string> {
  const root = await ensureFolder(at, "AvaTOK", "root");
  return bucket ? ensureFolder(at, bucket, root) : root;
}

export interface DriveFile { id: string; name: string; mimeType?: string; size?: string; createdTime?: string; webViewLink?: string; thumbnailLink?: string; hasThumbnail?: boolean; }

/** Multipart-upload raw bytes into the user's AvaTOK/<bucket> folder. */
export async function driveUpload(
  env: Env, uid: string, bucket: DriveBucket, name: string, mime: string, bytes: Uint8Array,
): Promise<DriveFile> {
  const at = await gcalAccessToken(env, uid);
  if (!at) throw new Error("Google Drive not connected");
  const folderId = await ensureAvatokFolder(at, bucket);
  const boundary = "avatok" + crypto.randomUUID().replace(/-/g, "");
  const enc = new TextEncoder();
  const meta = JSON.stringify({ name, parents: [folderId] });
  const pre = enc.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`);
  const post = enc.encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(pre.length + bytes.length + post.length);
  body.set(pre, 0); body.set(bytes, pre.length); body.set(post, pre.length + bytes.length);
  const r = await fetch(`${UPLOAD}/files?uploadType=multipart&fields=id,name,mimeType,size,createdTime,webViewLink`, {
    method: "POST",
    headers: { Authorization: `Bearer ${at}`, "content-type": `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!r.ok) throw new Error(`drive upload ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  return r.json();
}

/** List AvaTOK files (drive.file scope only returns files WE created → all
 *  AvaTOK content, no cross-contamination with the rest of the user's Drive). */
export async function driveList(env: Env, uid: string, pageSize = 200): Promise<DriveFile[]> {
  const at = await gcalAccessToken(env, uid);
  if (!at) return [];
  const q = `trashed=false and mimeType!='${FOLDER_MIME}'`;
  const r = await fetch(`${DRIVE}/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,size,createdTime,webViewLink,thumbnailLink,hasThumbnail)&pageSize=${pageSize}&orderBy=createdTime desc`, {
    headers: { Authorization: `Bearer ${at}` },
  });
  if (!r.ok) return [];
  const j: any = await r.json();
  return j?.files ?? [];
}

/** Fetch one file's preview thumbnail bytes (auth-gated → must use the user's
 *  token). Used by the signed /api/ava/genui/thumb proxy. `size` sizes Google's
 *  thumbnail via its =s<N> param. Returns null if the file has no thumbnail. */
export async function driveThumbnailById(
  env: Env, uid: string, fileId: string, size = 320,
): Promise<{ bytes: ArrayBuffer; contentType: string } | null> {
  const at = await gcalAccessToken(env, uid);
  if (!at) return null;
  const m = await fetch(`${DRIVE}/files/${encodeURIComponent(fileId)}?fields=thumbnailLink,hasThumbnail`, {
    headers: { Authorization: `Bearer ${at}` },
  });
  if (!m.ok) return null;
  const meta: any = await m.json();
  let link: string = meta?.thumbnailLink || "";
  if (!link) return null;
  // Request a right-sized thumbnail (Google sizing param: =s<N>, optionally -c).
  link = link.replace(/=s\d+(-[a-z]+)?$/i, `=s${size}`);
  // thumbnailLink is sometimes a pre-signed googleusercontent URL (rejects the
  // bearer) and sometimes needs it — try authed first, then bare.
  let img = await fetch(link, { headers: { Authorization: `Bearer ${at}` } });
  if (!img.ok) img = await fetch(link);
  if (!img.ok) return null;
  return { bytes: await img.arrayBuffer(), contentType: img.headers.get("content-type") || "image/jpeg" };
}

// ── FREE backup lane: a dedicated, user-visible "avatok-backup" folder ────────
// The free Drive backup blob (client-side encrypted SQLite) lives in its OWN
// top-level "avatok-backup" folder in the user's Drive — separate from the
// "AvaTOK" app folder so the user clearly sees their backups. Created on demand
// when the user connects Drive from Settings. drive.file scope means we only ever
// see files AvaTOK created, so this never touches the rest of their Drive.
const BACKUP_FOLDER = "avatok-backup";

async function findFileInFolder(at: string, name: string, parentId: string): Promise<string | null> {
  const q = `name='${name.replace(/'/g, "")}' and trashed=false and '${parentId}' in parents`;
  const r = await fetch(`${DRIVE}/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`, {
    headers: { Authorization: `Bearer ${at}` },
  });
  if (!r.ok) return null;
  const j: any = await r.json();
  return j?.files?.[0]?.id ?? null;
}

/** Get-or-create the user's separate "avatok-backup" Drive folder. */
async function ensureBackupFolder(at: string): Promise<string> {
  return ensureFolder(at, BACKUP_FOLDER, "root");
}

/** Ensure the avatok-backup folder exists; surfaces readiness to the client so
 *  the Settings backup buttons only enable once Drive is connected AND the
 *  folder is in place. */
export async function driveEnsureBackupFolder(env: Env, uid: string): Promise<{ ready: boolean; folderId?: string }> {
  const at = await gcalAccessToken(env, uid);
  if (!at) return { ready: false };
  const folderId = await ensureBackupFolder(at);
  return { ready: true, folderId };
}

/** Create-or-replace a named backup blob inside the avatok-backup folder. */
export async function driveBackupUpload(env: Env, uid: string, name: string, bytes: Uint8Array): Promise<DriveFile> {
  const at = await gcalAccessToken(env, uid);
  if (!at) throw new Error("Google Drive not connected");
  const folderId = await ensureBackupFolder(at);
  const existing = await findFileInFolder(at, name, folderId);
  const mime = "application/octet-stream";
  if (existing) {
    // Replace the media of the existing backup (keeps the same fileId).
    const r = await fetch(`${UPLOAD}/files/${existing}?uploadType=media&fields=id,name,size`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${at}`, "content-type": mime },
      body: bytes,
    });
    if (!r.ok) throw new Error(`drive backup update ${r.status}: ${(await r.text().catch(() => "")).slice(0, 160)}`);
    return r.json();
  }
  const boundary = "avatok" + crypto.randomUUID().replace(/-/g, "");
  const enc = new TextEncoder();
  const meta = JSON.stringify({ name, parents: [folderId] });
  const pre = enc.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`);
  const post = enc.encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(pre.length + bytes.length + post.length);
  body.set(pre, 0); body.set(bytes, pre.length); body.set(post, pre.length + bytes.length);
  const r = await fetch(`${UPLOAD}/files?uploadType=multipart&fields=id,name,size`, {
    method: "POST",
    headers: { Authorization: `Bearer ${at}`, "content-type": `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!r.ok) throw new Error(`drive backup upload ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  return r.json();
}

/** Download a named backup blob from the avatok-backup folder; null if absent. */
export async function driveBackupDownload(env: Env, uid: string, name: string): Promise<Uint8Array | null> {
  const at = await gcalAccessToken(env, uid);
  if (!at) return null;
  const folderId = await ensureBackupFolder(at);
  const id = await findFileInFolder(at, name, folderId);
  if (!id) return null;
  const r = await fetch(`${DRIVE}/files/${id}?alt=media`, { headers: { Authorization: `Bearer ${at}` } });
  if (!r.ok) return null;
  return new Uint8Array(await r.arrayBuffer());
}

export interface DriveUsage { connected: boolean; avatokBytes: number; totalUsage: number; totalLimit: number; }

/** AvaTOK bytes (sum of app-created files) + the account's total Drive usage. */
export async function driveUsage(env: Env, uid: string): Promise<DriveUsage> {
  const at = await gcalAccessToken(env, uid);
  if (!at) return { connected: false, avatokBytes: 0, totalUsage: 0, totalLimit: 0 };
  let totalUsage = 0, totalLimit = 0;
  try {
    const about: any = await (await fetch(`${DRIVE}/about?fields=storageQuota`, { headers: { Authorization: `Bearer ${at}` } })).json();
    totalUsage = Number(about?.storageQuota?.usage ?? 0);
    totalLimit = Number(about?.storageQuota?.limit ?? 0);
  } catch { /* best-effort */ }
  const files = await driveList(env, uid);
  const avatokBytes = files.reduce((s, f) => s + Number(f.size ?? 0), 0);
  return { connected: true, avatokBytes, totalUsage, totalLimit };
}
