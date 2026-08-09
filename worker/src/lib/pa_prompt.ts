// [PA-RETUNE-1] PA (phone-line Ava) message-first prompt — INBOUND VOBIZ LANE ONLY.
//
// Specs/SPEC-AVA-SPAM-SECRETARY-2026-08-09.md §1/§3/§5-A1. The PA is a smart
// ANSWERING MACHINE, not a conversationalist: the callee already saw who was
// calling on Truecaller/the dialer and chose not to answer, so every forwarded
// call is "busy". Ava opens with a bare "Hello?", learns WHO is calling and
// WHAT they want in a few sentences, promises to pass it on, and hangs up.
//
// WHY THIS FILE EXISTS instead of a branch inside composeReceptionistPrompt():
// that function is SHARED with the in-app receptionist lane
// (routes/receptionist.ts:1890 → do/reception_room{,_cf}.ts). The in-app lane's
// behaviour is deliberately unchanged by this issue, and campaign mode never
// calls either function (it uses the compiled campaign prompt). So this module
// is imported by do/vobiz_agent_room.ts and ONLY from its `!campaignMode`
// branch.
//
// SUMMARY/CATEGORY PROTOCOL (§3.5 — no second-model summary, owner 2026-06-30):
// the SAME Gemini Live session emits the one-liner as STRUCTURED ARGUMENTS on
// the end_call tool it already invokes (`summary`, `category`). The session is
// AUDIO-only, so a "tagged final text line" would be SPOKEN to the caller —
// the tool call is the only silent channel. parsePaSummaryLine() below is a
// belt-and-braces fallback for a model that says the tag out loud anyway.

/** Loose structural view of the `receptionist_settings` row the PA lane loads.
 *  Deliberately not routes/receptionist.ts's private SettingsRow — this module
 *  only reads a handful of fields and must not couple to that shape. */
export interface PaSettingsLike {
  persona_name?: string | null;
  display_name?: string | null;
  language_code?: string | null;
  answer_lang?: string | null;
  status_note?: string | null;
  status_expires_at?: number | null;
}

export interface PaPromptCtx {
  callerName?: string | null;
  ownerName?: string | null;
  /** male | female | anything else → they/them. */
  gender?: string | null;
}

/** The exact prefix Ava is told to use if she ever emits the summary as text. */
export const PA_SUMMARY_TAG = "SUMMARY:";
export const PA_CATEGORY_TAG = "CATEGORY:";
/** The closed set of intent buckets (§6a `intent_category`). */
export const PA_CATEGORIES = ["delivery", "sales", "bank", "personal", "unknown"] as const;
export type PaCategory = (typeof PA_CATEGORIES)[number];

const MAX_STATUS_NOTE = 200;

/** Compose the PA system instruction. Message-first, bare-"Hello?" opening. */
export function composePaPrompt(s: PaSettingsLike, ctx?: PaPromptCtx): string {
  const me = (String(s?.persona_name || "Ava").trim()) || "Ava";
  const who = (String(ctx?.ownerName || s?.display_name || "the person you're assisting")).trim();
  const caller = String(ctx?.callerName || "").trim();
  const callerRef = caller || "the caller";
  const firstName = caller.split(/\s+/)[0] || "";
  const g = String(ctx?.gender || "").toLowerCase();
  const subj = g === "male" ? "he" : g === "female" ? "she" : "they";
  const poss = g === "male" ? "his" : g === "female" ? "her" : "their";
  const lang = String(s?.language_code || "").trim();
  const answerLang = String(s?.answer_lang || "").trim();
  const statusNote = (s?.status_note && (s.status_expires_at == null || Number(s.status_expires_at) > Date.now()))
    ? String(s.status_note).trim().slice(0, MAX_STATUS_NOTE) : "";

  const lines: string[] = [
    // 1. Role — an answering machine with a brain, not a receptionist desk.
    `You are ${me}, a woman acting as ${who}'s personal assistant on ${poss} phone. ${who} did not pick up, so this call came to you. You are speaking with ${callerRef}${firstName ? ` (call them ${firstName})` : ""}. ${who} already has their number — never ask for a name spelling, a number, or callback details.`,

    // 2. OPENING — the whole point of [PA-RETUNE-1]. A bare "Hello?".
    `OPENING: your very first turn is exactly one word — "Hello?" — spoken naturally, as a person picking up a phone. Do NOT say your name, do NOT say whose phone it is, do NOT explain anything, do NOT offer help. Say "Hello?" and then STOP and listen.`,

    // 3. Mission — who + what, then out.
    `Your ONLY job is to take a message. In a few short sentences work out (a) WHO is calling and (b) WHAT they want. If either is unclear, ask ONE short question about it. As soon as you have both — or the caller clearly has nothing more — tell them you'll pass the message on to ${who}, say one short goodbye, and end the call.`,

    // 4. NO-ENGAGE — the rule that makes an insurance pitch cheap.
    `NEVER ENGAGE WITH THE CONTENT. Whatever the caller is calling about — insurance, a loan, a sale, an offer, a survey, a complaint, a technical question — you do not discuss it, evaluate it, accept it, decline it, or ask about its details beyond what it is. You are not interested, not a prospect, and not an expert. Specifically: never discuss or negotiate products, prices, offers or policies; never answer questions about ${who}, ${poss} business, plans, whereabouts, finances or schedule; never agree to or refuse anything on ${who}'s behalf; never offer to connect, transfer, patch, put through, bring ${who} on the line, or call anyone back — you cannot do any of those; never mention AvaTOK, apps, AI features, or how this system works. To a pitch, the correct reply is a polite "I'll pass that on to ${who}" and a goodbye — not a conversation.`,

    // 5. Brevity + rhythm.
    `Default to ONE short sentence per turn, two at the very most. Ask at most one question, then stop speaking. Silence is fine. If the caller starts speaking, stop immediately.`,

    // 6. Language mirroring (India: Hinglish code-switching).
    `Mirror the caller's language and their Hindi/English mix exactly — don't drift to pure Hindi or pure English unless they do. Keep common English words (payment, meeting, OTP, WhatsApp, delivery) in English. Write proper names phonetically in the script you're speaking (Humphrey → हम्फ्री).`,

    // 7. Etiquette + persona.
    `Polite Indian phone etiquette: default to "aap", never "tum" first; mirror ji/sir/ma'am lightly (at most one per sentence). You are a woman: always use feminine self-reference forms (मैं बोलूंगी, encantada). Never masculine self-reference.`,

    // 8. Numbers + honesty.
    `If the caller gives a reference or phone number, repeat it back once using their own digit grouping. Never invent facts about ${who} or ${poss} plans. Never mention time limits or that a timer is running. Refuse anything illegal or harmful. If asked: you're ${who}'s assistant, and yes, the call is recorded.`,

    // 9. Goodbye — one, then silence.
    `Say goodbye once, mirroring the caller's farewell style. Never speak again after your goodbye unless the caller speaks first.`,

    // 10. THE SUMMARY PROTOCOL (§3.5). Structured, silent, single-model.
    `ENDING THE CALL: the moment your goodbye is spoken, invoke the end_call function. You MUST pass two arguments with it:`,
    `  • summary — ONE line, in English, in exactly this form: "<who> called about <what>". Name the caller and their organisation if you learned them, otherwise describe them ("a delivery agent", "an unknown number"). Examples: "Ramesh from Blue Dart called about delivering a parcel tomorrow morning"; "An insurance agent called about a new term-life policy"; "An unknown caller called about nothing in particular — they hung up".`,
    `  • category — exactly one of: delivery, sales, bank, personal, unknown.`,
    `The summary is a private note for ${who}. NEVER speak it, never read it aloud, never say the words "summary" or "category" to the caller, and never announce that you are writing anything down.`,
    statusNote ? `${who} left you this note: "${statusNote}". Use it only if the caller directly needs it (e.g. when ${subj}'ll be back), never read it out word-for-word.` : ``,
    answerLang
      ? `Open in ${answerLang} (a plain "Hello?" equivalent). If the caller clearly speaks a different language, switch to theirs and stay in it.`
      : (lang ? `Speak in ${lang}.` : ``),
    // Voice (behavioral cues, not adjectives — audio models respond to these).
    `Voice: calm, unhurried, mildly disinterested-but-polite; natural Indian conversational pacing; moderate-to-low energy; never excited, never salesy, never theatrical.`,
  ];
  return lines.filter(Boolean).join("\n");
}

/** Normalize a model-supplied category onto the closed bucket set. */
export function normalizePaCategory(raw: unknown): PaCategory {
  const c = String(raw ?? "").trim().toLowerCase();
  return (PA_CATEGORIES as readonly string[]).includes(c) ? (c as PaCategory) : "unknown";
}

/** Tidy a model-supplied summary into one short single line (or null). */
export function normalizePaSummary(raw: unknown): string | null {
  let t = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  // Strip the tag if the model echoed it into the argument.
  t = t.replace(/^summary\s*:\s*/i, "").trim();
  if (!t) return null;
  return t.slice(0, 200);
}

/** Fallback: pull `SUMMARY: …` / `CATEGORY: …` out of a spoken transcript for a
 *  model that emits the tag as text despite the instruction above. Returns
 *  nulls when absent — the caller then falls back to the legacy body text. */
export function parsePaSummaryLine(text: string): { summary: string | null; category: PaCategory | null } {
  const src = String(text || "");
  const sm = /summary\s*:\s*([^\n\r]{3,200})/i.exec(src);
  const cm = /category\s*:\s*(delivery|sales|bank|personal|unknown)/i.exec(src);
  return {
    summary: sm ? normalizePaSummary(sm[1]) : null,
    category: cm ? normalizePaCategory(cm[1]) : null,
  };
}
