/* [MKT-3GROUP-1 2026-09-05] The marketplace taxonomy, mirrored for the web.
 *
 * GENERATED FROM Specs/listing-taxonomy.json by scripts/gen_listing_taxonomy.py.
 * That JSON is canonical and the worker + Flutter mirrors come from it too. Edit
 * the JSON and re-run the generator; a hand-edit here drifts three surfaces
 * apart, which is the exact failure this file exists to prevent.
 *
 * ⚠️ THIS IS A FALLBACK, NOT THE SOURCE OF TRUTH AT RUNTIME. Categories live in
 * D1 (`listing_categories`) and are served by GET /api/explore/categories, which
 * is what the worker validates a listing's category against. Always prefer the
 * fetched list and fall back to this only when the fetch fails — otherwise a
 * category added in D1 stays invisible on the web until someone redeploys.
 *
 * Prose, the wording rules and the reasoning:
 * Specs/SPEC-2026-09-05-THREE-GROUPS-AND-HOURLY-PRICING.md
 */

export type GroupId = 'india_goes_live' | 'find_your_people' | 'book_their_time';

export interface Group {
  id: GroupId;
  /** Section heading. `emphasis` is the trailing word that takes the coral. */
  heading: string;
  emphasis: string;
  blurb: string;
  /** Wizard step-1 kinds whose sub-categories come from this group. */
  kinds: string[];
  /** `listings.section` values that roll up into this group. */
  sections: string[];
}

export interface SubCategory {
  id: string;
  label: string;
  emoji: string;
  group: GroupId;
  sort: number;
  /** Hide the blip while this platform flag is off. */
  requiresFlag?: string;
}

export const GROUPS: Group[] = [
  {
    id: "india_goes_live",
    heading: "India goes live",
    emphasis: "live.",
    blurb: "Temple tours, skills, journeys and moments happening right now.",
    kinds: ["live_event"],
    sections: ["live_streaming"],
  },
  {
    id: "find_your_people",
    heading: "Find your people",
    emphasis: "people.",
    blurb: "Real people you can pay for their time — someone to listen, or simply good company.",
    kinds: ["consult"],
    sections: ["live_friends", "adda_rooms"],
  },
  {
    id: "book_their_time",
    heading: "Book their time",
    emphasis: "time.",
    blurb: "Choose a professional, check their calendar and book a private session.",
    kinds: ["consult"],
    sections: ["consulting", "astro_tarot", "glow_up"],
  },
];

/* [MKT-3GROUP-1] 'Voices with character' (ai_voice_agents) is deliberately NOT a
 * group: the owner removed it from the front page and the marketplace on
 * 2026-09-05. The SECTION value stays alive in the worker's SECTIONS union
 * because published rows carry it — it simply maps to no group, so nothing
 * renders it. Do not "tidy up" by deleting the value. */
export const HIDDEN_SECTIONS: ReadonlySet<string> = new Set(['ai_voice_agents']);

export const SUB_CATEGORIES: SubCategory[] = [
  { id: "live_cooking", label: "Cooking", emoji: "🍳", group: "india_goes_live", sort: 10, },
  { id: "live_trek", label: "Treks & hiking", emoji: "🥾", group: "india_goes_live", sort: 20, },
  { id: "live_puja", label: "Puja & darshan", emoji: "🪔", group: "india_goes_live", sort: 30, },
  { id: "live_temple", label: "Temple tours", emoji: "🛕", group: "india_goes_live", sort: 40, },
  { id: "live_festival", label: "Festivals", emoji: "🎉", group: "india_goes_live", sort: 50, },
  { id: "live_music", label: "Music", emoji: "🎵", group: "india_goes_live", sort: 60, },
  { id: "live_dance", label: "Dance", emoji: "💃", group: "india_goes_live", sort: 70, },
  { id: "live_travel", label: "Travel & road trips", emoji: "🛵", group: "india_goes_live", sort: 80, },
  { id: "live_food_walk", label: "Street food walks", emoji: "🍜", group: "india_goes_live", sort: 90, },
  { id: "live_fitness", label: "Yoga & fitness", emoji: "🧘", group: "india_goes_live", sort: 100, },
  { id: "live_sports", label: "Sports", emoji: "🏏", group: "india_goes_live", sort: 110, },
  { id: "live_art", label: "Art & craft", emoji: "🎨", group: "india_goes_live", sort: 120, },
  { id: "live_satsang", label: "Satsang & sermons", emoji: "📿", group: "india_goes_live", sort: 130, },
  { id: "live_everyday", label: "Everyday life", emoji: "☕", group: "india_goes_live", sort: 140, },
  { id: "listener", label: "Listener", emoji: "👂", group: "find_your_people", sort: 210, },
  { id: "home_friend", label: "Home friend", emoji: "🏠", group: "find_your_people", sort: 220, },
  { id: "late_night_friend", label: "Late-night friend", emoji: "🌙", group: "find_your_people", sort: 230, },
  { id: "quiet_company", label: "Quiet company", emoji: "🤍", group: "find_your_people", sort: 240, },
  { id: "chat_buddy", label: "Chat buddy", emoji: "💬", group: "find_your_people", sort: 250, },
  { id: "walk_talk", label: "Walk & talk", emoji: "🚶", group: "find_your_people", sort: 260, },
  { id: "language_buddy", label: "Language buddy", emoji: "🗣️", group: "find_your_people", sort: 270, },
  { id: "college_friends", label: "College circle", emoji: "🎓", group: "find_your_people", sort: 280, },
  { id: "senior_company", label: "Senior company", emoji: "🌻", group: "find_your_people", sort: 290, },
  { id: "queer_friendly", label: "Queer-friendly space", emoji: "🏳️‍🌈", group: "find_your_people", sort: 300, },
  { id: "live_friends", label: "Live friends", emoji: "👥", group: "find_your_people", sort: 310, },
  { id: "adda_rooms", label: "Adda rooms", emoji: "☕", group: "find_your_people", sort: 320, requiresFlag: "conferenceEnabled", },
  { id: "astrologers", label: "Astrologers", emoji: "🔮", group: "book_their_time", sort: 410, },
  { id: "teachers", label: "Tutors & teachers", emoji: "📚", group: "book_their_time", sort: 420, },
  { id: "professors", label: "Professors", emoji: "🎓", group: "book_their_time", sort: 430, },
  { id: "business", label: "Business & startups", emoji: "💼", group: "book_their_time", sort: 440, },
  { id: "money_finance", label: "Money & finance", emoji: "💰", group: "book_their_time", sort: 450, },
  { id: "career_coach", label: "Career coaching", emoji: "🧭", group: "book_their_time", sort: 460, },
  { id: "fitness", label: "Fitness coaching", emoji: "💪", group: "book_their_time", sort: 470, },
  { id: "wellness", label: "Wellness", emoji: "🧘", group: "book_their_time", sort: 480, },
  { id: "music", label: "Music lessons", emoji: "🎵", group: "book_their_time", sort: 490, },
  { id: "language", label: "Language lessons", emoji: "🗣️", group: "book_their_time", sort: 500, },
  { id: "art", label: "Art & design", emoji: "🎨", group: "book_their_time", sort: 510, },
  { id: "glow_up", label: "Style & glow-up", emoji: "✨", group: "book_their_time", sort: 520, },
  { id: "legal_tax", label: "Legal & tax", emoji: "⚖️", group: "book_their_time", sort: 530, },
  { id: "tech_help", label: "Tech help", emoji: "🛠️", group: "book_their_time", sort: 540, },
  { id: "services", label: "Other professional", emoji: "🔧", group: "book_their_time", sort: 550, },
];

/** [PRICE-HOURLY-1] Per participant, PER HOUR. A 2-hour booking bills the flat
 *  fee twice (owner decision 2026-09-05: "per 1 hour"). `minPriceTokensPerHour`
 *  exists because at or below the flat fee the creator would earn nothing — the
 *  wizard refuses to go lower, and so does the server. */
export const PRICING = {
  flatTokensPerHour: 25,
  commissionPct: 20,
  minPriceTokensPerHour: 49,
} as const;

/** [MKT-3GROUP-1] `listings.media_mode`. audio_only hides the video control for
 *  the whole session; audio_video means the creator may NOT turn video off —
 *  they sold a video session. THE FIELD ONLY: wiring it into the call UI is
 *  separate work. */
export type MediaMode = 'audio_video' | 'audio_only';
export const MEDIA_MODES: { id: MediaMode; label: string; help: string }[] = [
  { id: 'audio_video', label: "Audio and video", help: "The creator may NOT turn video off. They sold a video session; one that becomes audio-only mid-way is a refund." },
  { id: 'audio_only', label: "Audio only", help: "The video control is not shown at all while streaming or in a 1:1 — the creator never appears on camera." },
];
export const MEDIA_MODE_DEFAULT: MediaMode = "audio_video";

/** Sub-categories in one group, in display order. */
export function subCategoriesFor(group: GroupId): SubCategory[] {
  return SUB_CATEGORIES.filter((c) => c.group === group).sort((a, b) => a.sort - b.sort);
}

/** The groups a wizard step-1 kind can file a listing into.
 *
 *  `consult` returns TWO groups on purpose. A 1:1 listing can be paid company
 *  ('Find your people') or a professional ('Book their time'), and step 1 does
 *  not distinguish them — the owner's decision (2026-09-05) is that the
 *  SUB-CATEGORY decides. So step 2 shows both groups' blips under their two
 *  headings, and whichever the creator picks is what files the listing. */
export function groupsForKind(kind: string): Group[] {
  return GROUPS.filter((g) => g.kinds.includes(kind));
}

/** Which group a listing belongs to, from its category. Null when it belongs to
 *  none — a marketplace-goods category, or an ai_voice_agents listing. */
export function groupForCategory(category: string | null | undefined): GroupId | null {
  if (!category) return null;
  return SUB_CATEGORIES.find((c) => c.id === category)?.group ?? null;
}

/** Fee split for one participant for one hour, in tokens (1 token = ₹1).
 *
 *  ⚠️ FOR DISPLAY ONLY. The worker recomputes this when money actually moves; a
 *  client-computed fee must never reach a ledger row. Keep the two in step. */
export function feeSplit(pricePerHour: number): { fee: number; creator: number } {
  const price = Math.max(0, Math.round(pricePerHour || 0));
  if (price <= PRICING.flatTokensPerHour) return { fee: price, creator: 0 };
  const fee = PRICING.flatTokensPerHour
    + Math.round((price - PRICING.flatTokensPerHour) * PRICING.commissionPct / 100);
  return { fee, creator: price - fee };
}
