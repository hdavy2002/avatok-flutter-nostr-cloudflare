// [HF-HOST-PLATFORM-1] Hello Fraands host options + pure validators. Worker-side mirror of web/src/lib/callvaalHomeReference.ts moods.
// Keep TOPICS in sync with that file (slug is the stored value).
export interface Topic { slug: string; label: string }
export const TOPICS: readonly Topic[] = [
  { slug: "roz-thodi-baat", label: "roz thodi baat" },
  { slug: "koi-jo-mujhe-jaane", label: "koi jo mujhe jaane" },
  { slug: "shaam-ka-saathi", label: "shaam ka saathi" },
  { slug: "ek-dost-jo-sune", label: "ek dost jo sune" },
  { slug: "apni-bhasha-mein-dost", label: "apni bhasha mein dost" },
  { slug: "kisi-topic-pe-baat", label: "kisi topic pe baat (cricket, films, books)" },
  { slug: "apni-bhasha-mein-baat", label: "apni bhasha mein baat (Garhwali, Kumaoni, Bhojpuri, Tamil…)" },
  { slug: "english-mein-casual-chat", label: "English mein casual chat" },
  { slug: "bas-baat-karni-hai", label: "bas baat karni hai" },
  { slug: "aaj-akela-lag-raha-hai", label: "aaj akela lag raha hai" },
  { slug: "din-kharab-tha", label: "din kharab tha" },
  { slug: "raat-ko-neend-nahi-aati", label: "raat ko neend nahi aati" },
  { slug: "shaam-ki-company", label: "shaam ki company" },
  { slug: "ghar-ki-yaad-aa-rahi-hai", label: "ghar ki yaad aa rahi hai" },
  { slug: "kisi-se-share-karna-hai", label: "kisi se share karna hai" },
  { slug: "bore-ho-raha-hoon", label: "bore ho raha hoon" },
  { slug: "raat-ki-shift-koi-jaga-hai", label: "raat ki shift, koi jaga hai?" },
  { slug: "subah-ki-chai-thodi-baat", label: "subah ki chai, thodi baat" },
  { slug: "mann-bhaari-hai", label: "mann bhaari hai" },
  { slug: "exam-ki-tension", label: "exam ki tension" },
  { slug: "interview-se-darr", label: "interview se darr" },
  { slug: "shaadi-ka-pressure", label: "shaadi ka pressure" },
  { slug: "ghar-waalon-se-jhagda", label: "ghar waalon se jhagda" },
  { slug: "naukri-ki-chinta", label: "naukri ki chinta" },
  { slug: "breakup", label: "breakup" },
  { slug: "shaadi-ki-baatein", label: "shaadi ki baatein" },
  { slug: "naya-sheher-nayi-job", label: "naya sheher, nayi job" },
  { slug: "paise-ki-tension", label: "paise ki tension" },
  { slug: "bachchon-ki-padhai", label: "bachchon ki padhai" },
  { slug: "maa-baap-ki-sehat", label: "maa-baap ki sehat" },
  { slug: "sehat-ki-chinta", label: "sehat ki chinta" },
];
export const TOPIC_SLUGS: ReadonlySet<string> = new Set(TOPICS.map((t) => t.slug));

export const LANGUAGES = ["Hindi", "English", "Marathi", "Bengali", "Tamil", "Telugu", "Kannada", "Malayalam", "Gujarati", "Punjabi", "Odia", "Bhojpuri", "Garhwali", "Kumaoni", "Urdu", "Assamese"] as const;
export const LANGUAGE_CODES: Readonly<Record<string, string>> = {
  hi: "Hindi", en: "English", mr: "Marathi", bn: "Bengali", ta: "Tamil", te: "Telugu", kn: "Kannada", ml: "Malayalam",
  gu: "Gujarati", pa: "Punjabi", or: "Odia", bho: "Bhojpuri", gbm: "Garhwali", kfy: "Kumaoni", ur: "Urdu", as: "Assamese",
};
/** language name -> conversationLang code */
export const LANGUAGE_TO_CODE: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(LANGUAGE_CODES).map(([c, n]) => [n, c]));
export const LANGUAGE_CODE_SET: ReadonlySet<string> = new Set(Object.keys(LANGUAGE_CODES));

export const STYLES = ["warm", "playful", "calm", "thoughtful", "energetic", "straightforward"] as const;
export const PRICE_MIN = 5;
export const PRICE_MAX = 100;

const APP_NAMES = "whats\\s*app|watsapp|wa\\.me|telegram|insta(?:gram)?|snap\\s*chat|signal|facebook|messenger|youtube|skype|imo|viber|wechat|hike|truecaller|paytm|gpay|google\\s*pay|phone\\s*pe|phonepe|upi|tinder|hangout";
const LEAK_RES: RegExp[] = [
  /@/,
  /https?:\/\//i,
  /\bwww\./i,
  /\b[a-z0-9-]+\.(?:com|in|co|net|org|me|io|ly|app|xyz|link|page)\b/i,
  /(?:\d[\s\-.()+]*){7,}/,
  new RegExp(`\\b(?:${APP_NAMES})\\b`, "i"),
  /\b(?:call|text|dm|ping|msg|message|contact)\s+(?:me|us)\s+(?:on|at|@)\b/i,
];
/** true when the text tries to move the conversation off-platform (phone numbers, @handles, links, app names). */
export function contactLeak(text: unknown): boolean {
  if (typeof text !== "string" || !text) return false;
  const t = text.normalize("NFKC");
  return LEAK_RES.some((re) => re.test(t));
}

/** Host-facing first-name slug base: ascii lowercase letters/digits, max 16; fallback "host". */
export function slugBase(displayName: string | null | undefined): string {
  const first = String(displayName ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().trim().split(/\s+/)[0] ?? "";
  const b = first.replace(/[^a-z0-9]/g, "").slice(0, 16);
  return b || "host";
}
const SLUG_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
export function randomSuffix(n = 4): string {
  const a = crypto.getRandomValues(new Uint8Array(n));
  let s = ""; for (const x of a) s += SLUG_CHARS[x % SLUG_CHARS.length];
  return s;
}
/** `<first-name-lowercase>-<4 random a-z0-9>` */
export function makeSlug(displayName: string | null | undefined): string { return `${slugBase(displayName)}-${randomSuffix(4)}`; }
export const SLUG_RE = /^[a-z0-9]{1,16}-[a-z0-9]{4}$/;
