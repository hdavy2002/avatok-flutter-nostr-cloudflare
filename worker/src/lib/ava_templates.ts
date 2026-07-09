// ava_templates.ts — Phase C. Reply Template Bank v1 (plan D18/D23, Constitution 7/14).
//
// The CHEAPEST reply path: intent (capability) × lang (en/hi/hinglish) ×
// register (casual/formal). Templates serve BEFORE any cache and long before
// the reasoner — most Moments should never touch AI at all. {slot} placeholders
// are filled deterministically by fillTemplate(). ZERO AI in this module.
//
// Personality (Constitution 14): warm, brief, mirrors the user's register,
// never "As an AI…". One voice across every role — add templates here, never
// inline strings in feature code.
//
// v1 ships ≥2 templates per capability per language (one casual, one formal).

export type TemplateLang = "en" | "hi" | "hinglish";
export type TemplateRegister = "casual" | "formal";

export interface ReplyTemplate {
  register: TemplateRegister;
  text: string; // may contain {slot} placeholders
}

type LangBank = Record<TemplateLang, ReplyTemplate[]>;

export const TEMPLATE_BANK_VERSION = 1;

// capability id → lang → templates. Keys match ava_capabilities CAPABILITY_SEED.
export const TEMPLATE_BANK: Record<string, LangBank> = {
  meeting: {
    en: [
      { register: "casual", text: "Looks like you're planning to meet {when}. Want me to set a reminder?" },
      { register: "formal", text: "I noticed a meeting {when}. Shall I add a reminder so it isn't missed?" },
    ],
    hi: [
      { register: "casual", text: "लगता है {when} मिलने का प्लान है। रिमाइंडर लगा दूँ?" },
      { register: "formal", text: "{when} की मीटिंग दिख रही है। क्या मैं इसका रिमाइंडर सेट कर दूँ?" },
    ],
    hinglish: [
      { register: "casual", text: "{when} milne ka plan lag raha hai — reminder laga doon?" },
      { register: "formal", text: "{when} ki meeting notice hui. Chahein to main reminder set kar deti hoon." },
    ],
  },
  expense_split: {
    en: [
      { register: "casual", text: "Want me to split {amount} for you? I can do the math." },
      { register: "formal", text: "I can split {amount} between {count} people if you'd like — just say the word." },
    ],
    hi: [
      { register: "casual", text: "{amount} बाँटना है? हिसाब मैं कर दूँ?" },
      { register: "formal", text: "चाहें तो {amount} को {count} लोगों में बाँटकर हिसाब मैं निकाल दूँ।" },
    ],
    hinglish: [
      { register: "casual", text: "{amount} ka hisaab karna hai? Main split kar doon?" },
      { register: "formal", text: "Chahein to {amount} ko {count} logon mein split karke hisaab main nikal deti hoon." },
    ],
  },
  birthday: {
    en: [
      { register: "casual", text: "Sounds like {name}'s birthday {when}! Want a reminder or gift ideas?" },
      { register: "formal", text: "It appears {name} has a birthday {when}. Shall I set a reminder for you?" },
    ],
    hi: [
      { register: "casual", text: "{when} {name} का जन्मदिन लग रहा है! रिमाइंडर लगाऊँ?" },
      { register: "formal", text: "{when} {name} का जन्मदिन प्रतीत होता है। क्या मैं रिमाइंडर सेट कर दूँ?" },
    ],
    hinglish: [
      { register: "casual", text: "{when} {name} ka birthday hai kya? Reminder laga doon?" },
      { register: "formal", text: "Lagta hai {when} {name} ka janamdin hai. Chahein to reminder set kar deti hoon." },
    ],
  },
  otp_guard: {
    en: [
      { register: "casual", text: "Heads up — never share an OTP or code with anyone, even someone you know. (Only you can see this.)" },
      { register: "formal", text: "A verification code was mentioned here. Please never share OTPs — no genuine service will ask for one. (Only you can see this.)" },
    ],
    hi: [
      { register: "casual", text: "ध्यान दें — OTP या कोड किसी के साथ शेयर न करें, चाहे कोई भी माँगे। (यह सिर्फ़ आपको दिख रहा है।)" },
      { register: "formal", text: "यहाँ एक वेरिफ़िकेशन कोड का ज़िक्र हुआ है। कृपया OTP कभी साझा न करें — कोई भी असली सेवा इसे नहीं माँगती। (यह केवल आपको दिख रहा है।)" },
    ],
    hinglish: [
      { register: "casual", text: "Dhyan dein — OTP ya code kisi ke saath share mat karo, koi bhi maange. (Sirf aapko dikh raha hai.)" },
      { register: "formal", text: "Yahaan ek verification code ka zikr hua hai. OTP kabhi share na karein — koi genuine service ise nahi maangti. (Sirf aap dekh sakte hain.)" },
    ],
  },
  order_tracking: {
    en: [
      { register: "casual", text: "Got an order on the way? I can remind you when {when} comes around." },
      { register: "formal", text: "I noticed an order update. Would you like me to track it and remind you {when}?" },
    ],
    hi: [
      { register: "casual", text: "कोई ऑर्डर आ रहा है? {when} याद दिला दूँ?" },
      { register: "formal", text: "एक ऑर्डर अपडेट दिखा। क्या मैं {when} आपको याद दिला दूँ?" },
    ],
    hinglish: [
      { register: "casual", text: "Order aa raha hai kya? {when} yaad dila doon?" },
      { register: "formal", text: "Ek order update dikha. Chahein to {when} main aapko yaad dila deti hoon." },
    ],
  },
  travel_plan: {
    en: [
      { register: "casual", text: "Trip coming up {when}? I can save the details and remind you before you leave." },
      { register: "formal", text: "I noticed travel plans {when}. Shall I keep the details handy and remind you beforehand?" },
    ],
    hi: [
      { register: "casual", text: "{when} की यात्रा है? डिटेल्स सेव करके पहले याद दिला दूँ?" },
      { register: "formal", text: "{when} की यात्रा की जानकारी दिखी। क्या मैं विवरण सहेजकर समय से पहले याद दिला दूँ?" },
    ],
    hinglish: [
      { register: "casual", text: "{when} trip hai? Details save karke pehle yaad dila doon?" },
      { register: "formal", text: "{when} ke travel plans dikhe. Chahein to details save karke pehle se yaad dila deti hoon." },
    ],
  },
  celebration: {
    en: [
      { register: "casual", text: "Happy {occasion}! Want a nice greeting to send back?" },
      { register: "formal", text: "Wishing you a joyful {occasion}. Would you like help composing a reply?" },
    ],
    hi: [
      { register: "casual", text: "{occasion} की शुभकामनाएँ! जवाब में भेजने के लिए कोई अच्छा संदेश चाहिए?" },
      { register: "formal", text: "{occasion} की हार्दिक शुभकामनाएँ। क्या मैं उत्तर लिखने में सहायता करूँ?" },
    ],
    hinglish: [
      { register: "casual", text: "{occasion} mubarak! Reply ke liye ek accha message chahiye?" },
      { register: "formal", text: "Aapko {occasion} ki shubhkamnayein. Chahein to main reply likhne mein madad kar deti hoon." },
    ],
  },
  reminder: {
    en: [
      { register: "casual", text: "Want me to remember this for you? I can remind you {when}." },
      { register: "formal", text: "This looks worth remembering. Shall I set a reminder for {when}?" },
    ],
    hi: [
      { register: "casual", text: "यह याद रखूँ? {when} याद दिला सकती हूँ।" },
      { register: "formal", text: "यह याद रखने योग्य लगता है। क्या मैं {when} के लिए रिमाइंडर सेट कर दूँ?" },
    ],
    hinglish: [
      { register: "casual", text: "Ye yaad rakhoon? {when} yaad dila sakti hoon." },
      { register: "formal", text: "Ye yaad rakhne layak lagta hai. Chahein to {when} ka reminder set kar deti hoon." },
    ],
  },
};

/** Does the bank have ANY template for this capability + language? */
export function hasTemplate(capability: string, lang: TemplateLang): boolean {
  const bank = TEMPLATE_BANK[capability];
  return !!(bank && bank[lang] && bank[lang].length);
}

/**
 * Pick a template for capability × lang × register. Falls back: requested
 * register → any register in lang → English. Returns null if the capability
 * has no templates at all.
 */
export function pickTemplate(
  capability: string,
  lang: TemplateLang,
  register: TemplateRegister = "casual",
): ReplyTemplate | null {
  const bank = TEMPLATE_BANK[capability];
  if (!bank) return null;
  const inLang = bank[lang] ?? [];
  return inLang.find((t) => t.register === register)
    ?? inLang[0]
    ?? (bank.en ?? []).find((t) => t.register === register)
    ?? (bank.en ?? [])[0]
    ?? null;
}

/** Fill {slot} placeholders. Missing slots are removed (never leak braces). */
export function fillTemplate(text: string, slots: Record<string, string | number | null | undefined> = {}): string {
  return String(text ?? "")
    .replace(/\{(\w+)\}/g, (_, k: string) => {
      const v = slots[k];
      return v === null || v === undefined ? "" : String(v);
    })
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Roman-script Hindi markers for the Hinglish guess. Deliberately common words.
const HINGLISH_WORDS = /\b(hai|hain|nahi|nahin|kya|kyu|kyun|acha|accha|theek|thik|bhai|yaar|kal|aaj|abhi|karna|karo|hoga|hogi|milte|milna|batao|bata|chahiye|paisa|paise|shukriya|dhanyawad|matlab|bahut|thoda|jaldi|dekho|suno|arre|haan|ji\b)\b/i;

/**
 * guessLang — cheap deterministic language guess for template selection and
 * shadow telemetry. Devanagari → hi; roman-Hindi markers → hinglish; else en.
 */
export function guessLang(text: string): TemplateLang {
  const t = String(text ?? "");
  if (/[ऀ-ॿ]/.test(t)) return "hi"; // Devanagari block
  if (HINGLISH_WORDS.test(t)) return "hinglish";
  return "en";
}
