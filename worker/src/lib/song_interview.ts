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
- Song length: availableModels states the real supported durations. If the person asks for a length no available model supports, say so plainly and tell them the longest you CAN make (for example "I can make songs up to about 3.5 minutes"), then offer that. Never accept an unsupported length.
- The requested duration is a HARD requirement. Confirm it back, keep it in context.durationSeconds, and when drafting or judging lyrics make sure they contain enough sung content to fill that whole length — a 3-minute song needs a full multi-verse lyric, not a fragment.
- When savedContext already describes a song (including one just completed) and the person asks for a change — longer, shorter, new lyrics, different mood — treat it as a REVISION of that song: keep every choice they haven't changed and never re-ask what savedContext already answers.
- Suggestions must be tailored to the actual song. Do not reuse generic examples.
- Treat availableModels as the current source of truth. When model choice, supported length, capabilities or price becomes relevant, explain only those live options naturally; never invent or hardcode a provider capability or price.
- Never dump a list of missing fields, mention required fields, say "I still need", or sound like a form.
- Do not repeatedly ask something already answered. If an answer is ambiguous, clarify it conversationally.
- Do not invent a user preference unless the conversation gives Ava permission to choose; when it does, make sensible producer choices and record them.
- Choose action "discuss" when the person wants to keep shaping the idea or one essential creative decision is genuinely unclear.
- Choose action "draft" when the person means that Ava should now write or rewrite vocal lyrics. A revision may be expressed in ordinary conversational language.
- Choose action "accept_lyrics" when the person has supplied their own lyrics. Never rewrite, summarize, translate, sanitize, or reproduce those lyrics in JSON; the server takes the exact text from latestUserMessage. Preserve all creative context, acknowledge that their exact words will be used, and ask for approval only if they did not already explicitly ask to create the finished song.
- Choose action "generate" when the person means that Ava should create an instrumental, or accepts the currently reviewed vocal lyrics and wants the finished song created.
- Choose action "quick_generate" when the person does not want to write or approve lyrics at all and just wants a finished song now — "quick song", "you write it", "surprise me", "just make it", "one tap", "don't show me the words", or plain impatience with the lyric step. Also prefer it when songType is "engine_written". In this mode the music engine writes AND sings its own words from your brief, so pick quick_generate as soon as you know what the song is about and how long it should be; do not gather anything else. Your reply for quick_generate MUST set expectations in the person's own language: the engine writes the words itself, so they cannot be read or approved first, and the exact wording may not be what they pictured. Offer, in one short clause, that they can ask for lyrics they approve instead.
- Choose action "restart" when the person is clearly starting a different song idea rather than revising the active one. Build context only from the new idea; do not carry creative choices from the older song into it.
- Choose action "switch" when the person has moved to a different topic or kind of work.
- The reply must match the action. Never promise to draft or generate while returning "discuss".

Return ONLY valid JSON with this shape:
{"action":"discuss","reply":"natural Ava response","context":{"theme":string|null,"genre":string|null,"mood":string|null,"instruments":string[],"language":string|null,"vocalArrangement":string|null,"voiceStyle":string|null,"durationSeconds":number|null,"intendedUse":string|null,"modelId":string|null}}

The action value must be "discuss", "draft", "accept_lyrics", "generate", "quick_generate", "restart", or "switch". For every action except "switch", context must contain the best current understanding after this turn, preserving prior values unless the person changed them. For "restart", context must instead describe only the new song. Choose "draft" only when the essential vocal direction is known. Choose "accept_lyrics" whenever the person supplies lyrics, even when they also ask to make the finished song. Choose "generate" for a vocal song only when the current lyrics are under review and the person has accepted them. Choose "quick_generate" only when the person has asked, in effect, for Ava to skip the lyric step entirely. For action "switch", the reply may be empty because the new request will be handled by Ava's normal conversation route.`;

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
  // [SONG-QUICK-1] "quick_generate" = engine-written one-shot song. It is a
  // SPEND action, so like "generate" it is only a PROPOSAL here: do/ava_agent.ts's
  // canExecute() re-validates it against the saved server state before a token
  // is reserved. The model never authorises spend on its own.
  action: "discuss" | "draft" | "accept_lyrics" | "generate" | "quick_generate" | "restart" | "switch";
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
  const action = ["draft", "accept_lyrics", "generate", "quick_generate", "restart", "switch"].includes(String(parsed.action))
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

/**
 * Deterministic recovery for the two high-confidence turns that must never
 * loop on a canned model-failure reply: a duration answer and an explicit
 * instrumental-generation request. It does not guess spend intent; generation
 * is returned only when the user's latest words explicitly ask to create/make.
 */
export function recoverSongInterviewLocally(
  flow: SongFlowState,
  latestUserText: string,
): SongInterviewTurn | null {
  const latest = String(latestUserText || "").trim();
  const history = `${flow.conversation ?? ""} ${latest}`;
  const durationMatch = history.match(/(?:do\s+)?(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|min)?\b/i);
  const parsedMinutes = durationMatch ? Number(durationMatch[1]) : NaN;
  const durationSeconds = Number.isFinite(parsedMinutes)
    ? clampSongDurationSeconds(parsedMinutes <= 10 ? parsedMinutes * 60 : parsedMinutes)
    : (flow.context?.durationSeconds ?? flow.durationSeconds);

  const asksInstrumental = /\binstrumental\b/i.test(latest) && /\b(create|make|generate|compose)\b/i.test(latest);
  if (asksInstrumental) {
    const cleaned = latest
      .replace(/\b(create|make|generate|compose)(?:\s+me)?\b/gi, "")
      .replace(/\ban?\s+instrumental(?:\s+(?:music|song|track))?\b/gi, "")
      .replace(/\bfor\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    const theme = cleaned || flow.context?.theme || "a calm, happy morning";
    const context: SongProductionContext = {
      ...flow.context,
      theme,
      genre: flow.context?.genre || "ambient acoustic instrumental",
      mood: flow.context?.mood || (/calm/i.test(latest) && /happy/i.test(latest)
        ? "calm, warm and happy" : "calm and uplifting"),
      instruments: flow.context?.instruments?.length
        ? flow.context.instruments
        : ["soft piano", "acoustic guitar", "warm pads"],
      intendedUse: flow.context?.intendedUse || (/morning/i.test(latest) ? "happy morning listening" : undefined),
      durationSeconds: durationSeconds ?? 60,
    };
    return {
      action: "generate",
      reply: `Got it — I’m creating a ${Math.round((context.durationSeconds ?? 60) / 6) / 10}-minute calm instrumental with soft piano, acoustic guitar and warm pads.`,
      context,
    };
  }

  const durationOnly = /^\s*(?:do\s+)?\d+(?:\.\d+)?\s*(?:minutes?|mins?|min)?\s*[.!]?\s*$/i.test(latest);
  if (durationOnly && durationSeconds) {
    return {
      action: "discuss",
      reply: `Perfect — I’ve set it to ${Math.round(durationSeconds / 6) / 10} minutes. Tell me the feeling or occasion, and I’ll shape the music around it.`,
      context: { ...flow.context, durationSeconds },
    };
  }
  return null;
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
