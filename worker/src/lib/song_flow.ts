// Deterministic, provider-free song-flow state helpers. AvaAgentDO owns storage
// and calls Venice; this module only normalizes intent and describes the next
// safe transition so continuation turns do not depend on model tool selection.

export type SongFlowPhase = "awaiting_brief" | "reviewing" | "generating" | "completed";
export type SongRequestKind = "vocal" | "instrumental";

export interface SongFlowState {
  phase: SongFlowPhase;
  kind?: SongRequestKind;
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

export const INSTRUMENTAL_BRIEF_QUESTION =
  "Let’s shape the instrumental. What genre, mood, energy, setting, instruments, tempo, and intended use do you want? For example: a funky reggae groove with warm bass, skank guitar, hand percussion, and an upbeat beach feel for a travel reel. I’ll use that direction to make the track — no lyrics or vocals.";

export function hasSongProductionContext(text: string): boolean {
  const t = stripAvaWakeWordForIntent(text).toLowerCase();
  const hasLanguage = /\b(?:english|hindi|spanish|french|german|tamil|telugu|bengali|marathi|punjabi|urdu|portuguese|language)\b/.test(t);
  const hasVoice = /\b(?:male|female|woman|man|group|choir|duet|voice|singer|singing)\b/.test(t);
  return hasLanguage && hasVoice;
}

export function hasInstrumentalProductionContext(text: string): boolean {
  const t = stripAvaWakeWordForIntent(text).toLowerCase();
  return /\b(?:instrumental|beat|no\s+vocals?|without\s+(?:singing|vocals?|lyrics))\b/.test(t)
    && /\b(?:genre|reggae|rock|pop|jazz|lofi|lo-fi|ambient|house|hip[- ]?hop|classical|funk|soul|mood|vibe|energy|tempo|bpm|instrument|bass|drum|guitar|piano|synth|strings|percussion|cinematic|focus|travel|dance|relax)\b/.test(t);
}

/** Removes only a leading Ava wake word for intent parsing; it never determines privacy. */
export function stripAvaWakeWordForIntent(text: string): string {
  return String(text || "")
    .replace(/^\s*[@#]ava(?:!|\b)\s*/i, "")
    .replace(/^\(?private\)?\s*[:,–-]?\s*/i, "")
    .trim();
}

/** The only media classifier used by the deterministic music route. */
export function classifySongRequest(text: string): SongRequestKind | null {
  const t = stripAvaWakeWordForIntent(text).toLowerCase();
  const creation = /\b(?:make|create|generate|write|compose|produce|build)\b/.test(t);
  if (!creation) return null;
  const noVocals = /\b(?:instrumental|beat|no\s+(?:singing|vocals?|lyrics)|without\s+(?:singing|vocals?|lyrics))\b/.test(t);
  if (noVocals && !/\b(?:lyrics?|singer|sing(?:ing)?|vocal song)\b/.test(t)) return "instrumental";
  if (/\b(?:song|lyrics?|singer|sing(?:ing)?|vocal)\b/.test(t)) return "vocal";
  if (/\b(?:music|track|beat|instrumental)\b/.test(t)) return "instrumental";
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
    && (flow.kind == null || flow.kind === "vocal" || flow.kind === "instrumental")
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
  const requestKind = classifySongRequest(text);
  // A fresh creation request replaces an abandoned older brief/draft. Revision
  // language stays attached to the current draft instead of restarting it.
  if (requestKind && (!flow || flow.phase === "completed" ||
      (flow.phase !== "generating" && !isSongRevisionIntent(text)))) {
    const brief = stripAvaWakeWordForIntent(text);
    return {
      kind: "ask_brief",
      flow: { phase: "awaiting_brief", kind: requestKind, brief, durationSeconds: parseSongDurationSeconds(brief) ?? 60 },
    };
  }
  if (!flow) {
    return requestKind
      ? { kind: "ask_brief", flow: { phase: "awaiting_brief", kind: requestKind } }
      : { kind: "none", flow: null };
  }

  if (flow.phase === "awaiting_brief") {
    if (flow.brief && hasSongProductionContext(flow.brief)
        && /^(?:please\s+)?(?:try|retry)(?:\s+again)?[.!?]*$/i.test(stripAvaWakeWordForIntent(text))) {
      return { kind: "draft", flow };
    }
    const brief = stripAvaWakeWordForIntent(text);
    if (!brief) return { kind: "ask_brief", flow };
    const combined = [flow.brief, brief].filter(Boolean).join("\n\n");
    const kind = flow.kind ?? "vocal";
    const complete = kind === "instrumental"
      ? hasInstrumentalProductionContext(combined)
      : hasSongProductionContext(combined);
    if (!complete) {
      return { kind: "ask_brief", flow: { ...flow, brief: combined } };
    }
    if (kind === "instrumental") {
      return { kind: "generate", flow: { ...flow, kind, phase: "generating", brief: combined, durationSeconds: parseSongDurationSeconds(brief) ?? flow.durationSeconds ?? 60 } };
    }
    return {
      kind: "draft",
      flow: { phase: "awaiting_brief", kind, brief: combined, durationSeconds: parseSongDurationSeconds(brief) ?? flow.durationSeconds ?? 60 },
    };
  }

  if (flow.phase === "reviewing") {
    if (flow.kind !== "instrumental" && isSongApproval(text) && flow.lyrics) return { kind: "generate", flow: { ...flow, phase: "generating" } };
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
