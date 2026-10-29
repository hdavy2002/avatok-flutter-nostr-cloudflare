// [HF-MOD-2 2026-10-29] Photos every user owns (fan profile + cover, influencer photo), checked by Clef-flash through
// the hf-mod-photo queue before they can be seen (rulebook HF-MOD-4). While checking, the OLD photo stays; a refused or
// failed photo is deleted and never public. Pending bytes live in the PRIVATE DIGITAL bucket; a passed photo is copied
// to the public BLOBS bucket.
import type { Env } from "../types";
import { parseImageInfo, IMAGE_EXT, type ImageMime } from "./studio_logic";
import { mediaUrl } from "./hf_host_store";
import { json } from "../util";
import { track } from "../hooks";
import { BRAND } from "./brand";
import { readConfig } from "../routes/config";
import { enqueueModeration, onModerationResult, refusalMessage, handleModerationQueue, type ModJobRow, type ModKind } from "./hf_moderation";

export type UserPhotoKind = "profile" | "cover" | "host";
/** Clef-flash takes at most 4 MiB per image. The app and website shrink photos to ~100-300 KB before upload. */
export const USER_PHOTO_MAX_BYTES = 4 * 1024 * 1024;
const MIN: Record<UserPhotoKind, { w: number; h: number }> = { profile: { w: 200, h: 200 }, cover: { w: 640, h: 200 }, host: { w: 600, h: 750 } };
const MOD_KIND: Record<UserPhotoKind, ModKind> = { profile: "profile_photo", cover: "cover_photo", host: "host_photo" };
const KIND_OF: Partial<Record<ModKind, UserPhotoKind>> = { profile_photo: "profile", cover_photo: "cover", host_photo: "host" };

export type UserPhotoCheck =
  | { ok: true; mime: ImageMime; ext: string; width: number; height: number }
  | { ok: false; status: number; error: "bad_type" | "too_big" | "too_small" | "empty"; message: string };

/** Pure: type sniffed from the bytes, size, minimum dimensions per kind. */
export function validateUserPhoto(kind: UserPhotoKind, declaredMime: string, bytes: Uint8Array | null): UserPhotoCheck {
  const mime = declaredMime.split(";")[0].trim().toLowerCase();
  if (!bytes) return { ok: false, status: 413, error: "too_big", message: "Please choose a smaller photo (under 4 MB)." };
  if (bytes.byteLength < 100) return { ok: false, status: 400, error: "empty", message: "We did not get the photo. Please try again." };
  if (bytes.byteLength > USER_PHOTO_MAX_BYTES) return { ok: false, status: 413, error: "too_big", message: "Please choose a smaller photo (under 4 MB)." };
  const info = parseImageInfo(bytes);
  if (!info || info.mime !== mime) return { ok: false, status: 415, error: "bad_type", message: "Please choose a JPEG, PNG or WebP photo." };
  const m = MIN[kind];
  if (info.w < m.w || info.h < m.h) return { ok: false, status: 422, error: "too_small", message: `The photo must be at least ${m.w} x ${m.h} pixels.` };
  return { ok: true, mime: info.mime, ext: IMAGE_EXT[info.mime], width: info.w, height: info.h };
}

export interface UserPhotoRow {
  id: string; uid: string; kind: UserPhotoKind; pending_key: string | null; public_key: string | null; mime: string; bytes: number;
  width: number | null; height: number | null; status: "checking" | "active" | "refused" | "failed" | "superseded"; reason: string | null; job_id: string | null;
  created_at: number; updated_at: number;
}

/** Store privately, write the row, queue the check. Never public until Clef passes it. */
export async function storeCheckedPhoto(env: Env, ctx: ExecutionContext | undefined, uid: string, kind: UserPhotoKind, bytes: Uint8Array, chk: { mime: string; ext: string; width: number; height: number }): Promise<{ id: string; jobId: string }> {
  const id = "hfph_" + crypto.randomUUID().replace(/-/g, "").slice(0, 20);
  const now = Date.now();
  const pending = `hf-mod/pending/${uid}/${kind}-${id}.${chk.ext}`;
  await env.DIGITAL.put(pending, bytes, { httpMetadata: { contentType: chk.mime } });
  try {
    await env.DB_META.prepare("INSERT INTO hf_user_photos (id,uid,kind,pending_key,public_key,mime,bytes,width,height,status,reason,job_id,created_at,updated_at) VALUES (?1,?2,?3,?4,NULL,?5,?6,?7,?8,'checking',NULL,NULL,?9,?9)")
      .bind(id, uid, kind, pending, chk.mime, bytes.byteLength, chk.width, chk.height, now).run();
  } catch (e) {
    await env.DIGITAL.delete(pending).catch(() => undefined);
    throw e;
  }
  const jobId = await enqueueModeration(env, { uid, kind: MOD_KIND[kind], subjectId: id, r2Key: pending, mime: chk.mime, bytes: bytes.byteLength }, ctx);
  await env.DB_META.prepare("UPDATE hf_user_photos SET job_id=?2 WHERE id=?1").bind(id, jobId).run();
  return { id, jobId };
}

/** Applies Clef's result to the photo: passed -> public + replaces the old one; anything else -> deleted, old photo stays. */
async function photoOutcome(env: Env, job: ModJobRow, result: { status: string; reasons: string[] }): Promise<void> {
  const row = await env.DB_META.prepare("SELECT * FROM hf_user_photos WHERE id=?1").bind(job.subject_id).first<UserPhotoRow>();
  if (!row || row.status !== "checking") return;
  const now = Date.now();
  if (result.status !== "passed") {
    const reason = result.status === "refused" ? refusalMessage(result.reasons) : "We couldn't check this photo. Please try again.";
    await env.DB_META.prepare("UPDATE hf_user_photos SET status=?2, reason=?3, pending_key=NULL, updated_at=?4 WHERE id=?1").bind(row.id, result.status === "refused" ? "refused" : "failed", reason, now).run();
    if (row.pending_key) await env.DIGITAL.delete(row.pending_key).catch(() => undefined);
    return;
  }
  const obj = row.pending_key ? await env.DIGITAL.get(row.pending_key) : null;
  if (!obj) {
    await env.DB_META.prepare("UPDATE hf_user_photos SET status='failed', reason=?2, updated_at=?3 WHERE id=?1").bind(row.id, "We couldn't check this photo. Please try again.", now).run();
    return;
  }
  const ext = IMAGE_EXT[row.mime as ImageMime] ?? "jpg";
  const pub = row.kind === "host" ? `hf/hosts/${row.uid}/profile-${now}.${ext}` : `hf/users/${row.uid}/${row.kind}-${row.id}.${ext}`;
  await env.BLOBS.put(pub, await obj.arrayBuffer(), { httpMetadata: { contentType: row.mime } });
  const stmts = [
    env.DB_META.prepare("UPDATE hf_user_photos SET status='superseded', updated_at=?3 WHERE uid=?1 AND kind=?2 AND status='active'").bind(row.uid, row.kind, now),
    env.DB_META.prepare("UPDATE hf_user_photos SET status='active', public_key=?2, pending_key=NULL, updated_at=?3 WHERE id=?1").bind(row.id, pub, now),
  ];
  if (row.kind === "host") {
    // Same rows the influencer profile has always used (hf_host_photo.ts before HF-MOD-2).
    stmts.push(env.DB_META.prepare("UPDATE hf_host_media SET status='superseded' WHERE uid=?1 AND kind='profile' AND status='active'").bind(row.uid));
    stmts.push(env.DB_META.prepare("INSERT INTO hf_host_media (id,uid,kind,r2_key,status,job_id,created_at) VALUES (?1,?2,'profile',?3,'active',NULL,?4)").bind(crypto.randomUUID(), row.uid, pub, now));
  }
  await env.DB_META.batch(stmts);
  await env.DIGITAL.delete(row.pending_key!).catch(() => undefined);
  // [HF-MOD-3] owner: a fan's checked profile photo shows next to their reel comments (they read users.avatar_url).
  if (row.kind === "profile") await env.DB_META.prepare("UPDATE users SET avatar_url=?2 WHERE uid=?1").bind(row.uid, mediaUrl(env, pub)).run().catch(() => undefined);
}

onModerationResult("profile_photo", photoOutcome);
onModerationResult("cover_photo", photoOutcome);
onModerationResult("host_photo", photoOutcome);

/** Re-exported from here so importing the consumer always registers the photo outcomes first. */
export { handleModerationQueue };

export interface PhotoState { url: string | null; checking: boolean; refused: string | null }
/** The person's own view: the live photo, whether a new one is being checked, and why the last one was refused. */
export async function myPhotos(env: Env, uid: string): Promise<Record<"profile" | "cover" | "host", PhotoState>> {
  const rows = (await env.DB_META.prepare("SELECT * FROM hf_user_photos WHERE uid=?1 ORDER BY created_at DESC, rowid DESC LIMIT 40").bind(uid).all<UserPhotoRow>()).results ?? [];
  const out = {} as Record<UserPhotoKind, PhotoState>;
  for (const k of ["profile", "cover", "host"] as const) {
    const mine = rows.filter((r) => r.kind === k);
    const active = mine.find((r) => r.status === "active");
    const latest = mine[0];
    out[k] = {
      url: active?.public_key ? mediaUrl(env, active.public_key) : null,
      checking: latest?.status === "checking",
      refused: latest && latest !== active && (latest.status === "refused" || latest.status === "failed") ? latest.reason : null, // the newest try failed
    };
  }
  return out;
}

export const userPhotoKindOf = (k: ModKind) => KIND_OF[k] ?? null;

// ── [HF-PHOTO-GATE-API] no call, booking or queue join without an approved profile photo AND cover photo ─────────────────────────────────────
export type MissingPhoto = "profile" | "cover";
export const PHOTOS_REQUIRED_MESSAGE = "Please add your profile photo and cover photo before you call or book.";

/** Pure. An active profile photo (or an active influencer photo, which counts as the profile) plus an active cover. */
export function missingPhotos(active: ReadonlySet<string>): MissingPhoto[] {
  const out: MissingPhoto[] = [];
  if (!active.has("profile") && !active.has("host")) out.push("profile");
  if (!active.has("cover")) out.push("cover");
  return out;
}

export async function missingPhotosFor(env: Env, uid: string): Promise<MissingPhoto[]> {
  const rows = (await env.DB_META.prepare("SELECT DISTINCT kind FROM hf_user_photos WHERE uid=?1 AND status='active'").bind(uid).all<{ kind: string }>()).results ?? [];
  return missingPhotos(new Set(rows.map((r) => r.kind)));
}

export async function hasRequiredPhotos(env: Env, uid: string): Promise<boolean> {
  return (await missingPhotosFor(env, uid)).length === 0;
}

/** null = allowed. With hfPhotosRequiredEnabled on and a photo missing: 403 photos_required. Fails open on a read error (never locks everyone out). */
export async function photosRequiredBlock(env: Env, uid: string, action: "call" | "booking" | "queue"): Promise<Response | null> {
  try {
    if ((await readConfig(env)).hfPhotosRequiredEnabled !== true) return null;
    const missing = await missingPhotosFor(env, uid);
    if (!missing.length) return null;
    void track(env, uid, "hf_photo_gate_block", BRAND.slug, { area: "hf_photo_gate", action, missing: missing.join(",") }).catch(() => undefined);
    return json({ ok: false, error: "photos_required", message: PHOTOS_REQUIRED_MESSAGE, missing }, 403, { "cache-control": "no-store" });
  } catch { return null; }
}
