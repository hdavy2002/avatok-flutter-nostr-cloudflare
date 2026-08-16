// Deterministic, provider-free song-flow state helpers. AvaAgentDO owns storage
// and calls Venice; this module only normalizes intent and describes the next
// safe transition so continuation turns do not depend on model tool selection.

export type SongFlowPhase = "awaiting_brief" | "reviewing" | "generating" | "completed";
export type SongRequestKind = "vocal" | "instrumental";

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
}

export type SongFlowAction =
  | { kind: "none"; flow: SongFlowState | null }
  | { kind: "ask_brief"; flow: SongFlowState }
  | { kind: "draft"; flow: SongFlowState }
  | { kind: "generate"; flow: SongFlowState };

function hasText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function isSongProductionContextReady(context: SongProductionContext | undefined, kind: SongRequestKind): boolean {
  if (!context) return false;
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
    kind === "vocal" ? `Language: ${context.language ?? ""}` : "No lyrics or vocals.",
    kind === "vocal" && context.vocalArrangement ? `Vocal arrangement: ${context.vocalArrangement}` : "",
    kind === "vocal" && context.voiceStyle ? `Voice character: ${context.voiceStyle}` : "",
    context.intendedUse ? `Intended use: ${context.intendedUse}` : "",
    `Length: ${context.durationSeconds ?? 60} seconds`,
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
    durationSeconds: context.durationSeconds ?? flow.durationSeconds ?? 60,
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

/** Explicit request to move from a gathered brief into lyric drafting. */
export function isSongDraftIntent(text: string): boolean {
  const t = stripAvaWakeWordForIntent(text).toLowerCase().replace(/[.!?]+$/, "").trim();
  return /^(?:go ahead|proceed|continue)(?:\s+and\s+(?:start\s+)?(?:draft|write|create)(?:\s+(?:it|the\s+lyrics?|the\s+song|lyrics?|song))?)?$/.test(t)
    || /^(?:(?:yes|okay|ok|sure)[, ]+)?(?:please\s+|now\s+)?(?:start\s+)?(?:draft|write|create)\s+(?:it|the\s+lyrics?|the\s+song|lyrics?|song)$/.test(t);
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
    && (flow.conversation == null || typeof flow.conversation === "string")
    && (flow.context == null || typeof flow.context === "object")
    && (flow.lastInterviewReply == null || typeof flow.lastInterviewReply === "string")
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
      (flow.phase === "reviewing" && !isSongRevisionIntent(text)))) {
    const brief = stripAvaWakeWordForIntent(text);
    return {
      kind: "ask_brief",
      flow: {
        phase: "awaiting_brief", kind: requestKind, brief, conversation: brief,
        durationSeconds: parseSongDurationSeconds(brief) ?? 60,
      },
    };
  }
  if (!flow) {
    return requestKind
      ? { kind: "ask_brief", flow: { phase: "awaiting_brief", kind: requestKind } }
      : { kind: "none", flow: null };
  }

  if (flow.phase === "awaiting_brief") {
    const brief = stripAvaWakeWordForIntent(text);
    if (!brief) return { kind: "ask_brief", flow };
    const kind = flow.kind ?? "vocal";
    if (isSongProductionContextReady(flow.context, kind) &&
        (isSongApproval(text) || isSongDraftIntent(text))) {
      return {
        kind: kind === "instrumental" ? "generate" : "draft",
        flow: {
          ...flow,
          brief: flow.brief ?? songProductionBrief(flow.context!, kind),
          phase: kind === "instrumental" ? "generating" : "awaiting_brief",
        },
      };
    }
    const priorConversation = flow.conversation ?? flow.brief;
    const conversation = [priorConversation, brief].filter(Boolean).join("\n\n");
    // AI owns interpretation and the conversational response. This transition
    // only persists raw user turns; it never keyword-matches answers or writes a
    // questionnaire. AvaAgentDO promotes the flow after structured extraction.
    return {
      kind: "ask_brief",
      flow: {
        ...flow, phase: "awaiting_brief", conversation,
        durationSeconds: parseSongDurationSeconds(brief) ?? flow.durationSeconds ?? 60,
      },
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
          kind: flow.kind ?? "vocal",
          conversation: [flow.conversation ?? flow.brief, revision].filter(Boolean).join("\n\n"),
          context: flow.context,
          brief: [flow.brief, revision].filter(Boolean).join("\n\n"),
          durationSeconds: parseSongDurationSeconds(revision) ?? flow.durationSeconds ?? 60,
        },
      };
    }
  }

  return { kind: "none", flow };
}
