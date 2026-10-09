// [HF-VOICE-INTRO-1 2026-10-09] Host voice introduction: pure helpers (no I/O, no env) so vitest can import them.
// The host records their OWN voice (30 s - 5 min); Gemini transcribes it and flags contact details for the admin reviewer.
import { contactLeak } from "./hf_options";

export const INTRO_MIN_SECONDS = 30;
export const INTRO_MAX_SECONDS = 300;
export const INTRO_MIN_BYTES = 20 * 1024;
export const INTRO_MAX_BYTES = 15 * 1024 * 1024;
export const TRANSCRIPT_MAX_CHARS = 6000;
export const FLAG_TEXT_MAX = 120;
export const FLAGS_MAX = 20;

export const FLAG_TYPES = ["phone", "email", "social", "upi", "address", "other_contact", "abuse"] as const;
export type IntroFlagType = (typeof FLAG_TYPES)[number];
export interface IntroFlag { type: IntroFlagType; text: string }

const MIME_MAP: Record<string, { mime: string; ext: string }> = {
  "audio/mp4": { mime: "audio/mp4", ext: "m4a" },
  "audio/x-m4a": { mime: "audio/mp4", ext: "m4a" },
  "audio/m4a": { mime: "audio/mp4", ext: "m4a" },
  "audio/aac": { mime: "audio/aac", ext: "aac" },
  "audio/webm": { mime: "audio/webm", ext: "webm" },
  "audio/ogg": { mime: "audio/ogg", ext: "ogg" },
  "audio/mpeg": { mime: "audio/mpeg", ext: "mp3" },
  "audio/mp3": { mime: "audio/mpeg", ext: "mp3" },
  "audio/wav": { mime: "audio/wav", ext: "wav" },
  "audio/x-wav": { mime: "audio/wav", ext: "wav" },
  "audio/wave": { mime: "audio/wav", ext: "wav" },
};
export const INTRO_ACCEPTED_TYPES = ["audio/mp4", "audio/x-m4a", "audio/aac", "audio/webm", "audio/ogg", "audio/mpeg", "audio/wav"];

/** Content-Type header (params like ;codecs=opus allowed) -> normalised mime + file extension, or null when unsupported. */
export function normalizeIntroMime(contentType: string | null | undefined): { mime: string; ext: string } | null {
  const base = String(contentType ?? "").split(";")[0].trim().toLowerCase();
  return MIME_MAP[base] ?? null;
}

export type IntroCheck = { ok: true; seconds: number } | { ok: false; status: number; error: string; message: string };

/** Validates the client-measured duration and the byte size. Duration is rounded to whole seconds. */
export function validateIntro(secondsRaw: unknown, bytes: number): IntroCheck {
  const n = typeof secondsRaw === "number" ? secondsRaw : Number(String(secondsRaw ?? "").trim());
  if (secondsRaw === null || secondsRaw === undefined || String(secondsRaw).trim() === "" || !Number.isFinite(n) || n <= 0) {
    return { ok: false, status: 400, error: "bad_duration", message: "We couldn’t read the length of your recording. Please record again." };
  }
  const seconds = Math.round(n);
  if (seconds < INTRO_MIN_SECONDS) return { ok: false, status: 422, error: "too_short", message: "Please record at least 30 seconds." };
  if (seconds > INTRO_MAX_SECONDS) return { ok: false, status: 422, error: "too_long", message: "Please keep it under 5 minutes." };
  if (bytes > INTRO_MAX_BYTES) return { ok: false, status: 413, error: "too_large", message: "That recording is too large. Please record a shorter one." };
  if (bytes < INTRO_MIN_BYTES) return { ok: false, status: 422, error: "too_small", message: "That recording looks empty. Please record again." };
  return { ok: true, seconds };
}

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

function parseLooseJson(t: string): unknown {
  const s = String(t ?? "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch { /* try slices */ }
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch { /* fallthrough */ } }
  const c = s.indexOf("["), d = s.lastIndexOf("]");
  if (c >= 0 && d > c) { try { return JSON.parse(s.slice(c, d + 1)); } catch { /* fallthrough */ } }
  return null;
}

/** Normalises whatever the model sent for `flags` into a clean list. Unknown types become other_contact. */
export function cleanFlags(raw: unknown): IntroFlag[] {
  if (!Array.isArray(raw)) return [];
  const out: IntroFlag[] = [];
  for (const f of raw) {
    let type: string; let text: string;
    if (typeof f === "string") { type = "other_contact"; text = f; }
    else if (f && typeof f === "object") {
      type = String((f as Record<string, unknown>).type ?? "").trim().toLowerCase();
      const tx = (f as Record<string, unknown>).text;
      text = typeof tx === "string" ? tx : "";
    } else continue;
    text = text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (!(FLAG_TYPES as readonly string[]).includes(type)) type = "other_contact";
    out.push({ type: type as IntroFlagType, text: clip(text, FLAG_TEXT_MAX) });
    if (out.length >= FLAGS_MAX) break;
  }
  return out;
}

/** Parses Gemini's response text. Tolerates code fences, prose around the JSON, a bare flags array, or a non-string transcript. */
export function parseGeminiIntro(text: string): { transcript: string | null; flags: IntroFlag[] } | null {
  const j = parseLooseJson(text);
  if (j === null || typeof j !== "object") return null;
  if (Array.isArray(j)) return { transcript: null, flags: cleanFlags(j) };
  const o = j as Record<string, unknown>;
  const tr = typeof o.transcript === "string" ? o.transcript.trim() : "";
  return { transcript: tr ? clip(tr, TRANSCRIPT_MAX_CHARS) : null, flags: cleanFlags(o.flags) };
}

/**
 * Merges Gemini's flags with the deterministic contactLeak() check on the transcript.
 * When contactLeak fires and Gemini already flagged a contact-type item, nothing is added; otherwise one generic
 * other_contact flag is added (it never repeats transcript text). Duplicates (type + text) are dropped.
 */
export function mergeFlags(gemini: IntroFlag[], transcript: string | null): IntroFlag[] {
  const seen = new Set<string>();
  const out: IntroFlag[] = [];
  for (const f of gemini) {
    const k = `${f.type}:${f.text.toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k); out.push(f);
  }
  const contactTypes = new Set<string>(["phone", "email", "social", "upi", "address", "other_contact"]);
  if (transcript && contactLeak(transcript) && !out.some((f) => contactTypes.has(f.type))) {
    out.push({ type: "other_contact", text: "Possible phone number, link, @handle or app name detected in the transcript" });
  }
  return out.slice(0, FLAGS_MAX);
}

export function parseStoredFlags(s: string | null | undefined): IntroFlag[] {
  try { return cleanFlags(s ? JSON.parse(s) : []); } catch { return []; }
}

export type IntroStatus = "pending" | "approved" | "rejected";
export function introStatusOf(s: string | null | undefined): IntroStatus | null {
  return s === "pending" || s === "approved" || s === "rejected" ? s : null;
}

/** hf_host_media(kind='intro_audio').caption carries {seconds, mime} of the approved public copy. */
export const INTRO_MEDIA_KIND = "intro_audio";
export const introCaption = (seconds: number | null, mime: string | null): string => JSON.stringify({ seconds: seconds ?? null, mime: mime ?? null });
export function parseIntroCaption(s: string | null | undefined): { seconds: number | null; mime: string | null } {
  try {
    const o = JSON.parse(s || "{}") as Record<string, unknown>;
    return { seconds: typeof o.seconds === "number" ? o.seconds : null, mime: typeof o.mime === "string" ? o.mime : null };
  } catch { return { seconds: null, mime: null }; }
}
