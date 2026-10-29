// [HF-MOD-2 2026-10-29] Photo uploads for every user, checked by Clef-flash through the hf-mod-photo queue.
//   PUT  /api/hf/me/photo            raw image body (jpeg|png|webp, <= 4 MB) -> { ok, status:'checking', id }
//   PUT  /api/hf/me/cover            same, cover photo
//   GET  /api/hf/me/photos           -> { ok, photos: { profile|cover|host: { url, checking, refused } } }
//   GET  /api/admin/hf/moderation/queue   admin: counts per kind/status + average wait (the admin "Queue" card)
//   POST /api/admin/hf/moderation/try     admin: raw image body -> Clef-flash answers + decision; nothing is stored
// Behind hfPhotoModerationEnabled (default off): off -> 404 not_enabled.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { rateLimit } from "../money";
import { trackUser, trackException } from "../hooks";
import { BRAND } from "../lib/brand";
import { emailFor } from "../lib/identity";
import { isAdminUid } from "../lib/preview";
import { readConfig } from "./config";
import { validateUserPhoto, storeCheckedPhoto, myPhotos, missingPhotosFor, USER_PHOTO_MAX_BYTES, type UserPhotoKind } from "../lib/hf_user_photos";
import { askClef, decidePhoto, moderationQueueStats } from "../lib/hf_moderation";

const APP = BRAND.slug;
const NO_STORE = { "cache-control": "no-store" };
const err = (status: number, error: string, extra: Record<string, unknown> = {}) => json({ ok: false, error, ...extra }, status, NO_STORE);

export async function photoModerationOn(env: Env): Promise<boolean> {
  try { return (await readConfig(env)).hfPhotoModerationEnabled === true; } catch { return false; } // no config = the old path
}

async function boundedBytes(req: Request, max: number): Promise<Uint8Array | null> {
  if (Number(req.headers.get("content-length") ?? 0) > max) return null;
  const buf = new Uint8Array(await req.arrayBuffer());
  return buf.byteLength > max ? null : buf;
}

/** Shared by fan photos and the influencer photo (hf_host_photo.ts when the switch is on). */
export async function acceptCheckedPhoto(req: Request, env: Env, ctx: ExecutionContext | undefined, uid: string, kind: UserPhotoKind, extra: Record<string, unknown> = {}): Promise<Response> {
  const track = (event: string, props: Record<string, unknown>) => {
    const p = (async () => { await trackUser(env, uid, await emailFor(env, uid).catch(() => null), event, APP, { area: "hf_moderation", kind, ...props }); })().catch(() => undefined);
    if (ctx) ctx.waitUntil(p);
  };
  const limited = await rateLimit(env, `hf_userphoto:${uid}`, 20, 3600);
  if (limited) return limited;
  const mime = req.headers.get("content-type") ?? "";
  const bytes = await boundedBytes(req, USER_PHOTO_MAX_BYTES).catch(() => null);
  const chk = validateUserPhoto(kind, mime, bytes);
  if (!chk.ok) {
    track("hf_photo_upload", { ok: false, reason: chk.error });
    return err(chk.status, chk.error, { message: chk.message });
  }
  try {
    const { id } = await storeCheckedPhoto(env, ctx, uid, kind, bytes!, chk);
    track("hf_photo_upload", { ok: true, bytes: bytes!.byteLength, width: chk.width, height: chk.height });
    return json({ ok: true, id, status: "checking", message: "Checking your new photo…", ...extra }, 202, NO_STORE);
  } catch (e) {
    await trackException(env, e, { uid, route: "/api/hf/me/photo", method: "PUT", handled: true, app_name: APP, extra: { area: "hf_moderation", kind } });
    return err(500, "store_failed", { message: "We could not save your photo. Please try again." });
  }
}

export async function hfUserPhotosRoute(req: Request, env: Env, p: string, ctx?: ExecutionContext): Promise<Response | null> {
  const m = req.method;
  const mine = p === "/api/hf/me/photo" || p === "/api/hf/me/cover" || p === "/api/hf/me/photos";
  const admin = p === "/api/admin/hf/moderation/queue" || p === "/api/admin/hf/moderation/try";
  if (!mine && !admin) return null;
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error);
  if (admin) {
    if (!isAdminUid(env, u.uid)) return err(403, "forbidden");
    if (p === "/api/admin/hf/moderation/queue" && m === "GET") return json({ ok: true, ...(await moderationQueueStats(env)) }, 200, NO_STORE);
    if (p === "/api/admin/hf/moderation/try" && m === "POST") {
      const mime = req.headers.get("content-type") ?? "";
      const bytes = await boundedBytes(req, USER_PHOTO_MAX_BYTES).catch(() => null);
      const chk = validateUserPhoto("profile", mime, bytes);
      if (!chk.ok) return err(chk.status, chk.error, { message: chk.message });
      try {
        const r = await askClef(env, "profile_photo", bytes!, chk.mime);
        return json({ ok: true, probs: r.probs, decision: decidePhoto(r.probs, "profile_photo"), model: r.model, inTokens: r.inTokens, ms: r.ms }, 200, NO_STORE);
      } catch (e) {
        return err(502, "clef_failed", { message: String(e).slice(0, 200) });
      }
    }
    return err(405, "method_not_allowed");
  }
  if (!(await photoModerationOn(env))) return err(404, "not_enabled");
  if (p === "/api/hf/me/photos" && m === "GET") {
    const missing = await missingPhotosFor(env, u.uid).catch(() => [] as ("profile" | "cover")[]);
    return json({ ok: true, photos: await myPhotos(env, u.uid), photos_complete: missing.length === 0, photos_missing: missing }, 200, NO_STORE);
  }
  if ((p === "/api/hf/me/photo" || p === "/api/hf/me/cover") && m === "PUT") return acceptCheckedPhoto(req, env, ctx, u.uid, p.endsWith("/cover") ? "cover" : "profile");
  return err(405, "method_not_allowed");
}
