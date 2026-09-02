/*
 * copy.ts — [LIST-TRUST-1 / VIBE] the ONE copy dictionary for cards, pills,
 * chips, CTAs, empty states and badges (Specs/SPEC-2026-09-02-LISTING-TRUST-
 * AND-VIBE.md §5). Hinglish in Latin script. Every string here is voice, not
 * data — the fact it decorates must already be true before this file is asked
 * to say anything about it (rule zero, §1: every badge is earned from data).
 *
 * Rules from the spec, enforced by convention here (nothing to lint yet):
 *   - Slang is garnish, not the sentence. The number/fact always reads plain
 *     even inside the flavoured string (`8 SEATS BAAKI`, not just `BAAKI`).
 *   - CTA verbs stay English; flavour goes in the micro-copy under them.
 *   - Numbers, money and time are always plain (₹149, FRI 9 PM IST).
 *   - No negative letter-spacing anywhere these strings render — see CLAUDE.md
 *     "Type rules" — that is a caller-side style concern, not this file's, but
 *     it is why every string here is short enough to set in Nunito 700–900
 *     with normal-to-wide tracking and not run out of room.
 *
 * This file is plain data + functions — no JSX, no framework imports, safe to
 * import from both Astro components and React islands.
 */

/** Static status-pill labels. Dynamic pills (e.g. a live time) are composed by
 *  the caller (see ListingTile.tsx `statusLabel`) — this only covers the
 *  fixed vocabulary §2 reuses across every listing type. */
export const statusPill = {
  LIVE: 'LIVE',
  /** "SOLD OUT" in the site's voice — §5 badge list, trucker-plate energy. */
  SOLD_OUT: 'FULL HO GAYA',
  FREE: 'FREE',
  ALWAYS_ON: 'ALWAYS ON',
  ON_REQUEST: 'ON REQUEST',
  NEW: 'NEW',
} as const;

/** Proof-chip copy — the fact stays plain, the flavour rides on it (§5). */
export const chips = {
  /** `8 SEATS BAAKI` — seats remaining, urgency without inventing scarcity. */
  seatsLeft: (n: number): string => `${n} SEATS BAAKI`,
  /** `300 REGULARS` — followers, the come-back signal from §1 row 2. */
  regulars: (n: number): string => `${n.toLocaleString('en-IN')} REGULARS`,
  /** `★ 4.9 · 620` — rating + count, only ever printed when both are real
   *  (§4.6: a raw review count under 3 must show NEW instead, not this). */
  rating: (avg: number, count: number): string =>
    count > 0 ? `★ ${avg.toFixed(1)} · ${count.toLocaleString('en-IN')}` : `★ ${avg.toFixed(1)}`,
} as const;

/** CTA labels. Keep the verb English (§5) — micro-copy underneath carries the
 *  Hinglish flavour, not the button itself. */
export const cta = {
  BOOK_NOW: 'BOOK NOW',
  BOOK_SLOT: 'BOOK SLOT',
  TALK_NOW: 'TALK NOW',
  RESERVE_FREE: 'RESERVE · FREE',
  SHARE_WHATSAPP: 'SHARE ON WHATSAPP',
} as const;

/** The AvaTOK guarantee band (§1 rows 9–10, §5 "promises band" motif). */
export const promises = {
  /** The escrow guarantee — money held until the session actually happens. */
  escrow: 'Paisa escrow mein — session khatam tak',
  /** The number-masking promise — never show a buyer's or host's real number. */
  numberMasking: 'Tumhara real number kabhi kisi ko nahi dikhta',
  /** `link 15 min pehle aayega` — when the join link/reminder actually lands. */
  joinLead: (minutes: number): string => `link ${minutes} min pehle aayega`,
} as const;

/**
 * [LIST-PAGE-2] The SEEDHI BAAT NO CHAKKAR promises band on the details page
 * (design/live-streaming/avaTOK Listing Details.dc.html). Six fixed platform
 * guarantees — the two that vary per-listing (refund window, cancel window)
 * are composed by the caller from the listing's own commercial policy attrs,
 * not hardcoded here (§9 of the trust ladder: these must stay honest).
 */
export const promiseBand = {
  title: 'SEEDHI BAAT, NO CHAKKAR',
  escrowTitle: 'PAISA SAFE',
  escrowBody: 'Paisa escrow mein rehta hai — session khatam hone tak',
  numberTitle: 'NUMBER SAFE',
  numberBody: 'Tumhara real number kabhi kisi ko nahi dikhta',
  hostTitle: 'HOST VERIFIED',
  hostBody: 'Har host ki pehchaan check hoti hai — fake profile ka koi chance nahi',
  supportTitle: 'REAL SUPPORT',
  supportBody: 'Kuch galat laga? Report karo, hum dekhenge',
  reviewsTitle: 'SACCHE REVIEWS',
  reviewsBody: 'Sirf woh log likh sakte hain jo actually aaye the',
  refund: (hours: number): string => `Refund milta hai agar ${hours} ghante pehle cancel karo`,
  cancel: (hours: number): string => `Cancel window: ${hours} ghante pehle tak`,
} as const;

/** House-rules box — platform baseline shown under the creator's own rules. */
export const houseRules = {
  title: 'HOUSE RULES',
  platformBaseline: 'Platform ka rule sabke liye same hai: respect sabko, harassment ko zero tolerance.',
  empty: 'Is host ne abhi tak koi rule nahi likha — normal sharaafat chalegi.',
} as const;

/** Reviews section — empty state and pagination labels. */
export const reviewsCopy = {
  title: 'PUBLIC KI RAI',
  empty: 'Abhi koi review nahi — pehla tum likho?',
  verifiedTag: 'VERIFIED ATTENDEE',
  hostReply: 'HOST KA JAWAB',
  helpful: (n: number): string => (n > 0 ? `Helpful (${n})` : 'Helpful'),
  loadMore: 'AUR DIKHAO',
} as const;

/** Share box — WhatsApp-first, per §1 row 15. */
export const shareCopy = {
  title: 'SHARE THE SHOW',
  whatsapp: 'WHATSAPP',
  facebook: 'FACEBOOK',
  youtube: 'YOUTUBE',
  embed: 'EMBED',
  copyLink: 'COPY LINK',
  copied: 'LINK COPIED',
  /** QR caption (comp: design/live-streaming/avaTOK Listing Details.dc.html:172). */
  scanToOpen: 'SCAN TO OPEN THIS SHOW ON YOUR PHONE',
} as const;

/** [LIST-ASK-1] "Ask the host" box under MEET THE HOST — one question per
 *  listing (worker/src/routes/listing_questions.ts UNIQUE(listing_id, asker_id)),
 *  never a phone number (server-side `maskContact` strips them either way). */
export const askHost = {
  caption: (hostFirstName: string): string => `Ask ${hostFirstName} a question · 1 per listing · no phone numbers`,
  placeholder: 'Apna sawaal likho…',
  submit: 'ASK',
  submitting: 'Bhej rahe hain…',
  /** 200 — the question was recorded. */
  success: 'Bheja! Jawab email pe aayega',
  /** 409 already_asked. */
  alreadyAsked: 'Tumne is listing pe pehle hi sawaal poocha hai — ek hi allowed hai.',
  /** 429 rate limit (5/day, worker `rateLimit`). */
  rateLimited: 'Aaj ke liye sawaal poochne ki limit ho gayi — kal try karo.',
  /** 400 — the text was rejected (too long, empty, or the host's own listing). */
  masked: 'Yeh sawaal bhej nahi paaye — phone number ya link yahan allowed nahi hai.',
  error: 'Kuch gadbad ho gaya — thodi der mein phir try karo.',
  signInPrompt: 'Sawaal poochne ke liye sign in karo.',
  signIn: 'SIGN IN',
} as const;

/** [LIST-PAGE-2 gap 1] Month calendar in the booking box — SEPTEMBER 2026 style
 *  nav, show-day dots, and the "PICK A SLOT · FRI 4 SEP 2026" header under it
 *  (comp: avaTOK Listing Details.dc.html:244-264). */
export const calendarCopy = {
  pickDateFirst: 'PICK A DATE ON THE CALENDAR FIRST',
  pickASlotOn: (dateLabel: string): string => `PICK A SLOT · ${dateLabel}`,
  /** `● = SHOW DAY · EVERY FRIDAY` (recurring) or plain `● = SHOW DAY` otherwise. */
  showDayLegend: (suffix?: string | null): string => (suffix ? `● = SHOW DAY · ${suffix}` : '● = SHOW DAY'),
  every: (days: string): string => `EVERY ${days}`,
} as const;

/** How-it-works / meet-the-host / house-rules section eyebrows. */
export const sectionTitles = {
  howItWorks: 'HOW THE SHOW WORKS',
  meetHost: 'MEET THE HOST',
  browseMore: 'BROWSE MORE EVENTS',
  pastSessions: 'PAST SESSIONS',
  alsoListedBy: (name: string): string => `ALSO LISTED BY ${name.toUpperCase()}`,
  messageNote: 'Messages stay on avatok — no phone numbers shared',
} as const;

/** Booking box — the four-shape spine (SPEC-2026-09-01 §D). */
export const bookingBox = {
  bookASeat: (price: string): string => `BOOK A SEAT · ${price}`,
  howManySeats: 'HOW MANY SEATS',
  pickASlot: 'PICK A SLOT',
  bookAndJoin: (total: string): string => `BOOK & JOIN NOW · ${total}`,
  reserveFree: 'RESERVE · FREE',
  liveNow: 'LIVE NOW',
  watchingNow: (n: number): string => `${n} WATCHING`,
  joinInstantly: 'BOOK & JOIN INSTANTLY',
  fees: 'FEES & GST SHOWN BEFORE YOU BOOK',
} as const;

/** Copy for the free-entry lane (§2.4, §3.4) — the creator pays, not the buyer. */
export const freeBox = {
  /** Replaces the price breakdown entirely on a free listing's booking box. */
  hostPays: 'Host is paying for this one — show up and say thanks',
  /** The free session hit its cap (`content_free_cap_tokens` / 409 `free_session_full`). */
  full: 'Yeh free session full ho gaya',
  /** `12 spots baaki` — the free-lane seats-left line, cap-derived. */
  spotsLeft: (n: number): string => `${n} spots baaki`,
  /** 403 `free_sessions_disabled` — the lane itself is off, not this one session. */
  disabled: 'Free reservations are not open for this one right now',
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// [LIST-TRUST-1 / VIBE §2] Per-type CARD slot copy — appended in its own block
// so this addition can't collide with edits elsewhere in this file. Lane
// derivation and chip/pill assembly live in lib/card.ts (laneFor, pillLabel,
// chipsForLane, bottomRightForLane, buttonsForLane); every FIXED string that
// assembly reaches for lives here, not inlined in card.ts or ListingTile.tsx.
// ═══════════════════════════════════════════════════════════════════════════

/** Status-pill copy the fixed §2 vocabulary needs beyond `statusPill` above. */
export const pillExtra = {
  AVAILABLE_NOW: 'AVAILABLE NOW',
  ON_REQUEST: 'ON REQUEST',
} as const;

/** `LIVE · 340 DEKH RAHE` — live viewer count on the status pill (§2.1). */
export function liveWatching(n: number): string {
  return `LIVE · ${n.toLocaleString('en-IN')} DEKH RAHE`;
}

/** Chip fallback badges shared across §2's per-type ladders — each is the
 *  HONEST terminal rung, printed only once the earlier data-backed rungs have
 *  nothing to show (rule zero, §1: never fake a badge to look full). */
export const laneBadge = {
  PEHLA_SHOW: 'PEHLA SHOW',
  NAYA_AGENT: 'NAYA AGENT',
  NEW_EXPERT: 'NEW EXPERT',
  NEW_LISTING: 'NEW LISTING',
  JUST_ADDED: 'JUST ADDED',
  FULL: 'FULL',
} as const;

/** `⚡ 10 MIN RESPONSE` — consult chip 1 (§2.2). */
export function responseTime(min: number): string {
  return `⚡ ${min} MIN RESPONSE`;
}

/** `🎟 40 SPOTS BAAKI` — free-lane chip 1 (§2.4): like `chips.seatsLeft` above
 *  but "spots", the free lane's own noun, with the ticket glyph the comp uses. */
export function spotsLeft(n: number): string {
  return `🎟 ${n} SPOTS BAAKI`;
}

/** `🔥 8 SEATS BAAKI` — live chip 2 once seats are at or below 20% (§2.1). */
export function seatsBaakiUrgent(n: number): string {
  return `🔥 ${n} SEATS BAAKI`;
}

/** `EARLY BIRD −20%` — live chip 2's last rung, from an active promo (§2.1). */
export function earlyBird(pct: number): string {
  return `EARLY BIRD −${pct}%`;
}

/** `♡ 300 REGULARS` — the heart-glyph variant of `chips.regulars` above, used
 *  wherever §2's comp draws the ♡ (live chip 1, free chip 2). */
export function regularsHeart(n: number): string {
  return `♡ ${n.toLocaleString('en-IN')} REGULARS`;
}

/** `♡ 12K CHATS` — AI agent chip 2 (§2.3). */
export function chatsCount(n: number): string {
  return `♡ ${n.toLocaleString('en-IN')} CHATS`;
}

/** AI agent chip 1 — always true, so always shown (§2.3). */
export const AI_INSTANT = '⚡ INSTANT';

/** `PER 10 MIN` / `PER CHAT` / `PER NIGHT` / `PER MIN` / `PER GAME` — the
 *  bottom-right cadence label for a `billing_unit` (§2.2 / §2.3 / §2.5). */
export function billingUnitLabel(unit?: string | null): string | null {
  switch (unit) {
    case '10min': return 'PER 10 MIN';
    case 'minute': return 'PER MIN';
    case 'chat': return 'PER CHAT';
    case 'night': return 'PER NIGHT';
    case 'game': return 'PER GAME';
    default: return null;
  }
}

/** Secondary-button / preview labels beyond `cta` above — §2.2's calendar
 *  icon button and §2.3's sample-voice preview. */
export const ctaExtra = {
  CALENDAR: 'CALENDAR',
  SUNO: '▶ SUNO',
  DETAILS: 'DETAILS',
} as const;
