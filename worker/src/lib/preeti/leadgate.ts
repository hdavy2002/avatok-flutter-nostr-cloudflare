// [SAATHUM-PREETI-LEADGATE-1 2026-09-30] Lead gate texts + helpers (spec: Specs/SPEC-2026-09-30-PREETI-LEADGATE.md).
// An anonymous visitor without email + WhatsApp gets a FIXED reply (no Gemini call, no spend).

export const IDENTITY_ASK_EN =
  "Before we go further, could you share your email and WhatsApp number? I need these to forward our chat to you. I promise I won't spam you 🙏 And next time you come, I'll be able to remember you.";
export const IDENTITY_ASK_HI =
  "Aage badhne se pehle, kya aap apna email aur WhatsApp number share karenge? Main hamari baatcheet aapko forward kar dungi. Promise, koi spam nahi 🙏 Aur agli baar aap aayenge to main aapko yaad rakhungi.";

/** Marker stored in ai_messages.model on the fixed ask reply, so it is never fed to the model or counted as an answer. */
export const IDENTITY_ASK_MODEL = "identity_ask";

const HINGLISH_WORDS =
  /\b(hai|hain|kya|kaise|kaisa|kab|kahan|kahaan|kyun|kyu|mujhe|mera|meri|mere|aap|aapka|aapki|hum|hume|nahi|nahin|kitna|kitne|kitni|chahiye|karna|karni|karein|karo|batao|bataiye|bataye|bhai|haan|thoda|kripya|namaste|pranam|dhanyavad|shukriya|puja ka|kaun|kaunsa|wala|wali|mein|par)\b/i;

/** Simple heuristic: Devanagari or common Hinglish words -> Hinglish variant. */
export function looksHinglish(text: string): boolean {
  return /[ऀ-ॿ]/.test(text) || HINGLISH_WORDS.test(text);
}

export function identityAskText(visitorText: string): string {
  return looksHinglish(visitorText) ? IDENTITY_ASK_HI : IDENTITY_ASK_EN;
}

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[A-Za-z]{2,}$/;
export function normalizeEmail(raw: unknown): string | null {
  const e = String(raw ?? "").trim().toLowerCase();
  if (!e || e.length > 254 || !EMAIL_RE.test(e)) return null;
  return e;
}
