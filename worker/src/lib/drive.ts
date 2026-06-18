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

export interface DriveFile { id: string; name: string; mimeType?: string; size?: string; createdTime?: string; webViewLink?: string; }

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
  const r = await fetch(`${DRIVE}/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,size,createdTime,webViewLink)&pageSize=${pageSize}&orderBy=createdTime desc`, {
    headers: { Authorization: `Bearer ${at}` },
  });
  if (!r.ok) return [];
  const j: any = await r.json();
  return j?.files ?? [];
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
