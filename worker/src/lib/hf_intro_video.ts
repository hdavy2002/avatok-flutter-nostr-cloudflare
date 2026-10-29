// [HF-INTRO-W1] HF-INTRO-VIDEO-1: pure rules for the recorded influencer intro video, the submission gate and the review texts.
// (The old VOICE introduction lives in lib/hf_intro.ts and is untouched.) No I/O here.
import { BRAND, brandUrl } from "./brand";
import { WOMEN_TO_WOMEN, isSensitiveCategory } from "./hf_categories";
import { probeVideoDurationMs } from "./video_probe";

// ── recorded video (D7) ───────────────────────────────────────────────────────────────────────────────────────
export const INTRO_VIDEO_MIN_MS = 10_000;
export const INTRO_VIDEO_MAX_MS = 20_000;
/** A recorder stops a few ms late; anything up to this over the 20 s limit is still accepted. */
export const INTRO_VIDEO_TOLERANCE_MS = 500;
/** [HF-MOD-1] 16 MB: the Clef-omni safety check takes at most 16 MiB. A 20 s take at 2 Mbps is about 5 MB. */
export const INTRO_VIDEO_MAX_BYTES = 16 * 1024 * 1024;
export const INTRO_POSTER_MAX_BYTES = 2 * 1024 * 1024;
export const INTRO_VIDEO_MIMES: Readonly<Record<string, string>> = { "video/mp4": "mp4", "video/webm": "webm" };
export const INTRO_POSTER_MIMES: Readonly<Record<string, string>> = { "image/jpeg": "jpg", "image/webp": "webp", "image/png": "png" };
/** hi en mr bn ta te gu pa kn ml (D6 order). */
export const INTRO_LANGS = ["hi", "en", "mr", "bn", "ta", "te", "gu", "pa", "kn", "ml"] as const;
export const isIntroLang = (v: unknown): v is (typeof INTRO_LANGS)[number] => typeof v === "string" && (INTRO_LANGS as readonly string[]).includes(v);

export type VideoCheck =
  | { ok: true; ext: string; mime: string; durationMs: number; width: number; height: number; clientDurationMs: number | null; durationSource: "file" | "client" }
  | { ok: false; status: number; error: string; message: string };

const posInt = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && Number.isInteger(n) && n > 0 ? n : null;
};

/** Magic-byte sniff so a renamed file cannot pass: MP4 has "ftyp" at byte 4, WebM/Matroska starts 1A 45 DF A3. */
export function sniffVideo(b: Uint8Array): "video/mp4" | "video/webm" | null {
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return "video/mp4";
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "video/webm";
  return null;
}

/** Validates the recorded intro video: type, size, 10-20 s, portrait. The client reports duration and dimensions. */
export function validateIntroVideo(
  declaredMime: string, bytes: Uint8Array | null, durationRaw: unknown, widthRaw: unknown, heightRaw: unknown,
): VideoCheck {
  const mime = declaredMime.split(";")[0].trim().toLowerCase();
  const ext = INTRO_VIDEO_MIMES[mime];
  if (!ext) return { ok: false, status: 415, error: "unsupported_type", message: "Please record the video with your camera (MP4 or WebM)." };
  if (!bytes) return { ok: false, status: 413, error: "too_large", message: "That video is too large. Please record a shorter one." };
  if (bytes.byteLength < 1024) return { ok: false, status: 400, error: "empty_video", message: "We did not get your video. Please record it again." };
  if (bytes.byteLength > INTRO_VIDEO_MAX_BYTES) return { ok: false, status: 413, error: "too_large", message: "That video is too large. Please record a shorter one." };
  if (sniffVideo(bytes) !== mime) return { ok: false, status: 415, error: "unsupported_type", message: "That file is not a video recorded with your camera." };
  // [HF-MOD-1] The length inside the file is the truth; the phone's number is only a fallback for a WebM that
  // carries no duration (browser MediaRecorder). An MP4/MOV always has one, so an unreadable MP4 is refused.
  const clientDurationMs = posInt(durationRaw);
  const fileMs = probeVideoDurationMs(bytes, mime);
  if (mime === "video/mp4" && fileMs === null) return { ok: false, status: 422, error: "duration_unreadable", message: "We could not read the length of your video. Please record it again." };
  const durationMs = fileMs ?? clientDurationMs;
  if (durationMs === null) return { ok: false, status: 400, error: "duration_required", message: "We could not read the length of your video. Please record it again." };
  if (durationMs < INTRO_VIDEO_MIN_MS) return { ok: false, status: 422, error: "too_short", message: lengthMessage(durationMs) };
  if (durationMs > INTRO_VIDEO_MAX_MS + INTRO_VIDEO_TOLERANCE_MS) return { ok: false, status: 422, error: "too_long", message: lengthMessage(durationMs) };
  const width = posInt(widthRaw), height = posInt(heightRaw);
  if (width === null || height === null) return { ok: false, status: 400, error: "size_required", message: "We could not read your video size. Please record it again." };
  if (width >= height) return { ok: false, status: 422, error: "not_portrait", message: "Please hold your phone upright and record again." };
  return { ok: true, ext, mime, durationMs, width, height, clientDurationMs, durationSource: fileMs !== null ? "file" : "client" };
}

/** "Your video is 9 seconds. Please record between 10 and 20 seconds." (same wording as the app's nudge) */
export function lengthMessage(ms: number): string {
  const sec = ms < INTRO_VIDEO_MIN_MS ? Math.floor(ms / 1000) : Math.ceil(ms / 1000);
  return `Your video is ${sec} second${sec === 1 ? "" : "s"}. Please record between ${INTRO_VIDEO_MIN_MS / 1000} and ${INTRO_VIDEO_MAX_MS / 1000} seconds.`;
}

export function validateIntroPoster(declaredMime: string, bytes: Uint8Array | null): { ok: true; ext: string; mime: string } | { ok: false; status: number; error: string; message: string } {
  const mime = declaredMime.split(";")[0].trim().toLowerCase();
  const ext = INTRO_POSTER_MIMES[mime];
  if (!ext) return { ok: false, status: 415, error: "unsupported_type", message: "Use a JPG, PNG or WebP picture." };
  if (!bytes || bytes.byteLength > INTRO_POSTER_MAX_BYTES) return { ok: false, status: 413, error: "too_large", message: "That picture is too large." };
  if (bytes.byteLength < 100) return { ok: false, status: 400, error: "empty_poster", message: "We did not get the picture." };
  return { ok: true, ext, mime };
}

export const newIntroVideoId = (): string => "hfin_" + crypto.randomUUID().replace(/-/g, "").slice(0, 20);
export const newApplicationId = (): string => "hfia_" + crypto.randomUUID().replace(/-/g, "").slice(0, 20);
export const INTRO_VIDEO_ID_RE = /^hfin_[a-f0-9]{20}$/;
export const APPLICATION_ID_RE = /^hfia_[a-f0-9]{20}$/;

// ── call option (D9) ──────────────────────────────────────────────────────────────────────────────────────────
export type CallOption = "A" | "B";
export const isCallOption = (v: unknown): v is CallOption => v === "A" || v === "B";

// ── submission gate (D4) ──────────────────────────────────────────────────────────────────────────────────────
export interface GateFacts { categories: string[]; hasVerifiedSocial: boolean; aadhaarDone: boolean; aadhaarGender: string | null }
export type GateError = "aadhaar_required" | "women_to_women_requires_female";

/** Aadhaar is needed when there is no verified social account OR any sensitive category is picked. */
export const aadhaarNeeded = (categories: string[], hasVerifiedSocial: boolean): boolean => !hasVerifiedSocial || categories.some(isSensitiveCategory);

export function submissionGate(f: GateFacts): GateError | null {
  if (aadhaarNeeded(f.categories, f.hasVerifiedSocial) && !f.aadhaarDone) return "aadhaar_required";
  if (f.categories.includes(WOMEN_TO_WOMEN) && (!f.aadhaarDone || f.aadhaarGender !== "F")) return "women_to_women_requires_female";
  return null;
}

export const GATE_MESSAGES: Record<GateError, string> = {
  aadhaar_required: "Please verify your Aadhaar to continue.",
  women_to_women_requires_female: "The Women-to-Women channel is only for Aadhaar-verified women.",
};

// ── review (D12 / D13) ────────────────────────────────────────────────────────────────────────────────────────
/** Reject reason codes and the plain-English line the influencer reads on WhatsApp (and the admin sees as a label). */
export const REJECT_REASONS: Readonly<Record<string, string>> = {
  face_unclear: "Your face is not clear in the video. Please record again in good light, facing the camera.",
  video_dark: "The video is too dark. Please record again in a bright place.",
  audio_unclear: "We could not hear you clearly. Please record again in a quiet place.",
  contact_shared: "Please do not share phone numbers, social handles or links in your video or your description.",
  unsuitable: `Your video or profile is not suitable for ${BRAND.name}.`,
  wrong_category: "The categories you picked do not match your video. Please pick the right ones.",
  description_fix: "Please improve your profile description.",
  rate_fix: "Please change your rate per minute.",
  aadhaar_mismatch: "Your Aadhaar details do not match your profile. Please check them.",
  other: "There is another problem with your profile. Please read the note from our team.",
};
export const REJECT_REASON_CODES: readonly string[] = Object.keys(REJECT_REASONS);

export function approvedMessage(name?: string | null): string {
  const hi = name && name.trim() ? `Hello ${name.trim()}! ` : "Hello! ";
  return `${hi}Good news. Our team has approved your ${BRAND.name} profile and you are now live. Fans can find your video and talk to you. Open your dashboard: ${brandUrl("/dashboard")}`;
}

export function rejectedMessage(reasons: string[], note?: string | null): string {
  const lines = reasons.filter((r) => REJECT_REASONS[r]).map((r) => `- ${REJECT_REASONS[r]}`);
  const n = note && note.trim() ? `\nNote from our team: ${note.trim()}` : "";
  return `Hello! Our team checked your ${BRAND.name} profile and it is not approved yet.\n${lines.join("\n")}${n}\nPlease fix this and send it again: ${brandUrl("/dashboard")}`;
}
