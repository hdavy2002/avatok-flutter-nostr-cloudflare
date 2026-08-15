// [VENICE-PROMPT-1 / VENICE-SONG-1] Prompt/lyrics crafting via Gemini 3.7
// (Venice-hosted). Spec: Specs/VENICE-AI-MEDIA-PLAN-2026-08-14.md, owner
// requirements 2026-08-14 (B — song flow, C — video flow).
//
// Two small, fail-soft helpers:
//   craftVideoPrompt — turns a user's rough video ask into a stronger,
//     duration-aware generation prompt. Used by lib/venice_media.ts's
//     runVeniceVideo before the prompt gate + Venice call.
//   draftLyrics — writes duration-aware song lyrics for a theme (verse/chorus
//     shape sized to the requested length), shown to the user for approval
//     BEFORE any music is actually generated (do/ava_agent.ts's onDraftLyrics
//     -> lib/venice_media.ts's runVeniceDraftLyrics).
//
// Both call Venice's OpenAI-compatible /chat/completions via lib/venice.ts's
// veniceChatComplete, on the model verified live on Venice 2026-08-14:
// "gemini-3-7-flash" (see Specs/VENICE-AI-MEDIA-PLAN-2026-08-14.md and the
// owner's work order for this file). Video prompt enhancement fails soft to
// the user's original prompt. Lyrics drafting fails closed: a theme must never
// be mislabeled and saved as generated lyrics when the provider is unavailable.
import type { Env } from "../types";
import { veniceChatComplete } from "./venice";

const CRAFT_MODEL = "gemini-3-7-flash";
const CRAFT_TIMEOUT_MS = 20000;

// Standard songwriting rule of thumb: ~150 words/min sung. Used only to size
// how much lyric content to ask for at a given track length — not sent to
// the model as a hard word-count instruction (that reads unnatural in verse).
const WORDS_PER_MINUTE_SUNG = 150;

/**
 * Rewrite a user's video ask into a stronger, more visual, duration-aware
 * prompt for the video model. Never throws — returns `userAsk` unchanged on
 * any failure (missing key, timeout, empty completion).
 */
export async function craftVideoPrompt(env: Env, userAsk: string, durationSeconds?: number): Promise<string> {
  const ask = String(userAsk ?? "").trim();
  if (!ask) return ask;
  const dur = Number.isFinite(durationSeconds as number) && (durationSeconds as number) > 0
    ? Math.round(durationSeconds as number)
    : undefined;
  const sys =
    "You write short, vivid, highly-visual prompts for an AI video generator. Given the user's request " +
    "(and, if given, the exact clip length in seconds), rewrite it into ONE dense paragraph describing: the " +
    "subject and action, camera movement/framing, setting/lighting, and mood/style. " +
    (dur
      ? `The clip is only ${dur} seconds long — describe an amount of action and camera movement that comfortably ` +
        `fits in ${dur}s (a single continuous beat of motion for a short clip; at most two or three beats for a ` +
        `longer one). Do not describe more than could plausibly be shown in that time. `
      : "") +
    "Output ONLY the rewritten prompt text — no preamble, no quotes, no explanation, under 90 words.";
  try {
    const r = await veniceChatComplete(env as any, CRAFT_MODEL, [
      { role: "system", content: sys },
      { role: "user", content: ask },
    ], { maxTokens: 220, temperature: 0.7, timeoutMs: CRAFT_TIMEOUT_MS });
    const text = (r.text || "").trim();
    return text || ask;
  } catch {
    return ask;
  }
}

/** Safe, persisted share-card copy. The source prompt is never persisted. */
export async function craftVideoCardMetadata(env: Env, userAsk: string): Promise<{ title: string; description: string }> {
  const fallback = { title: "AvaTOK video", description: "A short video created with AvaTOK AI." };
  const ask = String(userAsk ?? "").trim();
  if (!ask) return fallback;
  try {
    const r = await veniceChatComplete(env as any, CRAFT_MODEL, [
      { role: "system", content: "Create share-card metadata for the user's video request. Return ONLY valid JSON with two string fields: title (5-80 characters, concise and specific) and description (one or two sentences, 40-160 characters). Do not use markdown, emojis, or unsupported claims." },
      { role: "user", content: ask },
    ], { maxTokens: 180, temperature: 0.35, timeoutMs: CRAFT_TIMEOUT_MS });
    const raw = (r.text || "").trim().replace(/^```json\s*|\s*```$/g, "");
    const parsed = JSON.parse(raw) as { title?: unknown; description?: unknown };
    const title = String(parsed.title ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    const description = String(parsed.description ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
    return title && description ? { title, description } : fallback;
  } catch { return fallback; }
}

/** Build share-card copy from the approved lyrics, with the musical brief as context. */
export async function craftSongCardMetadata(
  env: Env,
  stylePrompt: string,
  lyrics: string,
): Promise<{ title: string; description: string }> {
  const fallback = {
    title: "Original Ava Song",
    description: "An original song created with AvaTOK. Ready to play, seek and share.",
  };
  const source = [String(stylePrompt || "").trim(), String(lyrics || "").trim()]
    .filter(Boolean).join("\n\n").slice(0, 6000);
  if (!source) return fallback;
  try {
    const r = await veniceChatComplete(env as any, CRAFT_MODEL, [
      { role: "system", content: "Create promotional share-card metadata for an original song. Study the lyrics closely and infer the song's real theme, emotion, and imagery. Return ONLY valid JSON with two string fields: title (5-80 characters, memorable and specific) and description (one or two sentences, 40-160 characters, appealing and accurate). Do not mention prompts, AI, or unsupported facts. Do not use markdown or emojis." },
      { role: "user", content: source },
    ], { maxTokens: 180, temperature: 0.45, timeoutMs: CRAFT_TIMEOUT_MS });
    const raw = (r.text || "").trim().replace(/^```json\s*|\s*```$/g, "");
    const parsed = JSON.parse(raw) as { title?: unknown; description?: unknown };
    const title = String(parsed.title ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    const description = String(parsed.description ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
    return title && description ? { title, description } : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Draft ORIGINAL song lyrics for `theme`, sized for a track roughly
 * `durationSeconds` long (defaults to 60s). Throws on provider/empty output so
 * the caller can retain the brief and ask the user to retry safely.
 */
export async function draftLyrics(env: Env, theme: string, durationSeconds?: number): Promise<string> {
  const t = String(theme ?? "").trim();
  if (!t) return t;
  const dur = Number.isFinite(durationSeconds as number) && (durationSeconds as number) > 0
    ? Math.round(durationSeconds as number)
    : 60;
  const targetWords = Math.max(40, Math.round((dur / 60) * WORDS_PER_MINUTE_SUNG));
  const sys =
    "You are a songwriter. Write ORIGINAL song lyrics for the theme given by the user, sized for a track " +
    `roughly ${dur} seconds long (about ${targetWords} words of sung lyric content at a natural singing pace). ` +
    "Structure it with clear labelled sections, e.g. [Verse 1] / [Chorus] / [Verse 2] / [Chorus] / [Outro] — use " +
    "fewer, shorter sections for a short track (~60s: one verse plus one chorus is plenty) and more for a longer " +
    "one. Keep language clean and radio-safe (no slurs, no explicit sexual or drug content). " +
    "Output ONLY the lyrics with section labels — no preamble, no explanation, no commentary before or after.";
  try {
    const r = await veniceChatComplete(env as any, CRAFT_MODEL, [
      { role: "system", content: sys },
      { role: "user", content: t },
    ], { maxTokens: 700, temperature: 0.85, timeoutMs: CRAFT_TIMEOUT_MS });
    const text = (r.text || "").trim();
    if (!text) throw new Error("empty lyrics response");
    return text;
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}
