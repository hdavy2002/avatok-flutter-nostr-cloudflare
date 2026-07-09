// ava_triggers.ts — Phase C (ODL). THE one trigger/regex bank (plan D23/D31).
//
// A versioned, categorized pattern list shared by every Ava role: the ODL wake
// scan, the (future) on-device matcher, and any consumer that needs "does this
// message look like a Moment candidate?". Pure data + one pure function — ZERO
// AI, zero network, zero state. Deterministic and cheap enough to run on every
// message.
//
// SERIALIZABLE (D31): the bank is plain data ({id, category, re, flags}) with
// regex SOURCES as strings, so `GET /api/ava/triggers` can ship it verbatim to
// the device for offline matching. The device hint is an optimization only —
// the server-side ODL re-runs matchTriggers() as the authority before spending
// anything. Bump TRIGGER_BANK_VERSION on ANY change to the list (the route's
// ETag and the device sync key off it).
//
// Categories map 1:1 onto the v1 capabilities (see ava_capabilities.ts
// CATEGORY_TO_CAPABILITY). Order in the bank = priority order: the FIRST match
// decides the primary category (otp/safety first, ambient markers last).

export const TRIGGER_BANK_VERSION = 1;

export type TriggerCategory =
  | "otp"            // one-time passwords / verification codes
  | "money"          // ₹ / UPI / $ / owe / paid / split
  | "date_meeting"   // dates + meeting verbs
  | "birthday"       // birthday / anniversary terms
  | "festival"       // festival greetings incl. major Indian festivals
  | "life_event"     // engagement, wedding, new job, baby, bereavement…
  | "commerce"       // order / shipped / delivery / refund
  | "travel"         // flight / train / PNR / hotel / trip
  | "contact_marker"; // phone / address / link / attachment markers

/** One bank entry. `re` is the regex SOURCE (string, serializable); `flags`
 *  are the regex flags. Compiled lazily once per isolate. */
export interface TriggerDef {
  id: string;
  category: TriggerCategory;
  re: string;
  flags: string;
}

export interface TriggerMatch {
  category: TriggerCategory;
  pattern: string; // the matched TriggerDef.id
}

// ─────────────────────────────────────────────────────────────────────────────
// THE BANK (v1). Keep entries small and single-purpose; add entries rather than
// growing one mega-regex. Every entry costs one .test() per message — cheap.
// ─────────────────────────────────────────────────────────────────────────────
export const TRIGGER_BANK: TriggerDef[] = [
  // otp — highest priority (feeds otp_guard).
  { id: "otp.keyword", category: "otp", re: "\\b(otp|one[- ]?time (password|pin|code)|verification code|auth code|2fa)\\b", flags: "i" },
  { id: "otp.code_is", category: "otp", re: "\\b\\d{4,8}\\b[^\\n]{0,40}\\b(is your|is the|otp|code)\\b|\\b(code|otp)\\b[^\\n]{0,20}\\b\\d{4,8}\\b", flags: "i" },
  { id: "otp.share_ask", category: "otp", re: "\\b(share|send|batao|bata do|tell me)\\b[^\\n]{0,30}\\b(otp|code|pin)\\b", flags: "i" },

  // money — ₹ / UPI / $ / owe / paid / split (feeds expense_split).
  { id: "money.inr", category: "money", re: "₹\\s?\\d|\\b(rs\\.?|inr|rupees?|rupaye)\\s?\\d", flags: "i" },
  { id: "money.usd", category: "money", re: "\\$\\s?\\d|\\b(usd|dollars?)\\s?\\d", flags: "i" },
  { id: "money.upi", category: "money", re: "\\b(upi|gpay|google pay|phonepe|paytm|bhim)\\b|\\b[\\w.-]{2,}@(ok(sbi|hdfc|icici|axis)|ybl|paytm|upi|apl|ibl|axl)\\b", flags: "i" },
  { id: "money.owe", category: "money", re: "\\b(owes?|owed|owe me|you owe|i owe|udhaar|udhar|paisa (de|do|bhej)|paise (de|do|bhej))\\b", flags: "i" },
  { id: "money.paid_split", category: "money", re: "\\b(paid|pay me|payment|repay|settle (up|karo)?|split(ting)? (the )?(bill|cost|it)|my share|tera hissa|hisaab)\\b", flags: "i" },

  // date_meeting — meeting verbs + date/time shapes (feeds meeting).
  { id: "meet.verb", category: "date_meeting", re: "\\b(let'?s meet|meet(ing)? (up|at|on|tomorrow|today)?|catch ?up|schedule|reschedule|appointment|call (you|me) at|sync (up|at)|milte hain|milna hai|milega|milegi)\\b", flags: "i" },
  { id: "meet.time", category: "date_meeting", re: "\\b\\d{1,2}([:.]\\d{2})?\\s?(am|pm|baje)\\b", flags: "i" },
  { id: "meet.day", category: "date_meeting", re: "\\b(today|tomorrow|tonight|day after|this (week(end)?|evening)|next (week|month)|mon(day)?|tues?(day)?|wed(nesday)?|thur?s?(day)?|fri(day)?|sat(urday)?|sun(day)?|aaj|kal|parso|shaam ko|subah)\\b", flags: "i" },
  { id: "meet.date", category: "date_meeting", re: "\\b\\d{1,2}[/-]\\d{1,2}([/-]\\d{2,4})?\\b|\\b\\d{1,2}(st|nd|rd|th)?\\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\b", flags: "i" },

  // birthday / anniversary (feeds birthday).
  { id: "bday.terms", category: "birthday", re: "\\b(happy birthday|birthday|b'?day|hbd|janamdin|janmdin|saalgirah|salgirah|happy anniversary|anniversary)\\b", flags: "i" },

  // festival — major Indian festivals + global (feeds celebration).
  { id: "fest.indian", category: "festival", re: "\\b(diwali|deepavali|deepawali|holi|eid|ramadan|ramzan|navratri|dussehra|dasara|durga puja|raksha ?bandhan|rakhi|ganesh chaturthi|ganpati|pongal|onam|lohri|makar sankranti|baisakhi|vaisakhi|janmashtami|karwa chauth|chhath|maha shivratri|ugadi|gudi padwa|bihu|guru purab|gurpurab)\\b", flags: "i" },
  { id: "fest.global", category: "festival", re: "\\b(christmas|xmas|new year|easter|good friday|hanukkah|thanksgiving|halloween)\\b", flags: "i" },
  { id: "fest.greeting", category: "festival", re: "\\b(shubh|mubarak|happy (pongal|onam|holi|diwali)|wishing you)\\b", flags: "i" },

  // life events (feeds reminder in v1).
  { id: "life.event", category: "life_event", re: "\\b(engaged|engagement|wedding|shaadi|shadi|got married|new job|job (offer|mil gay[ia])|promotion|promoted|graduat(ed|ion)|pregnant|baby (boy|girl)|newborn|new (house|flat|home)|griha ?pravesh|housewarming|retire(d|ment)|passed away|condolences|rip\\b|farewell)\\b", flags: "i" },

  // commerce — order / shipped (feeds order_tracking).
  { id: "comm.order", category: "commerce", re: "\\b(order(ed)?|your order|out for delivery|shipped|dispatch(ed)?|delivered|delivery (boy|partner|by)|tracking (no|number|id|link)|awb|courier|refund(ed)?|return (pickup|initiated)|invoice|cash on delivery|cod)\\b", flags: "i" },

  // travel — flight / train (feeds travel_plan).
  { id: "trav.terms", category: "travel", re: "\\b(flight|pnr|boarding (pass|gate)|airport|terminal \\d|train (no|number)?|irctc|platform \\d|ticket(s)? (booked|confirmed)|hotel (booked|booking)|check[- ]?in|itinerary|visa|layover|departure|arrival|trip to|yatra|safar)\\b", flags: "i" },

  // contact / address / link / attachment markers — ambient, lowest priority.
  { id: "mark.phone", category: "contact_marker", re: "(\\+?\\d[\\d\\s-]{8,}\\d)", flags: "" },
  { id: "mark.address", category: "contact_marker", re: "\\b(address|apartment|apt\\.?|flat no|house no|sector \\d|block [a-z0-9]|pin ?code|zip ?code|landmark|near (the )?(metro|station|mall))\\b", flags: "i" },
  { id: "mark.link", category: "contact_marker", re: "https?://\\S+", flags: "i" },
  { id: "mark.attach", category: "contact_marker", re: "\\b(attach(ed|ment)|see the file|sending (the )?(file|doc|pdf)|\\.pdf\\b|\\.docx?\\b|\\.xlsx?\\b)", flags: "i" },
];

// Lazily-compiled bank (compile once per isolate; a bad pattern is skipped —
// the bank must never throw at match time).
let _compiled: Array<{ def: TriggerDef; rx: RegExp }> | null = null;
function compiled(): Array<{ def: TriggerDef; rx: RegExp }> {
  if (_compiled) return _compiled;
  const out: Array<{ def: TriggerDef; rx: RegExp }> = [];
  for (const def of TRIGGER_BANK) {
    try { out.push({ def, rx: new RegExp(def.re, def.flags) }); } catch { /* skip bad pattern */ }
  }
  _compiled = out;
  return out;
}

/**
 * matchTriggers — the ONE pure matcher. Runs every bank pattern against `text`
 * and returns the matches in bank (priority) order. NO AI, no state, never
 * throws. Empty array = no wake candidate (~80–90% of messages).
 */
export function matchTriggers(text: string): TriggerMatch[] {
  const t = String(text ?? "");
  if (!t.trim()) return [];
  const out: TriggerMatch[] = [];
  for (const { def, rx } of compiled()) {
    try { if (rx.test(t)) out.push({ category: def.category, pattern: def.id }); } catch { /* never throw */ }
  }
  return out;
}

/** Distinct categories from a match list, in first-hit (priority) order. */
export function matchedCategories(matches: TriggerMatch[]): TriggerCategory[] {
  const seen = new Set<TriggerCategory>();
  const out: TriggerCategory[] = [];
  for (const m of matches) if (!seen.has(m.category)) { seen.add(m.category); out.push(m.category); }
  return out;
}
