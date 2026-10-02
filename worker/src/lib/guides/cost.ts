// [AUMFE-PANDIT-COST-1 2026-10-02] Pandit ji cost control — the pure rules: history window + rolling summary, topic cut-off,
// IST-day message cap, fact-extraction cadence, retry on a starved answer, and the customer-facing wording. No I/O here.

export interface PanditLimits { historyMessages: number; topicMaxTurns: number; dailyMaxMessages: number }
export const DEFAULT_LIMITS: PanditLimits = { historyMessages: 8, topicMaxTurns: 20, dailyMaxMessages: 40 };

const clampInt = (v: unknown, def: number, lo: number, hi: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : def;

/** PlatformConfig (or a partial of it) -> sane limits. A bad or missing flag falls back to the default, never to 0. */
export function limitsFromConfig(cfg: { panditHistoryMessages?: unknown; panditTopicMaxTurns?: unknown; panditDailyMaxMessages?: unknown } | null | undefined): PanditLimits {
  return {
    historyMessages: clampInt(cfg?.panditHistoryMessages, DEFAULT_LIMITS.historyMessages, 2, 40),
    topicMaxTurns: clampInt(cfg?.panditTopicMaxTurns, DEFAULT_LIMITS.topicMaxTurns, 4, 200),
    dailyMaxMessages: clampInt(cfg?.panditDailyMaxMessages, DEFAULT_LIMITS.dailyMaxMessages, 1, 1000),
  };
}

/** Main-call output budget (thinking tokens count against it on Gemini 3) and the one retry when that starves the answer. */
export const MAIN_MAX_TOKENS = 450;
export const RETRY_MAX_TOKENS = 1400;

export const SUMMARY_PREFIX = "[summary] ";
/** Verbatim window is keep..keep+SLACK (8..16). The rolling summary runs when keep+SLACK (16) messages have piled up since the
 *  last one, folding all but the newest `keep` into it: about one summary call every 4 turns. */
export const SUMMARY_SLACK = 8;
export const FACTS_EVERY = 4;

// ---------------------------------------------------------------------------
// History window + rolling summary
// ---------------------------------------------------------------------------
export interface CtxRow { id: number; role: string; text: string; tool_summary?: string | null }
export interface WindowMsg { role: "user" | "assistant"; text: string; id: number }
export interface PromptContext {
  /** Latest summary text without the prefix, or null. */
  summary: string | null;
  /** Messages the summary already covers end at this ai_messages.id (0 when none). */
  coveredThroughId: number;
  /** What is sent verbatim, oldest first, starting with a customer message. */
  window: WindowMsg[];
  /** Unsummarised messages (everything after the covered id), oldest first. */
  pending: WindowMsg[];
  /** Set when the rolling summary must run: fold these (all pending except the last `keep`) into the summary. */
  due: { rows: WindowMsg[]; coversThroughId: number } | null;
}

export const isSummaryRow = (r: { role: string; text: string }): boolean => r.role === "system" && r.text.startsWith(SUMMARY_PREFIX);

/** `rows` oldest first (customer 'visitor', assistant 'preeti', summary 'system'; tool rows may be present and are ignored). Pure. */
export function selectContext(rows: CtxRow[], keep: number): PromptContext {
  let summary: string | null = null, covered = 0;
  for (const r of rows) {
    if (isSummaryRow(r)) { summary = r.text.slice(SUMMARY_PREFIX.length).trim(); covered = Number(r.tool_summary) || 0; }
  }
  const pending: WindowMsg[] = [];
  for (const r of rows) {
    if (r.id <= covered) continue;
    if (r.role === "visitor" && r.text) pending.push({ role: "user", text: r.text, id: r.id });
    else if (r.role === "preeti" && r.text) pending.push({ role: "assistant", text: r.text, id: r.id });
  }
  const window = pending.slice(-(keep + SUMMARY_SLACK)); // <= 16
  while (window.length && window[0].role === "assistant") window.shift(); // Gemini wants the conversation to open with the customer
  let due: PromptContext["due"] = null;
  if (pending.length >= keep + SUMMARY_SLACK) {
    const rowsToFold = pending.slice(0, pending.length - keep);
    due = { rows: rowsToFold, coversThroughId: rowsToFold[rowsToFold.length - 1].id };
  }
  return { summary, coveredThroughId: covered, window, pending, due };
}

// ---------------------------------------------------------------------------
// Caps and cadence
// ---------------------------------------------------------------------------
const IST_MS = 5.5 * 3600_000;
const DAY_MS = 86_400_000;
/** UTC ms of 00:00 IST for the IST day containing `nowMs`. */
export function istDayStartMs(nowMs: number): number { return Math.floor((nowMs + IST_MS) / DAY_MS) * DAY_MS - IST_MS; }
export const dailyLimitReached = (countToday: number, cap: number): boolean => countToday >= cap;
export const shouldCloseTopic = (customerTurns: number, maxTurns: number): boolean => customerTurns >= maxTurns;
/** Per-turn fact extraction only on every 4th customer message (and at topic close, handled separately). */
export const shouldExtractFacts = (customerTurns: number): boolean => customerTurns > 0 && customerTurns % FACTS_EVERY === 0;

// ---------------------------------------------------------------------------
// Starved-answer retry (Gemini 3 thinking tokens share the output budget)
// ---------------------------------------------------------------------------
interface StepLike { parts: { text?: string; thought?: boolean; functionCall?: unknown }[]; finishReason?: string }

export function hasAnswer(s: StepLike): boolean {
  return s.parts.some((p) => p.functionCall || (typeof p.text === "string" && p.text.trim() && !p.thought));
}

/** Call once at the small budget; when that returns nothing visible because of MAX_TOKENS, call once more with the big one. */
export async function stepWithRetry<T extends StepLike>(call: (maxTokens: number) => Promise<T>): Promise<{ step: T; first: T | null }> {
  const a = await call(MAIN_MAX_TOKENS);
  if (a.finishReason === "MAX_TOKENS" && !hasAnswer(a)) return { step: await call(RETRY_MAX_TOKENS), first: a };
  return { step: a, first: null };
}

// ---------------------------------------------------------------------------
// Customer-facing wording, in the chat's language (keys = personas.CHAT_LANGS). Unknown language -> Hinglish.
// ---------------------------------------------------------------------------
const DAILY: Record<string, string> = {
  en: "We have talked a lot today, and Pandit ji needs to rest. Please come back tomorrow; he will be glad to continue.",
  hi: "आज हमने काफ़ी बातें कर लीं और पंडित जी को अब विश्राम करना है। कल फिर आइए, वे ख़ुशी से आपकी बात सुनेंगे।",
  hinglish: "Aaj humne kaafi baatein kar li hain aur Pandit ji ko ab vishram karna hai. Kal phir aaiye, woh khushi se aapki baat sunenge.",
  ta: "இன்று நிறைய பேசிவிட்டோம், பண்டிட் ஜி ஓய்வெடுக்க வேண்டும். நாளை மீண்டும் வாருங்கள், மகிழ்ச்சியுடன் தொடர்வார்.",
  te: "ఈ రోజు చాలా మాట్లాడుకున్నాం, పండిట్ జీ విశ్రాంతి తీసుకోవాలి. రేపు మళ్లీ రండి, సంతోషంగా కొనసాగిస్తారు.",
  bn: "আজ আমরা অনেক কথা বলেছি, পণ্ডিত জির এখন বিশ্রাম দরকার। কাল আবার আসুন, তিনি খুশি মনে কথা বলবেন।",
  mr: "आज आपण खूप बोललो, पंडित जींना आता विश्रांती हवी आहे. उद्या पुन्हा या, ते आनंदाने बोलतील.",
  gu: "આજે આપણે ઘણી વાતો કરી, પંડિત જીને હવે આરામ કરવો છે. કાલે ફરી આવજો, તેઓ ખુશીથી વાત કરશે.",
  kn: "ಇಂದು ತುಂಬಾ ಮಾತನಾಡಿದ್ದೇವೆ, ಪಂಡಿತ್ ಜಿಗೆ ವಿಶ್ರಾಂತಿ ಬೇಕು. ನಾಳೆ ಮತ್ತೆ ಬನ್ನಿ, ಅವರು ಸಂತೋಷದಿಂದ ಮುಂದುವರಿಸುತ್ತಾರೆ.",
};
const CLOSED_SAVED: Record<string, string> = {
  en: "Let's start fresh — I'll remember what we discussed.",
  hi: "चलिए नए सिरे से शुरू करते हैं — हमने जो बातें कीं, वे मुझे याद रहेंगी।",
  hinglish: "Chaliye naye sire se shuru karte hain — humne jo baatein ki, woh mujhe yaad rahengi.",
  ta: "புதிதாகத் தொடங்குவோம் — நாம் பேசியவை எனக்கு நினைவில் இருக்கும்.",
  te: "కొత్తగా మొదలుపెడదాం — మనం మాట్లాడుకున్నవి నాకు గుర్తుంటాయి.",
  bn: "চলুন নতুন করে শুরু করি — আমরা যা আলোচনা করেছি তা আমার মনে থাকবে।",
  mr: "चला नव्याने सुरुवात करूया — आपण जे बोललो ते माझ्या लक्षात राहील.",
  gu: "ચાલો નવેસરથી શરૂ કરીએ — આપણે જે વાત કરી તે મને યાદ રહેશે.",
  kn: "ಹೊಸದಾಗಿ ಆರಂಭಿಸೋಣ — ನಾವು ಮಾತನಾಡಿದ್ದು ನನಗೆ ನೆನಪಿರುತ್ತದೆ.",
};
// Used when memory is off for this customer: promising to remember would be untrue.
const CLOSED_PLAIN: Record<string, string> = {
  en: "Let's start a fresh topic.",
  hi: "चलिए एक नया विषय शुरू करते हैं।",
  hinglish: "Chaliye ek naya vishay shuru karte hain.",
  ta: "புதிய தலைப்பைத் தொடங்குவோம்.",
  te: "కొత్త అంశాన్ని మొదలుపెడదాం.",
  bn: "চলুন একটি নতুন বিষয় শুরু করি।",
  mr: "चला एक नवा विषय सुरू करूया.",
  gu: "ચાલો એક નવો વિષય શરૂ કરીએ.",
  kn: "ಹೊಸ ವಿಷಯವನ್ನು ಆರಂಭಿಸೋಣ.",
};
export const dailyLimitMessage = (lang: string | null | undefined): string => DAILY[lang ?? ""] ?? DAILY.hinglish;
export const topicClosedMessage = (lang: string | null | undefined, remembered: boolean): string => (remembered ? CLOSED_SAVED : CLOSED_PLAIN)[lang ?? ""] ?? (remembered ? CLOSED_SAVED : CLOSED_PLAIN).hinglish;
