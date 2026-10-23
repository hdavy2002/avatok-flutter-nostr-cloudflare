// [HF-CHANNEL-CORE-1 2026-10-23] Influencer self-upload of the profile (hero) photo. Pure validation, no I/O.
// Spec C1: raw body = image bytes, jpeg|png|webp, <= 10 MB, >= 600x750, magic bytes checked (not just the header).
// Owner rule HF-AVA-1/5 is unchanged: the photo is the influencer's chosen AI avatar and the public label stays.
import { parseImageInfo, IMAGE_EXT, type ImageMime } from "./studio_logic";

export const HOST_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
export const HOST_PHOTO_MIN_W = 600;
export const HOST_PHOTO_MIN_H = 750;
export const HOST_PHOTO_MIMES: readonly string[] = ["image/jpeg", "image/png", "image/webp"];

export type HostPhotoCheck =
  | { ok: true; mime: ImageMime; ext: string; width: number; height: number }
  | { ok: false; status: number; error: "bad_type" | "too_big" | "too_small"; message: string };

/** `declaredMime` is the request content-type (parameters already stripped); the bytes must really be that format. */
export function validateHostPhoto(declaredMime: string, bytes: Uint8Array | null): HostPhotoCheck {
  const fail = (error: "bad_type" | "too_big" | "too_small", message: string): HostPhotoCheck => ({ ok: false, status: 400, error, message });
  if (!HOST_PHOTO_MIMES.includes(declaredMime)) return fail("bad_type", "Send a JPEG, PNG or WebP picture.");
  if (!bytes) return fail("too_big", "The picture must be 10 MB or smaller.");
  const info = parseImageInfo(bytes);
  if (!info || info.mime !== declaredMime) return fail("bad_type", "That file is not a valid JPEG, PNG or WebP picture.");
  if (info.w < HOST_PHOTO_MIN_W || info.h < HOST_PHOTO_MIN_H) return fail("too_small", `The picture must be at least ${HOST_PHOTO_MIN_W} x ${HOST_PHOTO_MIN_H} pixels.`);
  return { ok: true, mime: info.mime, ext: IMAGE_EXT[info.mime], width: info.w, height: info.h };
}
