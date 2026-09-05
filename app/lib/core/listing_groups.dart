// [MKT-3GROUP-1 2026-09-05] The marketplace taxonomy, mirrored for Flutter.
//
// GENERATED FROM Specs/listing-taxonomy.json by scripts/gen_listing_taxonomy.py.
// That JSON is canonical and the worker + web mirrors come from it too. Edit
// the JSON and re-run the generator; a hand-edit here drifts three surfaces
// apart, which is the exact failure this file exists to prevent.
//
// ⚠️ THIS IS AN OFFLINE FALLBACK, NOT THE SOURCE OF TRUTH AT RUNTIME.
// Categories live in D1 (`listing_categories`) and are served by
// GET /api/explore/categories, which is what the worker validates a listing's
// category against. The app must always prefer the fetched list (which now
// carries `group_id`) and fall back to this mirror only when the fetch is
// unavailable — otherwise a category added in D1 stays invisible on the app
// until someone ships a new build.
//
// Prose, the wording rules and the reasoning:
// Specs/SPEC-2026-09-05-THREE-GROUPS-AND-HOURLY-PRICING.md

/// One of the three marketplace top-level groups.
class ListingGroup {
  final String id;
  /// Section heading. `emphasis` is the trailing word that takes the coral.
  final String heading;
  final String emphasis;
  final String blurb;
  /// Wizard step-1 kinds whose sub-categories come from this group.
  final List<String> kinds;
  /// `listings.section` values that roll up into this group.
  final List<String> sections;

  const ListingGroup({
    required this.id,
    required this.heading,
    required this.emphasis,
    required this.blurb,
    required this.kinds,
    required this.sections,
  });
}

/// One sub-category "blip" under a group heading.
class ListingSubCategory {
  final String id;
  final String label;
  final String emoji;
  final String group;
  final int sort;
  /// Hide the blip while this platform flag is off.
  final String? requiresFlag;

  const ListingSubCategory({
    required this.id,
    required this.label,
    required this.emoji,
    required this.group,
    required this.sort,
    this.requiresFlag,
  });
}

const List<ListingGroup> kListingGroups = [
  ListingGroup(
    id: 'india_goes_live',
    heading: 'India goes live',
    emphasis: 'live.',
    blurb: 'Temple tours, skills, journeys and moments happening right now.',
    kinds: ['live_event'],
    sections: ['live_streaming'],
  ),
  ListingGroup(
    id: 'find_your_people',
    heading: 'Find your people',
    emphasis: 'people.',
    blurb: 'Real people you can pay for their time — someone to listen, or simply good company.',
    kinds: ['consult'],
    sections: ['live_friends', 'adda_rooms'],
  ),
  ListingGroup(
    id: 'book_their_time',
    heading: 'Book their time',
    emphasis: 'time.',
    blurb: 'Choose a professional, check their calendar and book a private session.',
    kinds: ['consult'],
    sections: ['consulting', 'astro_tarot', 'glow_up'],
  ),
];

/// [MKT-3GROUP-1] 'Voices with character' (ai_voice_agents) is deliberately NOT
/// a group: the owner removed it from the front page and the marketplace on
/// 2026-09-05. The SECTION value stays alive in the worker's SECTIONS union
/// because published rows carry it — it simply maps to no group, so nothing
/// renders it. Do not "tidy up" by deleting the value.
const Set<String> kHiddenListingSections = {'ai_voice_agents'};

const List<ListingSubCategory> kListingSubCategories = [
  ListingSubCategory(id: 'live_cooking', label: 'Cooking', emoji: '🍳', group: 'india_goes_live', sort: 10,),
  ListingSubCategory(id: 'live_trek', label: 'Treks & hiking', emoji: '🥾', group: 'india_goes_live', sort: 20,),
  ListingSubCategory(id: 'live_puja', label: 'Puja & darshan', emoji: '🪔', group: 'india_goes_live', sort: 30,),
  ListingSubCategory(id: 'live_temple', label: 'Temple tours', emoji: '🛕', group: 'india_goes_live', sort: 40,),
  ListingSubCategory(id: 'live_festival', label: 'Festivals', emoji: '🎉', group: 'india_goes_live', sort: 50,),
  ListingSubCategory(id: 'live_music', label: 'Music', emoji: '🎵', group: 'india_goes_live', sort: 60,),
  ListingSubCategory(id: 'live_dance', label: 'Dance', emoji: '💃', group: 'india_goes_live', sort: 70,),
  ListingSubCategory(id: 'live_travel', label: 'Travel & road trips', emoji: '🛵', group: 'india_goes_live', sort: 80,),
  ListingSubCategory(id: 'live_food_walk', label: 'Street food walks', emoji: '🍜', group: 'india_goes_live', sort: 90,),
  ListingSubCategory(id: 'live_fitness', label: 'Yoga & fitness', emoji: '🧘', group: 'india_goes_live', sort: 100,),
  ListingSubCategory(id: 'live_sports', label: 'Sports', emoji: '🏏', group: 'india_goes_live', sort: 110,),
  ListingSubCategory(id: 'live_art', label: 'Art & craft', emoji: '🎨', group: 'india_goes_live', sort: 120,),
  ListingSubCategory(id: 'live_satsang', label: 'Satsang & sermons', emoji: '📿', group: 'india_goes_live', sort: 130,),
  ListingSubCategory(id: 'live_everyday', label: 'Everyday life', emoji: '☕', group: 'india_goes_live', sort: 140,),
  ListingSubCategory(id: 'listener', label: 'Listener', emoji: '👂', group: 'find_your_people', sort: 210,),
  ListingSubCategory(id: 'home_friend', label: 'Home friend', emoji: '🏠', group: 'find_your_people', sort: 220,),
  ListingSubCategory(id: 'late_night_friend', label: 'Late-night friend', emoji: '🌙', group: 'find_your_people', sort: 230,),
  ListingSubCategory(id: 'quiet_company', label: 'Quiet company', emoji: '🤍', group: 'find_your_people', sort: 240,),
  ListingSubCategory(id: 'chat_buddy', label: 'Chat buddy', emoji: '💬', group: 'find_your_people', sort: 250,),
  ListingSubCategory(id: 'walk_talk', label: 'Walk & talk', emoji: '🚶', group: 'find_your_people', sort: 260,),
  ListingSubCategory(id: 'language_buddy', label: 'Language buddy', emoji: '🗣️', group: 'find_your_people', sort: 270,),
  ListingSubCategory(id: 'college_friends', label: 'College circle', emoji: '🎓', group: 'find_your_people', sort: 280,),
  ListingSubCategory(id: 'senior_company', label: 'Senior company', emoji: '🌻', group: 'find_your_people', sort: 290,),
  ListingSubCategory(id: 'queer_friendly', label: 'Queer-friendly space', emoji: '🏳️‍🌈', group: 'find_your_people', sort: 300,),
  ListingSubCategory(id: 'live_friends', label: 'Live friends', emoji: '👥', group: 'find_your_people', sort: 310,),
  ListingSubCategory(id: 'adda_rooms', label: 'Adda rooms', emoji: '☕', group: 'find_your_people', sort: 320, requiresFlag: 'conferenceEnabled',),
  ListingSubCategory(id: 'astrologers', label: 'Astrologers', emoji: '🔮', group: 'book_their_time', sort: 410,),
  ListingSubCategory(id: 'teachers', label: 'Tutors & teachers', emoji: '📚', group: 'book_their_time', sort: 420,),
  ListingSubCategory(id: 'professors', label: 'Professors', emoji: '🎓', group: 'book_their_time', sort: 430,),
  ListingSubCategory(id: 'business', label: 'Business & startups', emoji: '💼', group: 'book_their_time', sort: 440,),
  ListingSubCategory(id: 'money_finance', label: 'Money & finance', emoji: '💰', group: 'book_their_time', sort: 450,),
  ListingSubCategory(id: 'career_coach', label: 'Career coaching', emoji: '🧭', group: 'book_their_time', sort: 460,),
  ListingSubCategory(id: 'fitness', label: 'Fitness coaching', emoji: '💪', group: 'book_their_time', sort: 470,),
  ListingSubCategory(id: 'wellness', label: 'Wellness', emoji: '🧘', group: 'book_their_time', sort: 480,),
  ListingSubCategory(id: 'music', label: 'Music lessons', emoji: '🎵', group: 'book_their_time', sort: 490,),
  ListingSubCategory(id: 'language', label: 'Language lessons', emoji: '🗣️', group: 'book_their_time', sort: 500,),
  ListingSubCategory(id: 'art', label: 'Art & design', emoji: '🎨', group: 'book_their_time', sort: 510,),
  ListingSubCategory(id: 'glow_up', label: 'Style & glow-up', emoji: '✨', group: 'book_their_time', sort: 520,),
  ListingSubCategory(id: 'legal_tax', label: 'Legal & tax', emoji: '⚖️', group: 'book_their_time', sort: 530,),
  ListingSubCategory(id: 'tech_help', label: 'Tech help', emoji: '🛠️', group: 'book_their_time', sort: 540,),
  ListingSubCategory(id: 'services', label: 'Other professional', emoji: '🔧', group: 'book_their_time', sort: 550,),
];

/// [PRICE-HOURLY-1] Per participant, PER HOUR. A 2-hour booking bills the flat
/// fee twice (owner decision 2026-09-05: "per 1 hour"). `kListingPricingMinPriceTokensPerHour`
/// exists because at or below the flat fee the creator would earn nothing —
/// the wizard refuses to go lower, and so does the server.
const int kListingPricingFlatTokensPerHour = 25;
const int kListingPricingCommissionPct = 20;
const int kListingPricingMinPriceTokensPerHour = 49;

/// [MKT-3GROUP-1] `listings.media_mode`. audio_only hides the video control
/// for the whole session; audio_video means the creator may NOT turn video
/// off — they sold a video session. THE FIELD ONLY: wiring it into the call
/// UI is separate work.
class MediaModeOption {
  final String id;
  final String label;
  final String help;
  const MediaModeOption({required this.id, required this.label, required this.help});
}

const List<MediaModeOption> kMediaModes = [
  MediaModeOption(id: 'audio_video', label: 'Audio and video', help: 'The creator may NOT turn video off. They sold a video session; one that becomes audio-only mid-way is a refund.'),
  MediaModeOption(id: 'audio_only', label: 'Audio only', help: 'The video control is not shown at all while streaming or in a 1:1 — the creator never appears on camera.'),
];
const String kMediaModeDefault = 'audio_video';

/// Sub-categories in one group, in display order.
List<ListingSubCategory> listingSubCategoriesForGroup(String group) {
  final out = kListingSubCategories.where((c) => c.group == group).toList();
  out.sort((a, b) => a.sort.compareTo(b.sort));
  return out;
}

/// The groups a wizard step-1 kind can file a listing into.
///
/// `consult` returns TWO groups on purpose. A 1:1 listing can be paid company
/// ('Find your people') or a professional ('Book their time'), and step 1 does
/// not distinguish them — the owner's decision (2026-09-05) is that the
/// SUB-CATEGORY decides. So step 2 shows both groups' blips under their two
/// headings, and whichever the creator picks is what files the listing.
List<ListingGroup> listingGroupsForKind(String kind) =>
    kListingGroups.where((g) => g.kinds.contains(kind)).toList();

/// Which group a listing belongs to, from its category. Null when it belongs
/// to none — a marketplace-goods category, or an ai_voice_agents listing.
///
/// Prefer the server's `group_id` (shipped on `GET /api/explore/categories`
/// and on every listing card) over this offline lookup — this mirror only
/// covers categories known at build time.
String? listingGroupForCategory(String? category) {
  if (category == null || category.isEmpty) return null;
  for (final c in kListingSubCategories) {
    if (c.id == category) return c.group;
  }
  return null;
}

/// Fee split for one participant for one hour, in tokens (1 token = ₹1).
///
/// ⚠️ FOR DISPLAY ONLY. The worker recomputes this when money actually moves;
/// a client-computed fee must never reach a ledger row. Keep the two in step.
class ListingFeeSplit {
  final int fee;
  final int creator;
  const ListingFeeSplit({required this.fee, required this.creator});
}

ListingFeeSplit listingFeeSplit(num? pricePerHour) {
  final price = (pricePerHour ?? 0).round().clamp(0, 1 << 31).toInt();
  if (price <= kListingPricingFlatTokensPerHour) {
    return ListingFeeSplit(fee: price, creator: 0);
  }
  final fee = kListingPricingFlatTokensPerHour +
      ((price - kListingPricingFlatTokensPerHour) *
              kListingPricingCommissionPct /
              100)
          .round();
  return ListingFeeSplit(fee: fee, creator: price - fee);
}
