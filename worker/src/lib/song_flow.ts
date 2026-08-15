// Deterministic, provider-free song-flow state helpers. AvaAgentDO owns storage
// and calls Venice; this module only normalizes intent and describes the next
// safe transition so continuation turns do not depend on model tool selection.

export type SongFlowPhase = "awaiting_brief" | "reviewing" | "generating" | "completed";

export interface SongFlowState {
  phase: SongFlowPhase;
  brief?: string;
  durationSeconds?: number;
  lyrics?: string;
}

export type SongFlowAction =
  | { kind: "none"; flow: SongFlowState | null }
  | { kind: "ask_brief"; flow: SongFlowState }
  | { kind: "draft"; flow: SongFlowState }
  | { kind: "generate"; flow: SongFlowState };

export const SONG_BRIEF_QUESTION =
  "Let’s shape it together. What should it be about, and what genre, mood, instruments, language, and length (1, 1.5, 2, or 3 minutes) do you want? For vocals, choose male, female, or group singing; voice ideas include warm and intimate, bright and soulful, deep and powerful, or airy and dreamlike. I’ll draft the lyrics only after we have those choices, then you can revise them before I make the track.";

export const SONG_CONTEXT_QUESTION =
  "Before I draft the lyrics, what language should I use, and would you like a male, female, or group voice? You can also pick a voice character such as warm and intimate, bright and soulful, deep and powerful, or airy and dreamlike. I’ll keep refining the brief with you until you say it’s ready.";

function hasSongProductionContext(text: string): boolean {
  const t = stripAvaWakeWordForIntent(text).toLowerCase();
  const hasLanguage = /\b(?:english|hindi|spanish|french|german|tamil|telugu|bengali|marathi|punjabi|urdu|portuguese|language)\b/.test(t);
  const hasVoice = /\b(?:male|female|woman|man|group|choir|duet|voice|singer|singing)\b/.test(t);
  return hasLanguage && hasVoice;
}

/** Removes only a leading Ava wake word for intent parsing; it never determines privacy. */
export function stripAvaWakeWordForIntent(text: string): string {
  return String(text || "")
    .replace(/^\s*[@#]ava(?:!|\b)\s*/i, "")
    .replace(/^\(?private\)?\s*[:,–-]?\s*/i, "")
    .trim();
}

/** True only for an underspecified request that needs a songwriting brief. */
export function isBareSongRequest(text: string): boolean {
  const t = stripAvaWakeWordForIntent(text).toLowerCase();
  return /^(?:can\s+you\s+|could\s+you\s+|please\s+)?(?:make|create|generate|write|compose)\s+(?:me\s+)?(?:(?:a|another|new)\s+)?song(?:\s+for\s+me)?[.!?]*$/.test(t);
}

/** Any explicit request to create a song, including a supplied theme/style. */
export function isSongCreationRequest(text: string): boolean {
  const t = stripAvaWakeWordForIntent(text).toLowerCase();
  return /\b(?:make|create|generate|write|compose)\b.{0,120}\bsong\b/.test(t);
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

/** Exact approval replies only; phrases that merely mention approval do not qualify. */
export function isSongApproval(text: string): boolean {
  const t = stripAvaWakeWordForIntent(text).toLowerCase().replace(/[.!?]+$/, "").trim();
  return /^(?:yes(?:,?\s+(?:make|generate|create)\s+it)?|approved|go ahead|make it|generate it|create it|looks good|perfect)$/.test(t);
}

/** A request to alter a reviewed lyric draft, rather than approve it. */
export function isSongRevisionIntent(text: string): boolean {
  const t = stripAvaWakeWordForIntent(text).toLowerCase();
  return /^(?:please\s+)?(?:change|revise|rewrite|edit|adjust|tweak|redo)\b/.test(t)
    || /\b(?:make|change)\s+(?:the\s+)?(?:lyrics?|song|chorus|verse|ending)\b/.test(t)
    || /\b(?:different|another)\s+(?:chorus|verse|ending|style|genre|mood)\b/.test(t);
}

export function songFlowKey(conv: string): string {
  return `song_flow:${conv}`;
}

export function isSongFlowState(value: unknown): value is SongFlowState {
  if (!value || typeof value !== "object") return false;
  const flow = value as SongFlowState;
  return ["awaiting_brief", "reviewing", "generating", "completed"].includes(flow.phase)
    && (flow.brief == null || typeof flow.brief === "string")
    && (flow.durationSeconds == null || (typeof flow.durationSeconds === "number" && Number.isFinite(flow.durationSeconds)))
    && (flow.lyrics == null || typeof flow.lyrics === "string");
}

/** Records a freshly generated lyric draft as awaiting explicit user approval. */
export function withSongLyrics(flow: SongFlowState, lyrics: string): SongFlowState {
  return { ...flow, phase: "reviewing", lyrics: String(lyrics), durationSeconds: clampSongDurationSeconds(flow.durationSeconds ?? 60) };
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
  if (isBareSongRequest(text) && flow?.phase !== "awaiting_brief") {
    return { kind: "ask_brief", flow: { phase: "awaiting_brief" } };
  }
  if (isSongCreationRequest(text) && (!flow || flow.phase === "completed")) {
    const brief = stripAvaWakeWordForIntent(text);
    return {
      kind: "ask_brief",
      flow: { phase: "awaiting_brief", brief, durationSeconds: parseSongDurationSeconds(brief) ?? 60 },
    };
  }
  if (!flow) {
    if (!isBareSongRequest(text)) return { kind: "none", flow: null };
    return { kind: "ask_brief", flow: { phase: "awaiting_brief" } };
  }

  if (flow.phase === "awaiting_brief") {
    if (flow.brief && hasSongProductionContext(flow.brief)
        && /^(?:please\s+)?(?:try|retry)(?:\s+again)?[.!?]*$/i.test(stripAvaWakeWordForIntent(text))) {
      return { kind: "draft", flow };
    }
    const brief = stripAvaWakeWordForIntent(text);
    if (!brief) return { kind: "ask_brief", flow };
    const combined = [flow.brief, brief].filter(Boolean).join("\n\n");
    if (!hasSongProductionContext(combined)) {
      return { kind: "ask_brief", flow: { ...flow, brief: combined } };
    }
    return {
      kind: "draft",
      flow: { phase: "awaiting_brief", brief: combined, durationSeconds: parseSongDurationSeconds(brief) ?? flow.durationSeconds ?? 60 },
    };
  }

  if (flow.phase === "reviewing") {
    if (isSongApproval(text) && flow.lyrics) return { kind: "generate", flow: { ...flow, phase: "generating" } };
    if (isSongRevisionIntent(text)) {
      const revision = stripAvaWakeWordForIntent(text);
      return {
        kind: "draft",
        flow: {
          phase: "awaiting_brief",
          brief: [flow.brief, revision].filter(Boolean).join("\n\n"),
          durationSeconds: parseSongDurationSeconds(revision) ?? flow.durationSeconds ?? 60,
        },
      };
    }
  }

  return { kind: "none", flow };
}
