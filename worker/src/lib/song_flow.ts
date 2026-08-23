// Deterministic, provider-free song-flow state helpers. AvaAgentDO owns storage
// and calls Venice; this module only normalizes intent and describes the next
// safe transition so continuation turns do not depend on model tool selection.

export type SongFlowPhase = "awaiting_brief" | "reviewing" | "generating" | "completed";
// [SONG-QUICK-1 2026-08-17] "engine_written" is the one-shot QUICK SONG mode:
// the music engine writes AND sings its own words from a descriptive brief, so
// there is no lyric draft and no approval step. It is a third first-class mode
// alongside "vocal" (Ava drafts lyrics, person approves) and "instrumental".
export type SongRequestKind = "vocal" | "instrumental" | "engine_written";
export const DEFAULT_SONG_DURATION_SECONDS = 180;
export const SONG_OUTRO_RESERVE_SECONDS = 12;
export const SUNG_WORDS_PER_MINUTE = 125;

export interface SongFlowState {
  phase: SongFlowPhase;
  kind?: SongRequestKind;
  /** Raw user turns retained for the AI-led interview. */
  conversation?: string;
  /** Structured choices extracted by AI; server validation decides readiness. */
  context?: SongProductionContext;
  /** The last natural AI reply, needed to understand answers such as "you choose". */
  lastInterviewReply?: string;
  brief?: string;
  durationSeconds?: number;
  lyrics?: string;
  /** Who supplied the exact reviewed lyrics. User text is never silently rewritten. */
  lyricsSource?: "ava" | "user" | "user_fitted";
  /** [AVA-MULTITOOL-1] Epoch ms of the last storage write; drives idle expiry. */
  updatedAt?: number;
}

export interface SongProductionContext {
  theme?: string;
  genre?: string;
  mood?: string;
  instruments?: string[];
  language?: string;
  vocalArrangement?: string;
  voiceStyle?: string;
  durationSeconds?: number;
  intendedUse?: string;
  modelId?: string;
}

export type SongFlowAction =
  | { kind: "none"; flow: SongFlowState | null }
  | { kind: "ask_brief"; flow: SongFlowState }
  | { kind: "draft"; flow: SongFlowState }
  | { kind: "generate"; flow: SongFlowState };

function hasText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * [SONG-QUICK-1] Readiness for the engine-written quick song. The whole point
 * of the mode is that the person does NOT sit through a producer interview, so
 * the bar is deliberately the smallest thing that still makes a real song:
 * something for the song to be ABOUT, and a length. Genre, mood and language
 * are producer polish the engine invents for itself here — requiring them
 * would recreate the interview this mode exists to skip.
 */
export function isQuickSongContextReady(context: SongProductionContext | undefined): boolean {
  if (!context) return false;
  return hasText(context.theme)
    && Number.isFinite(context.durationSeconds) && Number(context.durationSeconds) >= 60;
}

export function isSongProductionContextReady(context: SongProductionContext | undefined, kind: SongRequestKind): boolean {
  if (!context) return false;
  if (kind === "engine_written") return isQuickSongContextReady(context);
  // A song brief is ready once its creative direction is unambiguous. Instrument
  // selection, singer arrangement and voice character improve the production
  // prompt, but they are producer choices rather than reasons to trap a person
  // in an interview after they have already said to proceed.
  const musicalCore = hasText(context.theme) && hasText(context.genre) && hasText(context.mood)
    && Number.isFinite(context.durationSeconds) && Number(context.durationSeconds) >= 60;
  if (!musicalCore) return false;
  return kind === "instrumental" || hasText(context.language);
}

export function songProductionBrief(context: SongProductionContext, kind: SongRequestKind): string {
  return [
    `Theme / intent: ${context.theme ?? ""}`,
    `Genre: ${context.genre ?? ""}`,
    `Mood / energy: ${context.mood ?? ""}`,
    context.instruments?.some(hasText) ? `Instruments: ${context.instruments.join(", ")}` : "",
    // [SONG-QUICK-1] The engine-written brief must ASK for sung words, because
    // no lyrics_prompt is sent with it — the words exist only if this prompt
    // requests them. An instrumental brief says the opposite, deliberately.
    kind === "instrumental"
      ? "No lyrics or vocals."
      : kind === "engine_written"
        ? `Write and sing original lyrics for this song${context.language ? ` in ${context.language}` : ""}.`
        : `Language: ${context.language ?? ""}`,
    kind !== "instrumental" && context.vocalArrangement ? `Vocal arrangement: ${context.vocalArrangement}` : "",
    kind !== "instrumental" && context.voiceStyle ? `Voice character: ${context.voiceStyle}` : "",
    context.intendedUse ? `Intended use: ${context.intendedUse}` : "",
    context.modelId ? `Audio model: ${context.modelId}` : "",
    `Length: ${context.durationSeconds ?? DEFAULT_SONG_DURATION_SECONDS} seconds`,
    `Ending: begin a proper outro before the limit, resolve the song naturally, then fade smoothly to silence. Never end with an abrupt cut.`,
  ].filter(Boolean).join("\n");
}

export function withSongInterview(
  flow: SongFlowState,
  context: SongProductionContext,
  reply: string,
): SongFlowState {
  const kind = flow.kind ?? "vocal";
  const ready = isSongProductionContextReady(context, kind);
  return {
    ...flow,
    context,
    lastInterviewReply: reply,
    durationSeconds: context.durationSeconds ?? flow.durationSeconds ?? DEFAULT_SONG_DURATION_SECONDS,
    ...(ready ? { brief: songProductionBrief(context, kind) } : {}),
  };
}

/** Removes only a leading Ava wake word for intent parsing; it never determines privacy. */
export function stripAvaWakeWordForIntent(text: string): string {
  return String(text || "")
    .replace(/^\s*[@#]ava(?:!|\b)\s*/i, "")
    .replace(/^\(?private\)?\s*[:,–-]?\s*/i, "")
    .trim();
}

/**
 * [SONG-QUICK-1] Does this message ask for the ENGINE to write the words?
 * Pure and deliberately narrow: it must mention music AND carry a "don't make
 * me write or approve anything" signal. It never authorises spend on its own —
 * it only chooses which lane the conversation starts in.
 */
export function looksLikeQuickSongRequest(text: string): boolean {
  const t = stripAvaWakeWordForIntent(text).toLowerCase();
  const music = /\b(?:song|music|track|tune|jingle)\b/.test(t);
  if (!music) return false;
  const wantsNoLyricWork =
    /\b(?:quick|instant|one[\s-]?tap|straight\s?away|right\s?away)\s+(?:song|music|track|tune|jingle)\b/.test(t)
    || /\bsurprise\s+me\b/.test(t)
    || /\byou\s+(?:write|do|pick|choose|decide|handle)\s+(?:it|the\s+(?:words|lyrics?|song))\b/.test(t)
    || /\b(?:write|do)\s+(?:it|the\s+(?:words|lyrics?))\s+(?:yourself|for\s+me)\b/.test(t)
    || /\b(?:just|simply)\s+(?:make|create|generate|sing|do)\s+it\b/.test(t)
    || /\b(?:don'?t|do\s+not|no\s+need\s+to)\s+(?:ask|show)\s+me\b/.test(t)
    || /\bwithout\s+(?:showing|asking|approv\w*|review\w*)\b/.test(t)
    || /\bno\s+(?:questions|interview|approval|review)\b/.test(t)
    || /\bskip\s+the\s+(?:lyrics?|questions|interview|approval)\b/.test(t);
  if (!wantsNoLyricWork) return false;
  // An explicit "no vocals" ask is an instrumental, never an engine-written song.
  return !/\b(?:instrumental|no\s+(?:singing|vocals?|lyrics)|without\s+(?:singing|vocals?|lyrics))\b/.test(t);
}

/** The only media classifier used by the deterministic music route. */
export function classifySongRequest(text: string): SongRequestKind | null {
  const t = stripAvaWakeWordForIntent(text).toLowerCase();
  // [SONG-QUICK-1] "surprise me with a song" carries no creation verb, so the
  // verb gate below would drop it before the lane ever opened. A quick-song
  // signal is itself a creation request.
  if (looksLikeQuickSongRequest(text)) return "engine_written";
  const creation = /\b(?:make|create|generate|write|compose|produce|build)\b/.test(t);
  if (!creation) return null;
  const noVocals = /\b(?:instrumental|beat|no\s+(?:singing|vocals?|lyrics)|without\s+(?:singing|vocals?|lyrics))\b/.test(t);
  if (noVocals && !/\b(?:lyrics?|singer|sing(?:ing)?|vocal song)\b/.test(t)) return "instrumental";
  if (/\b(?:song|lyrics?|singer|sing(?:ing)?|vocals?|voice)\b/.test(t)) return "vocal";
  // Shared brainstorming continuations often omit "song": "create a slow
  // hopeful intro, acoustic rock". Creation plus unmistakably musical
  // vocabulary must stay in the song lane instead of generic chat.
  const musicalDirection = /\b(?:acoustic|rock|metal|guitar|riff|chorus|verse|bridge|outro|intro|melody|tempo|bpm|soulful|anthem|ballad|vocal|singer)\b/.test(t);
  if (musicalDirection) return "vocal";
  // [SONG-VOCAL-DEFAULT-1] "Music" and "track" are ambiguous, not synonyms
  // for instrumental. The product default is a lyrics-based song; a wordless
  // result now requires an explicit instrumental/no-vocals/beat signal above.
  if (/\b(?:music|track)\b/.test(t)) return "vocal";
  return null;
}

export function clampSongDurationSeconds(seconds: number): number {
  return Math.max(60, Math.min(210, Math.round(seconds)));
}

/** Parses explicit minute/second values, including the offered 1/1.5/2/3-minute choices. */
export function parseSongDurationSeconds(text: string): number | undefined {
  const t = stripAvaWakeWordForIntent(text).toLowerCase();
  const minutes = t.match(/\b(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|min)\b/);
  if (minutes) return clampSongDurationSeconds(Number(minutes[1]) * 60);
  const seconds = t.match(/\b(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|sec)\b/);
  if (seconds) return clampSongDurationSeconds(Number(seconds[1]));
  return undefined;
}

export function lyricWordCount(lyrics: string): number {
  return String(lyrics || "")
    .replace(/\[[^\]]+\]/g, " ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean).length;
}

export function maxLyricsWordsForDuration(durationSeconds: number): number {
  const duration = clampSongDurationSeconds(durationSeconds || DEFAULT_SONG_DURATION_SECONDS);
  const sungSeconds = Math.max(48, duration - SONG_OUTRO_RESERVE_SECONDS);
  return Math.max(40, Math.floor((sungSeconds / 60) * SUNG_WORDS_PER_MINUTE));
}

export function estimateLyricsDurationSeconds(lyrics: string): number {
  const words = lyricWordCount(lyrics);
  return Math.ceil((words / SUNG_WORDS_PER_MINUTE) * 60 + SONG_OUTRO_RESERVE_SECONDS);
}

export function lyricsFitAssessment(lyrics: string, durationSeconds: number): {
  fits: boolean; words: number; maxWords: number; estimatedSeconds: number;
} {
  const words = lyricWordCount(lyrics);
  const maxWords = maxLyricsWordsForDuration(durationSeconds);
  return {
    fits: words <= maxWords,
    words,
    maxWords,
    estimatedSeconds: estimateLyricsDurationSeconds(lyrics),
  };
}

export function songFlowKey(conv: string): string {
  return `song_flow:${conv}`;
}

export function isSongFlowState(value: unknown): value is SongFlowState {
  if (!value || typeof value !== "object") return false;
  const flow = value as SongFlowState;
  return ["awaiting_brief", "reviewing", "generating", "completed"].includes(flow.phase)
    && (flow.kind == null || flow.kind === "vocal" || flow.kind === "instrumental" || flow.kind === "engine_written")
    && (flow.conversation == null || typeof flow.conversation === "string")
    && (flow.context == null || typeof flow.context === "object")
    && (flow.lastInterviewReply == null || typeof flow.lastInterviewReply === "string")
    && (flow.brief == null || typeof flow.brief === "string")
    && (flow.durationSeconds == null || (typeof flow.durationSeconds === "number" && Number.isFinite(flow.durationSeconds)))
    && (flow.lyrics == null || typeof flow.lyrics === "string")
    && (flow.lyricsSource == null || flow.lyricsSource === "ava" || flow.lyricsSource === "user" || flow.lyricsSource === "user_fitted")
    && (flow.updatedAt == null || (typeof flow.updatedAt === "number" && Number.isFinite(flow.updatedAt)));
}

// ---------------------------------------------------------------------------
// [AVA-MULTITOOL-1] Media-lane arbitration helpers (shared by song AND video).
// Pure functions so the expiry/preference decisions are unit-testable without
// a Durable Object. AvaAgentDO owns the storage reads/writes/deletes.
// ---------------------------------------------------------------------------

/** A song/video flow untouched for this long no longer claims new turns. */
export const MEDIA_FLOW_IDLE_EXPIRY_MS = 2 * 60 * 60 * 1000;

/**
 * True when a stored flow is too stale to keep pre-empting the general tool
 * brain. A legacy flow with NO stamp predates the expiry mechanism entirely —
 * its age is unknowable and it may be days old, so it is treated as expired.
 */
export function isMediaFlowExpired(updatedAt: number | undefined, now: number): boolean {
  if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) return true;
  return now - updatedAt > MEDIA_FLOW_IDLE_EXPIRY_MS;
}

/** Stamps a flow with its write time so the next load can age it. */
export function stampFlowUpdated<T extends { updatedAt?: number }>(flow: T, now: number = Date.now()): T {
  return { ...flow, updatedAt: now };
}

/**
 * When BOTH a song flow and a video flow are somehow active for the same
 * conversation, only the most recently touched one may claim the turn.
 * Ties (including two legacy unstamped flows) keep the pre-existing lane
 * order, where the video section of turn() runs first.
 */
export function preferMostRecentLane(
  songUpdatedAt: number | undefined,
  videoUpdatedAt: number | undefined,
): "song" | "video" {
  return (songUpdatedAt ?? 0) > (videoUpdatedAt ?? 0) ? "song" : "video";
}

/** Records a freshly generated lyric draft as awaiting explicit user approval. */
export function withSongLyrics(
  flow: SongFlowState,
  lyrics: string,
  lyricsSource: "ava" | "user" | "user_fitted" = "ava",
): SongFlowState {
  return {
    ...flow,
    kind: "vocal",
    phase: "reviewing",
    lyrics: String(lyrics),
    lyricsSource,
    durationSeconds: clampSongDurationSeconds(flow.durationSeconds ?? DEFAULT_SONG_DURATION_SECONDS),
  };
}

/**
 * Extract lyrics supplied by the person without asking a model to reproduce
 * them. This intentionally returns the original line breaks and wording.
 */
export function extractUserProvidedLyrics(text: string): string | null {
  const raw = stripAvaWakeWordForIntent(text).trim();
  if (!raw) return null;
  const labelled = raw.match(/\b(?:with\s+)?(?:my|these|the following)\s+lyrics\s*[:\-–]\s*\n?([\s\S]+)$/i)
    ?? raw.match(/(?:^|\n)\s*(?:here(?:'s| are)|use|take|my|these are)\s+(?:my\s+|these\s+)?lyrics\s*[:\-–]?\s*\n?([\s\S]+)$/i)
    ?? raw.match(/(?:^|\n)\s*lyrics\s*:\s*\n?([\s\S]+)$/i);
  let candidate = (labelled?.[1] ?? raw).trim();
  const firstSection = candidate.search(/\[(?:verse|chorus|pre-chorus|bridge|outro|intro)(?:\s+\d+)?\]/i);
  if (!labelled && firstSection > 0) candidate = candidate.slice(firstSection).trim();
  const hasSections = /\[(?:verse|chorus|pre-chorus|bridge|outro|intro)(?:\s+\d+)?\]/i.test(candidate);
  const lines = candidate.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const explicitlyPresented = !!labelled;
  if ((hasSections || explicitlyPresented || (/\blyrics?\b/i.test(raw) && lines.length >= 4))
      && candidate.length >= 20) {
    return candidate;
  }
  return null;
}

export function explicitlyRequestsSongCreation(text: string): boolean {
  const t = stripAvaWakeWordForIntent(text).toLowerCase();
  return /\b(?:make|create|generate|produce|compose|turn)\b/.test(t)
    && /\b(?:song|music|track|lyrics?)\b/.test(t);
}

/**
 * [SONG-QUICK-1] Promote a flow to the engine-written quick song about to be
 * generated. The brief is REBUILT for this mode rather than reused: a brief
 * assembled while the flow was still "vocal" says "Language: X" and assumes a
 * separate lyrics_prompt that quick mode never sends, so the engine would be
 * asked for a song with no instruction to write any words. Any drafted lyrics
 * are dropped — in this mode the engine's own words are the song.
 */
export function withEngineWrittenSong(flow: SongFlowState, context: SongProductionContext): SongFlowState {
  const merged: SongProductionContext = { ...(flow.context ?? {}), ...context };
  const durationSeconds = clampSongDurationSeconds(
    merged.durationSeconds ?? flow.durationSeconds ?? DEFAULT_SONG_DURATION_SECONDS,
  );
  const withDuration: SongProductionContext = { ...merged, durationSeconds };
  return {
    ...flow,
    kind: "engine_written",
    context: withDuration,
    durationSeconds,
    lyrics: undefined,
    brief: songProductionBrief(withDuration, "engine_written"),
    phase: "generating",
  };
}

/** Marks a successfully queued generation as terminal for this draft. */
export function completeSongFlow(flow: SongFlowState): SongFlowState {
  return { ...flow, phase: "completed" };
}

/**
 * Determines the server-side transition for the current user message. `draft`
 * means the caller should invoke its lyric-drafting handler, then save the
 * result through withSongLyrics(); `generate` means invoke music generation
 * with this state's exact approved lyrics.
 */
export function nextSongFlow(flow: SongFlowState | null, text: string): SongFlowAction {
  const requestKind = classifySongRequest(text);
  // Only start a new lifecycle when no active conversation exists (or the last
  // one completed). Once active, the model—not this classifier—interprets every
  // continuation, revision, approval, hesitation, and topic change.
  if (requestKind && (!flow || flow.phase === "completed")) {
    const brief = stripAvaWakeWordForIntent(text);
    // [SONG-MEMORY-1] A new create-request right after a completed song is
    // almost always about THAT song ("create lyrics that cover 3 min" after a
    // too-short result). Starting from a blank state made Ava re-ask theme and
    // genre she had learned one minute earlier — seen in production and read
    // by the owner as Ava "forgetting". Seed the new lifecycle with the
    // completed song's creative context; the interview model decides whether
    // to treat it as a revision or (via its restart action) sever it.
    const carried = flow?.phase === "completed" && flow.context ? flow.context : undefined;
    return {
      kind: "ask_brief",
      flow: {
        phase: "awaiting_brief", kind: requestKind, brief, conversation: brief,
        durationSeconds: parseSongDurationSeconds(brief) ?? carried?.durationSeconds ?? DEFAULT_SONG_DURATION_SECONDS,
        ...(carried ? { context: carried, lastInterviewReply: flow?.lastInterviewReply } : {}),
      },
    };
  }
  if (!flow) {
    return requestKind
      ? { kind: "ask_brief", flow: { phase: "awaiting_brief", kind: requestKind } }
      : { kind: "none", flow: null };
  }

  if (flow.phase === "awaiting_brief" || flow.phase === "reviewing") {
    const brief = stripAvaWakeWordForIntent(text);
    if (!brief) return { kind: "ask_brief", flow };
    const priorConversation = flow.conversation ?? flow.brief;
    const conversation = [priorConversation, brief].filter(Boolean).join("\n\n");
    // AI owns interpretation and the conversational response. This transition
    // only persists raw user turns; it never keyword-matches answers or writes a
    // questionnaire. AvaAgentDO promotes the flow after structured extraction.
    return {
      kind: "ask_brief",
      flow: {
        ...flow, conversation,
        durationSeconds: parseSongDurationSeconds(brief) ?? flow.durationSeconds ?? DEFAULT_SONG_DURATION_SECONDS,
      },
    };
  }

  return { kind: "none", flow };
}
