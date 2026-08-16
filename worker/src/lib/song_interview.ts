import type { SongFlowState, SongProductionContext, SongRequestKind } from "./song_flow";
import { clampSongDurationSeconds } from "./song_flow";

export const SONG_INTERVIEW_SYSTEM = `You are Ava, a warm, perceptive music producer having a real conversation with a person who wants to create a song.

Your job is to understand their intent over multiple turns, remember every choice already made, offer genuinely useful musical suggestions that fit their genre and purpose, and naturally gather what is still needed. Interpret ordinary speech, typos, shorthand, indirect answers, and phrases such as "you choose" using the previous assistant reply and saved context.

For a vocal song, the essential direction is: theme or purpose, genre, mood/energy, lyric language, and duration. Instruments, vocal arrangement (male/female/duet/group/etc.), voice character, and intended use are useful producer details when the person expresses a preference. For an instrumental, the essential direction is: theme/purpose/use, genre, mood/energy, and duration. These are internal goals, never a checklist to recite.

Conversation rules:
- First decide whether the latest message is continuing this song discussion. If the person clearly changes topic or asks for another kind of work (for example a video, image, email, or unrelated question), set action to "switch". Do not force the new request into the song.
- Infer what the person means from the full conversation, current phase, prior Ava reply, and saved creative direction. Never decide from a literal keyword or require a command phrase.
- Respond naturally to what the person just said. Acknowledge, react, or briefly explain a musical tradeoff when useful.
- Ask at most ONE focused follow-up question per turn — and prefer asking none. As soon as the theme and overall vibe are clear, propose ONE complete plan in a single short message (genre, mood, language, length, filled in with sensible producer choices) and ask only for a go-ahead. Never spread choices you can make yourself across multiple turns.
- If the person shows ANY impatience ("just do it", "write the full song", "stop asking", frustration, or an insult), stop asking questions entirely: fill every remaining choice with sensible producer defaults from the conversation and move straight to draft or generate.
- The requested duration is a HARD requirement. Confirm it back, keep it in context.durationSeconds, and when drafting or judging lyrics make sure they contain enough sung content to fill that whole length — a 3-minute song needs a full multi-verse lyric, not a fragment.
- When savedContext already describes a song (including one just completed) and the person asks for a change — longer, shorter, new lyrics, different mood — treat it as a REVISION of that song: keep every choice they haven't changed and never re-ask what savedContext already answers.
- Suggestions must be tailored to the actual song. Do not reuse generic examples.
- Treat availableModels as the current source of truth. When model choice, supported length, capabilities or price becomes relevant, explain only those live options naturally; never invent or hardcode a provider capability or price.
- Never dump a list of missing fields, mention required fields, say "I still need", or sound like a form.
- Do not repeatedly ask something already answered. If an answer is ambiguous, clarify it conversationally.
- Do not invent a user preference unless the conversation gives Ava permission to choose; when it does, make sensible producer choices and record them.
- Choose action "discuss" when the person wants to keep shaping the idea or one essential creative decision is genuinely unclear.
- Choose action "draft" when the person means that Ava should now write or rewrite vocal lyrics. A revision may be expressed in ordinary conversational language.
- Choose action "generate" when the person means that Ava should create an instrumental, or accepts the currently reviewed vocal lyrics and wants the finished song created.
- Choose action "restart" when the person is clearly starting a different song idea rather than revising the active one. Build context only from the new idea; do not carry creative choices from the older song into it.
- Choose action "switch" when the person has moved to a different topic or kind of work.
- The reply must match the action. Never promise to draft or generate while returning "discuss".

Return ONLY valid JSON with this shape:
{"action":"discuss","reply":"natural Ava response","context":{"theme":string|null,"genre":string|null,"mood":string|null,"instruments":string[],"language":string|null,"vocalArrangement":string|null,"voiceStyle":string|null,"durationSeconds":number|null,"intendedUse":string|null,"modelId":string|null}}

The action value must be "discuss", "draft", "generate", "restart", or "switch". For every action except "switch", context must contain the best current understanding after this turn, preserving prior values unless the person changed them. For "restart", context must instead describe only the new song. Choose "draft" only when the essential vocal direction is known. Choose "generate" for a vocal song only when the current lyrics are under review and the person has accepted them. For action "switch", the reply may be empty because the new request will be handled by Ava's normal conversation route.`;

export const SONG_INTERVIEW_FALLBACK_MODEL = "gemini-3-7-flash";

function cleanText(value: unknown, max = 240): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, max) : undefined;
}

function cleanInstruments(value: unknown): string[] | undefined {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string" ? value.split(/,|\band\b/i) : [];
  const cleaned = values.map(item => cleanText(item, 80)).filter((item): item is string => !!item).slice(0, 12);
  return cleaned.length ? cleaned : undefined;
}

function mergeContext(previous: SongProductionContext | undefined, raw: Record<string, unknown>, availableModels: unknown[] = []): SongProductionContext {
  const durationRaw = Number(raw.durationSeconds);
  const durationSeconds = Number.isFinite(durationRaw) && durationRaw > 0
    ? clampSongDurationSeconds(durationRaw)
    : previous?.durationSeconds;
  const requestedModel = cleanText(raw.modelId, 160);
  const allowedIds = availableModels.map((m) => m && typeof m === "object" ? cleanText((m as Record<string, unknown>).id, 160) : undefined).filter(Boolean);
  return {
    theme: cleanText(raw.theme) ?? previous?.theme,
    genre: cleanText(raw.genre, 120) ?? previous?.genre,
    mood: cleanText(raw.mood, 160) ?? previous?.mood,
    instruments: cleanInstruments(raw.instruments) ?? previous?.instruments,
    language: cleanText(raw.language, 80) ?? previous?.language,
    vocalArrangement: cleanText(raw.vocalArrangement, 120) ?? previous?.vocalArrangement,
    voiceStyle: cleanText(raw.voiceStyle, 160) ?? previous?.voiceStyle,
    durationSeconds,
    intendedUse: cleanText(raw.intendedUse, 160) ?? previous?.intendedUse,
    modelId: requestedModel && allowedIds.includes(requestedModel) ? requestedModel : previous?.modelId,
  };
}

export interface SongInterviewTurn {
  action: "discuss" | "draft" | "generate" | "restart" | "switch";
  reply: string;
  context: SongProductionContext;
}

/** Parse and sanitize an AI interview turn. Server code, not model prose, validates readiness. */
export function parseSongInterviewTurn(rawText: string, previous?: SongProductionContext, availableModels: unknown[] = []): SongInterviewTurn {
  const raw = String(rawText || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("song interview returned no JSON object");
  const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  const action = ["draft", "generate", "restart", "switch"].includes(String(parsed.action))
    ? parsed.action as SongInterviewTurn["action"]
    : "discuss";
  const reply = cleanText(parsed.reply, 700);
  const contextRaw = parsed.context && typeof parsed.context === "object"
    ? parsed.context as Record<string, unknown>
    : {};
  if (action !== "switch" && !reply) throw new Error("song interview returned an empty reply");
  return {
    action,
    reply: reply ?? "",
    // A semantic restart deliberately severs stale creative choices. Every
    // other action keeps the normal merge behavior for shorthand follow-ups.
    context: mergeContext(action === "restart" ? undefined : previous, contextRaw, availableModels),
  };
}

/**
 * Keep a conversational AI reply when a provider ignores the JSON contract.
 * It may discuss only: without structured output, the server cannot safely
 * draft, generate, switch topics, or replace saved production context.
 */
export function recoverSongInterviewDiscussion(
  rawText: string,
  previous?: SongProductionContext,
): SongInterviewTurn | null {
  const raw = String(rawText || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  // Never expose broken JSON or model-protocol fragments in the chat.
  if (!raw || raw.includes("{") || raw.includes("}")) return null;
  const reply = cleanText(raw, 700);
  return reply ? { action: "discuss", reply, context: previous ?? {} } : null;
}

/** Last resort after every independent model path has failed. */
export function songInterviewRecoveryReply(): string {
  return "I kept your song direction, but the producer pass did not return a usable reply. Send your next thought and I’ll continue from the same point.";
}

export function songInterviewUserPayload(
  flow: SongFlowState,
  latestUserText: string,
  serverValidationFeedback?: string,
  availableModels?: unknown[],
): string {
  const kind: SongRequestKind = flow.kind ?? "vocal";
  return JSON.stringify({
    songType: kind,
    currentPhase: flow.phase,
    savedContext: flow.context ?? {},
    currentLyrics: flow.lyrics ? String(flow.lyrics).slice(-6000) : null,
    previousAvaReply: flow.lastInterviewReply ?? null,
    latestUserMessage: String(latestUserText || "").slice(0, 2000),
    userConversationSoFar: String(flow.conversation ?? flow.brief ?? "").slice(-6000),
    serverValidationFeedback: serverValidationFeedback ?? null,
    availableModels: availableModels ?? [],
  });
}
