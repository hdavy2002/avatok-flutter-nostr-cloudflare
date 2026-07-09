// ava_opportunity.ts — Phase C (ODL). The Opportunity Score, 0–100.
//
// "Detected" ≠ "worth interrupting for" (plan §8: "Happy birthday" = detected
// 99 / opportunity 8 → silent). This module turns trigger matches + cheap text
// heuristics into a DETERMINISTIC 0–100 score. ZERO AI, zero I/O, pure
// function — the same inputs always produce the same score, so shadow-mode
// projections are reproducible.
//
// Consumers compare the score against max(capability.min_opportunity,
// governor.min_opportunity_floor). Tuning = editing the constants below (a
// deploy) or raising the Governor floor (a KV write, no deploy).

import type { TriggerMatch, TriggerCategory } from "./ava_triggers";
import { matchedCategories } from "./ava_triggers";

// Base value of the strongest signal per category. otp is high (safety-ish,
// actionable NOW); ambient contact markers are low (rarely worth a Moment alone).
const CATEGORY_BASE: Record<TriggerCategory, number> = {
  otp: 55,
  money: 45,
  date_meeting: 45,
  travel: 42,
  commerce: 40,
  life_event: 40,
  birthday: 38,
  festival: 32,
  contact_marker: 18,
};

// First-person markers — the message is about the SPEAKER's own plans/money,
// which is where a copilot suggestion is most useful. en + hi + hinglish.
const FIRST_PERSON = /\b(i|i'm|i'll|me|my|mine|we|we're|our|let'?s|main|mera|meri|mujhe|humara|hum|apun)\b/i;

export interface OpportunityOpts {
  isGroup?: boolean;  // group chats get a small penalty (more noise, less "for me")
  ageMs?: number;     // message age when evaluated; fresh (<60s) gets a recency boost
}

/**
 * opportunityScore — deterministic 0–100. NO AI.
 *
 * Shape: base(strongest category) + multi-category corroboration + question
 * mark + first-person + length band + recency − group penalty, clamped 0–100.
 */
export function opportunityScore(text: string, matches: TriggerMatch[], opts: OpportunityOpts = {}): number {
  const t = String(text ?? "");
  if (!t.trim() || !matches.length) return 0;

  const cats = matchedCategories(matches);
  let score = 0;

  // 1. Base = the strongest matched category.
  for (const c of cats) score = Math.max(score, CATEGORY_BASE[c] ?? 20);

  // 2. Corroboration: extra DISTINCT categories (+8 each, max +16) and extra
  //    pattern hits within the message (+2 each, max +6). "meet tomorrow at 5pm,
  //    split ₹400" is a far better opportunity than a lone keyword.
  score += Math.min(16, Math.max(0, cats.length - 1) * 8);
  score += Math.min(6, Math.max(0, matches.length - cats.length) * 2);

  // 3. A question invites help.
  if (/\?/.test(t)) score += 10;

  // 4. First-person: the sender is talking about their own plans/money.
  if (FIRST_PERSON.test(t)) score += 8;

  // 5. Length band: real sentences beat fragments and walls of text.
  const len = t.trim().length;
  if (len >= 20 && len <= 400) score += 8;
  else if (len < 8) score -= 10;
  else if (len > 800) score -= 10;

  // 6. Recency: evaluated within a minute of send (the live path) is when a
  //    Moment is actually actionable. Default (no ageMs) = live path.
  const age = opts.ageMs ?? 0;
  if (age < 60_000) score += 5;

  // 7. Group chats: slightly less personal, slightly noisier.
  if (opts.isGroup) score -= 5;

  return Math.max(0, Math.min(100, Math.round(score)));
}
