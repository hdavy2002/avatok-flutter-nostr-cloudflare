// Prompt/lyrics crafting via Gemini 3.7 Flash on Vertex.
// requirements 2026-08-14 (B — song flow, C — video flow).
//
// Two small, fail-soft helpers:
//   craftVideoPrompt — turns a user's rough video ask into a stronger,
//     duration-aware generation prompt. Used by the Vertex video adapter
//     before the prompt gate + Vertex call.
//   draftLyrics — writes duration-aware song lyrics for a theme (verse/chorus
//     shape sized to the requested length), shown to the user for approval
//     BEFORE any music is actually generated (do/ava_agent.ts's onDraftLyrics
//     -> the in-thread Vertex music flow.
//
// Video prompt enhancement fails soft to the user's original prompt. Lyrics
// drafting fails closed: a theme must never be mislabeled and saved as generated
// lyrics when the provider is unavailable.
import type { Env } from "../types";
import { vertexMediaRequest } from "./vertex";

const CRAFT_MODEL = "gemini-3.7-flash";
const CRAFT_TIMEOUT_MS = 20000;

async function vertexText(
  env: Env,
  system: string,
  user: string,
  maxOutputTokens: number,
  temperature: number,
): Promise<string> {
  const r = await vertexMediaRequest(env, `/publishers/google/models/${CRAFT_MODEL}:generateContent`, {
    contents: [
      { role: "user", parts: [{ text: `${system}\n\nUser request:\n${user}` }] },
    ],
    generationConfig: { maxOutputTokens, temperature },
  }, { timeoutMs: CRAFT_TIMEOUT_MS });
  if (!r.ok) throw new Error(String(r.out?.error?.message ?? "Vertex Gemini request failed"));
  return (r.out?.candidates?.[0]?.content?.parts ?? [])
    .map((p: any) => typeof p?.text === "string" ? p.text : "")
    .join("")
    .trim();
}

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
    const text = await vertexText(env, sys, ask, 220, 0.7);
    return text || ask;
  } catch {
    return ask;
  }
}

/** Safe, persisted share-card copy. The source prompt is never persisted. */
export async function craftVideoCardMetadata(env: Env, userAsk: string): Promise<{ title: string; description: string }> {
  const ask = String(userAsk ?? "").trim();
  const fallbackSource = ask.replace(/\s+/g, " ").trim();
  const fallbackWords = fallbackSource
    .replace(/^(?:please\s+)?(?:make|create|generate|show|film)\s+(?:me\s+)?(?:a\s+)?(?:short\s+)?(?:video\s+)?(?:of|about|on)?\s*/i, "")
    .split(/\s+/).filter(Boolean).slice(0, 7).join(" ");
  const fallbackTitle = fallbackWords
    ? fallbackWords.charAt(0).toUpperCase() + fallbackWords.slice(1)
    : "Cinematic moment";
  const fallback = {
    title: fallbackTitle.slice(0, 80),
    description: fallbackSource
      ? `A cinematic scene shaped around ${fallbackWords || fallbackSource}, with its own setting, movement, and atmosphere.`.slice(0, 160)
      : "A cinematic scene with a distinct subject, setting, movement, and atmosphere.",
  };
  if (!ask) return fallback;
  try {
    const raw = (await vertexText(env, "Create promotional share-card metadata for the actual visual scene described by the user. Study the subject and action, location or culture, lighting, camera language, mood, color, and overall vibe. Return ONLY valid JSON with two string fields: title (5-80 characters, memorable and specific) and description (one or two sentences, 40-160 characters, vivid and accurate). Avoid generic phrases such as 'AI video' or 'short video'. Do not mention prompts, AI, or unsupported facts. Do not use markdown or emojis.", ask, 180, 0.35)).replace(/^```json\s*|\s*```$/g, "");
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
  const instrumental = !String(lyrics || '').trim();
  // [SONG-CARD-TITLE-1] The style prompt is often the structured production
  // brief ("Theme / intent: …\nGenre: …"). When the AI title call fails, the
  // old fallback took the brief's first words verbatim, shipping literal
  // "Theme / intent: freedom from poli…" titles onto real song cards. Extract
  // the CONTENT of the theme line (or the first line) and drop every label.
  const briefTheme = String(stylePrompt || '')
    .split(/\n+/)
    .map((line) => line.replace(/^\s*(?:theme|intent|goal|purpose)(?:\s*\/\s*(?:theme|intent|goal|purpose))?\s*[:\-–]\s*/i, "").trim())
    .find((line) => !!line && !/^(?:genre|mood|energy|instruments|language|vocal|voice|intended use|audio model|length)\b\s*[:\-–]/i.test(line)) || "";
  const fallbackSource = (briefTheme || String(stylePrompt || '')).replace(/\s+/g, ' ').trim();
  const fallbackWords = fallbackSource
    .replace(/^(?:please\s+)?(?:make|create|generate|compose)\s+(?:me\s+)?/i, '')
    .split(/\s+/).filter(Boolean).slice(0, 6).join(' ');
  const fallbackTitle = fallbackWords
    ? fallbackWords.charAt(0).toUpperCase() + fallbackWords.slice(1)
    : (instrumental ? 'Midnight Instrumental' : 'A New Story');
  const fallback = {
    title: fallbackTitle.slice(0, 80),
    description: instrumental
      ? `A ${fallbackSource || 'mood-led'} instrumental shaped around its requested rhythm, texture and atmosphere.`
      : `A song shaped by its lyrics, pairing the requested sound with a focused story and emotional arc.`,
  };
  const source = [String(stylePrompt || "").trim(), String(lyrics || "").trim()]
    .filter(Boolean).join("\n\n").slice(0, 6000);
  if (!source) return fallback;
  // The description doubles as the ONLY creative brief the album-cover image
  // model ever sees (the prompt/lyrics are never persisted), so it must name
  // the song's actual genre, language/culture, mood and central imagery.
  const sys = instrumental
    ? "Create promotional share-card metadata for an instrumental track. Study the musical brief closely and infer its real genre, instruments, mood, energy, setting, and listener intent. Return ONLY valid JSON with two string fields: title (5-80 characters, memorable and specific) and description (one or two sentences, 60-220 characters) that explicitly names the genre, mood, cultural setting and central imagery so an artist could paint the right cover from it alone. Do not invent lyrics or singers. Do not mention prompts, AI, or unsupported facts. Do not use markdown or emojis."
    : "Create promotional share-card metadata for an original song. Study the approved lyrics closely and infer the song's real theme, emotion, imagery, language and audience; use the musical brief as secondary context. Return ONLY valid JSON with two string fields: title (5-80 characters, memorable and specific — in the same language as the lyrics when natural) and description (one or two sentences, 60-220 characters) that explicitly names the genre, language, mood and the song's central imagery so an artist could paint the right cover from it alone. Do not mention prompts, AI, or unsupported facts. Do not use markdown or emojis.";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = (await vertexText(env, sys, source, 220, 0.45)).replace(/^```json\s*|\s*```$/g, "");
      const parsed = JSON.parse(raw) as { title?: unknown; description?: unknown };
      const title = String(parsed.title ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
      const description = String(parsed.description ?? "").replace(/\s+/g, " ").trim().slice(0, 220);
      if (title && description) return { title, description };
    } catch { /* retry once, then fall back */ }
  }
  return fallback;
}

/**
 * Draft ORIGINAL song lyrics for `theme`, sized for a track roughly
 * `durationSeconds` long (defaults to 60s). Throws on provider/empty output so
 * the caller can retain the brief and ask the user to retry safely.
 */
export async function draftLyrics(env: Env, theme: string, durationSeconds?: number, maxChars?: number): Promise<string> {
  const t = String(theme ?? "").trim();
  if (!t) return t;
  const dur = Number.isFinite(durationSeconds as number) && (durationSeconds as number) > 0
    ? Math.round(durationSeconds as number)
    : 60;
  const targetWords = Math.max(40, Math.round((dur / 60) * WORDS_PER_MINUTE_SUNG));
  // [SONG-LEN-2] When the singing model has a hard lyric-length limit (MiniMax:
  // lyrics_prompt < 1000 chars), the DRAFT must respect it — otherwise the
  // person approves lyrics the singer will never be given in full.
  const charCap = Number.isFinite(maxChars as number) && (maxChars as number) > 0
    ? Math.round(maxChars as number)
    : undefined;
  const sys =
    "You are a songwriter. Write ORIGINAL song lyrics for the theme given by the user, sized for a track " +
    `roughly ${dur} seconds long (about ${targetWords} words of sung lyric content at a natural singing pace). ` +
    (charCap
      ? `HARD LIMIT: the entire lyric including section labels must be UNDER ${charCap} characters — the music ` +
        "engine rejects anything longer. Compose a complete, self-contained song within that limit. "
      : "The duration is a hard requirement: the lyrics must contain enough sung content to fill the WHOLE track, " +
        "so write the COMPLETE song — every verse, chorus, bridge and outro in full. ") +
    "Never stop mid-line or " +
    "mid-section, and never summarise a section instead of writing it. " +
    "If the theme names or implies a language (for example Hindi), write the lyrics in that language. " +
    "Structure it with clear labelled sections, e.g. [Verse 1] / [Chorus] / [Verse 2] / [Chorus] / [Outro] — use " +
    "fewer, shorter sections for a short track (~60s: one verse plus one chorus is plenty) and more for a longer " +
    "one. Do not include timestamps in the section labels. " +
    "Keep language clean and radio-safe (no slurs, no explicit sexual or drug content). " +
    "Output ONLY the lyrics with section labels — no preamble, no explanation, no commentary before or after.";
  // [SONG-LEN-1] The music provider has no duration parameter — the finished
  // track is only as long as the lyrics it is given. The old fixed 700-token
  // cap silently truncated non-Latin scripts (Devanagari ≈ 2-4 tokens per
  // character), which is exactly how a "3 minute song" came out 24 seconds
  // long: the lyrics were cut mid-word and the model sang what was left.
  // Scale the budget with the requested duration, with generous headroom for
  // dense scripts.
  const maxTokens = Math.min(3600, Math.max(900, Math.round(dur * 14)));
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const text = await vertexText(env, sys, t, maxTokens, 0.85);
      if (!text) throw new Error("empty lyrics response");
      return text;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
