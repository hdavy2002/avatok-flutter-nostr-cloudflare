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
