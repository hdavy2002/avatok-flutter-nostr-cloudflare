// [HF-CHANNEL-CORE-1 2026-10-23] PUT /api/hosts/me/photo -- the influencer uploads / replaces their own profile (hero) photo (owner decision D9).
// Same storage pattern as the admin media upload (routes/hf_creator_listings_admin.ts): BLOBS key hf/hosts/<uid>/..., an hf_host_media(kind='profile')
// row, older profile rows superseded. job_id stays NULL, so the public card reports imageProvenance 'uploaded' (label rule HF-AVA-1/5 unchanged).
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { rateLimit } from "../money";
import { trackUser, trackException } from "../hooks";
import { BRAND } from "../lib/brand";
import { emailFor } from "../lib/identity";
import { getHost, mediaUrl } from "../lib/hf_host_store";
import { HOST_PHOTO_MAX_BYTES, validateHostPhoto } from "../lib/hf_host_photo";
import { photoModerationOn, acceptCheckedPhoto } from "./hf_user_photos";

const APP = BRAND.slug;
const ROUTE = "/api/hosts/me/photo";
const err = (status: number, error: string, extra: Record<string, unknown> = {}) => json({ ok: false, error, ...extra }, status, { "cache-control": "no-store" });

/** Read at most `max` bytes; null when the body is larger. */
async function boundedBytes(req: Request, max: number): Promise<Uint8Array | null> {
  if (Number(req.headers.get("content-length") ?? 0) > max) return null;
  const buf = new Uint8Array(await req.arrayBuffer());
  return buf.byteLength > max ? null : buf;
}

export async function putHostPhoto(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error);
  const uid = u.uid;
  const track = (event: string, props: Record<string, unknown>) => {
    const p = (async () => { await trackUser(env, uid, await emailFor(env, uid).catch(() => null), event, APP, { area: "hf_host", ...props }); })().catch(() => { /* best-effort */ });
    if (ctx) ctx.waitUntil(p);
  };
  const host = await getHost(env, uid);
  if (!host) return err(404, "not_host", { message: "Create your host profile first." });
  // [HF-MOD-2] With the AI check on, the new photo is stored privately and Clef-flash checks it first (hf-mod-photo
  // queue); the current photo stays until it passes. 202 + the current avatarUrl so older app builds keep showing it.
  if (await photoModerationOn(env)) {
    const cur = await env.DB_META.prepare("SELECT r2_key FROM hf_host_media WHERE uid=?1 AND kind='profile' AND status='active' ORDER BY created_at DESC LIMIT 1").bind(uid).first<{ r2_key: string }>();
    return acceptCheckedPhoto(req, env, ctx, uid, "host", { avatarUrl: cur ? mediaUrl(env, cur.r2_key) : null, imageProvenance: "uploaded" });
  }
  const limited = await rateLimit(env, `hf_photo:${uid}`, 20, 3600);
  if (limited) return limited;
  const mime = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const bytes = await boundedBytes(req, HOST_PHOTO_MAX_BYTES).catch(() => null);
  const chk = validateHostPhoto(mime, bytes);
  if (!chk.ok) {
    track("host_profile_photo_rejected", { reason: chk.error });
    return err(chk.status, chk.error, { message: chk.message });
  }
  const now = Date.now();
  const key = `hf/hosts/${uid}/profile-${now}.${chk.ext}`;
  try {
    await env.BLOBS.put(key, bytes!, { httpMetadata: { contentType: chk.mime } });
    await env.DB_META.batch([
      env.DB_META.prepare("UPDATE hf_host_media SET status='superseded' WHERE uid=?1 AND kind='profile' AND status='active'").bind(uid),
      env.DB_META.prepare("INSERT INTO hf_host_media (id,uid,kind,r2_key,status,job_id,created_at) VALUES (?1,?2,'profile',?3,'active',NULL,?4)").bind(crypto.randomUUID(), uid, key, now),
    ]);
  } catch (e) {
    await env.BLOBS.delete(key).catch(() => undefined);
    await trackException(env, e, { uid, route: ROUTE, method: "PUT", handled: true, app_name: APP, extra: { area: "hf_host", step: "photo_store" } });
    return err(500, "store_failed", { message: "We could not save your picture. Please try again." });
  }
  track("host_profile_photo_uploaded", { bytes: bytes!.byteLength, width: chk.width, height: chk.height, mime: chk.mime, host_status: host.status });
  return json({ ok: true, avatarUrl: mediaUrl(env, key), imageProvenance: "uploaded" }, 200, { "cache-control": "no-store" });
}
