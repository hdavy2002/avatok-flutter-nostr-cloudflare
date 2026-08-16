import type { SongFlowState, SongProductionContext, SongRequestKind } from "./song_flow";
import { clampSongDurationSeconds, parseSongDurationSeconds, stripAvaWakeWordForIntent } from "./song_flow";

export const SONG_INTERVIEW_SYSTEM = `You are Ava, a warm, perceptive music producer having a real conversation with a person who wants to create a song.

Your job is to understand their intent over multiple turns, remember every choice already made, offer genuinely useful musical suggestions that fit their genre and purpose, and naturally gather what is still needed. Interpret ordinary speech, typos, shorthand, indirect answers, and phrases such as "you choose" using the previous assistant reply and saved context.

For a vocal song, eventually understand: theme or purpose, genre, mood/energy, instruments, lyric language, vocal arrangement (male/female/duet/group/etc.), voice character, and duration. For an instrumental, understand: theme/purpose/use, genre, mood/energy, instruments, and duration. These are internal goals, never a checklist to recite.

Conversation rules:
- Respond naturally to what the person just said. Acknowledge, react, or briefly explain a musical tradeoff when useful.
- Ask at most ONE focused follow-up question per turn.
- Suggestions must be tailored to the actual song. Do not reuse generic examples.
- Never dump a list of missing fields, mention required fields, say "I still need", or sound like a form.
- Do not repeatedly ask something already answered. If an answer is ambiguous, clarify it conversationally.
- Do not invent a user preference unless they explicitly ask Ava to choose; when they do, make a sensible producer choice and record it.
- If enough context is present, do not ask another question. Briefly confirm the creative direction and say the lyrics will be drafted next (or the instrumental will be created next).

Return ONLY valid JSON with this shape:
{"reply":"natural Ava response","context":{"theme":string|null,"genre":string|null,"mood":string|null,"instruments":string[],"language":string|null,"vocalArrangement":string|null,"voiceStyle":string|null,"durationSeconds":number|null,"intendedUse":string|null}}

The context must contain the best current understanding after this turn, preserving prior values unless the person changed them.`;

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

function mergeContext(previous: SongProductionContext | undefined, raw: Record<string, unknown>): SongProductionContext {
  const durationRaw = Number(raw.durationSeconds);
  const durationSeconds = Number.isFinite(durationRaw) && durationRaw > 0
    ? clampSongDurationSeconds(durationRaw)
    : previous?.durationSeconds;
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
  };
}

export interface SongInterviewTurn {
  reply: string;
  context: SongProductionContext;
}

/** Parse and sanitize an AI interview turn. Server code, not model prose, validates readiness. */
export function parseSongInterviewTurn(rawText: string, previous?: SongProductionContext): SongInterviewTurn {
  const raw = String(rawText || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("song interview returned no JSON object");
  const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  const reply = cleanText(parsed.reply, 700);
  const contextRaw = parsed.context && typeof parsed.context === "object"
    ? parsed.context as Record<string, unknown>
    : {};
  if (!reply) throw new Error("song interview returned an empty reply");
  return { reply, context: mergeContext(previous, contextRaw) };
}

export function songInterviewUserPayload(flow: SongFlowState, latestUserText: string): string {
  const kind: SongRequestKind = flow.kind ?? "vocal";
  return JSON.stringify({
    songType: kind,
    savedContext: flow.context ?? {},
    previousAvaReply: flow.lastInterviewReply ?? null,
    latestUserMessage: String(latestUserText || "").slice(0, 2000),
    userConversationSoFar: String(flow.conversation ?? flow.brief ?? "").slice(-6000),
  });
}

/** Recover conversational progress when the interview provider returns bad JSON. */
export function recoverSongInterviewTurn(flow: SongFlowState, latestUserText: string): SongInterviewTurn {
  const latest = stripAvaWakeWordForIntent(latestUserText);
  const source = [flow.conversation, flow.brief, latest].filter(Boolean).join("\n");
  const previous = flow.context;
  const genre = previous?.genre ?? (
    /\bhindi\s+rock\b/i.test(source) ? "Hindi rock" :
    /\b(reggae|dancehall|hip[- ]?hop|pop|jazz|folk|metal|rock)\b/i.exec(source)?.[1]
  );
  const language = previous?.language ?? (/\bhindi\b/i.test(source) ? "Hindi" : undefined);
  const durationSeconds = previous?.durationSeconds ?? parseSongDurationSeconds(source);
  const mood = previous?.mood ?? (
    /\b(uplifting|freedom|change|hope|happy|sad|romantic|energetic|peaceful|dark|rebellious)\b/i.test(latest)
      ? latest.slice(0, 160) : undefined
  );
  const theme = previous?.theme ?? (
    /\b(?:about|for|on)\s+([^,.\n]+)/i.exec(source)?.[1]?.trim() ||
    (mood && /\b(freedom|change|love|hope|rebellion|confidence)\b/i.test(latest) ? latest.slice(0, 160) : undefined)
  );
  const instruments = previous?.instruments?.length ? previous.instruments : (
    /\b(rock|metal)\b/i.test(source) ? ["electric guitar", "bass", "live drums"] : undefined
  );
  const vocalArrangement = previous?.vocalArrangement ?? (
    /\b(duet|two voices|male and female)\b/i.test(latest) ? "duet" :
    /\b(solo male|male voice|male vocal)\b/i.test(latest) ? "solo male vocal" :
    /\b(solo female|female voice|female vocal)\b/i.test(latest) ? "solo female vocal" : undefined
  );
  const voiceStyle = previous?.voiceStyle ?? /\b(deep|gritty|raspy|soulful|bright|youthful|powerful|soft)\b/i.exec(latest)?.[1];
  const context: SongProductionContext = {
    theme, genre, mood, instruments, language, vocalArrangement, voiceStyle,
    durationSeconds, intendedUse: previous?.intendedUse,
  };
  const subject = theme || mood || "that direction";
  const reply = !vocalArrangement
    ? `That gives the song a ${subject} heart. Should the Hindi rock vocal be a solo male voice, solo female voice, or duet?`
    : !voiceStyle
      ? "Nice — the vocal shape is clear. Should the singer feel bright and youthful, soulful, gritty, or powerful?"
      : "I have the musical direction now. I’ll turn this into a focused song brief and draft the lyrics next.";
  return { reply, context };
}
