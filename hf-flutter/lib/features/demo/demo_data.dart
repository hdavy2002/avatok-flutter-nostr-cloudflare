import 'dart:async';

import '../../core/analytics/analytics.dart';
import '../../core/widgets/status_pill.dart';
import '../call/data/call_models.dart';
import '../explore/data/host_card.dart';
import '../explore/data/host_filters.dart';
import '../host_profile/data/host_profile.dart';
import '../review/data/review_api.dart';

// Everything demo-specific lives in lib/features/demo/. See README.md there for how to remove it.

/// Master switch. `false` hides the demo hosts and turns every `[HF-DEMO]` hook into a no-op.
const bool kDemoEnabled = true;

/// Whether Discover lists the demo hosts. Starts as [kDemoEnabled]; the existing Explore tests turn it off so
/// they count real hosts only, and the demo tests turn it on.
bool demoHostsInLists = kDemoEnabled;

const String kDemoNehaSlug = 'demo-neha';
const String kDemoRohanSlug = 'demo-rohan';

/// The id of the simulated call (`/call/demo-call`).
const String kDemoCallId = 'demo-call';

/// Pictures bundled with the app are written `asset://assets/images/x.webp`.
const String kDemoAssetPrefix = 'asset://';

/// A fake voice clip: no audio, the bar animates for [introSeconds].
const String kDemoAudioPrefix = 'demo://';

const String kDemoNehaAvatar =
    '${kDemoAssetPrefix}assets/images/demo_neha.webp';
const String kDemoRohanAvatar =
    '${kDemoAssetPrefix}assets/images/demo_rohan.webp';
const List<String> kDemoNehaGallery = <String>[
  '${kDemoAssetPrefix}assets/images/demo_neha_1.webp',
  '${kDemoAssetPrefix}assets/images/demo_neha_2.webp',
];

bool isDemoSlug(String? slug) =>
    kDemoEnabled && (slug == kDemoNehaSlug || slug == kDemoRohanSlug);

/// A location that belongs to the demo flow, which needs no sign-in (guests can feel it too).
bool isDemoUri(Uri uri) =>
    kDemoEnabled &&
    (uri.path == '/call/$kDemoCallId' ||
        uri.path == '/review/call/$kDemoCallId' ||
        (uri.path == '/call/new' && isDemoSlug(uri.queryParameters['host'])));

/// What Notify me says for a demo host (no account, no request).
const String kDemoNotifyMessage =
    "Demo — you'd be told on WhatsApp when Rohan is free";

bool isDemoCallId(String? id) => kDemoEnabled && id == kDemoCallId;

bool isDemoAudioUrl(String? url) =>
    url != null && url.startsWith(kDemoAudioPrefix);

String? demoAvatarFor(String slug) => switch (slug) {
  kDemoNehaSlug => kDemoNehaAvatar,
  kDemoRohanSlug => kDemoRohanAvatar,
  _ => null,
};

/// `asset://assets/images/x.webp` to `assets/images/x.webp`; null for anything else.
String? demoAssetPath(String? url) =>
    url != null && url.startsWith(kDemoAssetPrefix)
    ? url.substring(kDemoAssetPrefix.length)
    : null;

/// `hf_demo_flow {step}`: the only telemetry the demo sends.
void demoStep(String step) {
  unawaited(Analytics.capture('hf_demo_flow', <String, Object>{'step': step}));
}

const HostCard kDemoNehaCard = HostCard(
  slug: kDemoNehaSlug,
  displayName: 'Neha',
  tagline: 'A calm ear after a long day',
  avatarUrl: kDemoNehaAvatar,
  languages: <String>['Hindi', 'Marathi'],
  style: 'Calm & thoughtful',
  topics: <String>[
    'raat-ko-neend-nahi-aati',
    'aaj-akela-lag-raha-hai',
    'roz-thodi-baat',
    'koi-jo-mujhe-jaane',
    'apni-bhasha-mein-dost',
  ],
  pricePerMin: 20,
  rating: 4.9,
  reviewCount: 48,
  talkedTo: 164,
  regulars: 23,
  introAudioUrl: '${kDemoAudioPrefix}neha-intro',
  introSeconds: 20,
  status: HostPresence.online,
  gender: 'female',
);

const HostCard kDemoRohanCard = HostCard(
  slug: kDemoRohanSlug,
  displayName: 'Rohan',
  tagline: 'Talk it out before the big day',
  avatarUrl: kDemoRohanAvatar,
  languages: <String>['Hindi', 'English'],
  style: 'Steady & encouraging',
  topics: <String>[
    'naukri-ki-chinta',
    'exam-ki-tension',
    'roz-thodi-baat',
    'aaj-akela-lag-raha-hai',
    'koi-jo-mujhe-jaane',
  ],
  pricePerMin: 20,
  rating: 4.7,
  reviewCount: 31,
  talkedTo: 130,
  regulars: 21,
  introAudioUrl: '${kDemoAudioPrefix}rohan-intro',
  introSeconds: 20,
  status: HostPresence.busy,
  gender: 'male',
);

const List<HostCard> kDemoHostCards = <HostCard>[kDemoNehaCard, kDemoRohanCard];

/// The demo hosts go first on Discover, but only on the plain list: a lane tab or any filter shows real hosts only.
List<HostCard> withDemoHosts(HostFilters f, List<HostCard> real) {
  if (!kDemoEnabled || !demoHostsInLists || f.hasAny) return real;
  final seen = <String>{for (final c in real) c.slug};
  return <HostCard>[
    for (final c in kDemoHostCards)
      if (!seen.contains(c.slug)) c,
    ...real,
  ];
}

const String kDemoNehaAbout =
    'I work days in Pune and I am usually free after dinner. Friends say I am easy to talk to because I '
    'don’t rush to fix things. If you can’t sleep, feel alone in a new city, or just want to talk in '
    'Marathi, call me.';

const String kDemoNehaQuote =
    'Some nights you don’t need advice. You just need someone who is awake too.';

/// The profile served for a demo slug, with no network call.
HostProfile? demoProfileFor(String slug) {
  if (!kDemoEnabled) return null;
  final now = DateTime.now().millisecondsSinceEpoch;
  const day = 24 * 60 * 60 * 1000;
  switch (slug) {
    case kDemoNehaSlug:
      return HostProfile(
        slug: kDemoNehaSlug,
        displayName: 'Neha',
        tagline: kDemoNehaCard.tagline,
        avatarUrl: kDemoNehaAvatar,
        languages: kDemoNehaCard.languages,
        style: kDemoNehaCard.style,
        topics: kDemoNehaCard.topics,
        pricePerMin: 20,
        rating: 4.9,
        reviewCount: 48,
        ratingBreakdown: const <int, int>{5: 41, 4: 5, 3: 2, 2: 0, 1: 0},
        talkedTo: 164,
        regulars: 23,
        introAudioUrl: kDemoNehaCard.introAudioUrl,
        introSeconds: 20,
        status: HostPresence.online,
        aboutPolished: kDemoNehaAbout,
        quote: kDemoNehaQuote,
        gallery: const <GalleryImage>[
          GalleryImage(
            url: '${kDemoAssetPrefix}assets/images/demo_neha_1.webp',
          ),
          GalleryImage(
            url: '${kDemoAssetPrefix}assets/images/demo_neha_2.webp',
          ),
        ],
        reviews: <HostReview>[
          HostReview(
            firstName: 'Aditya',
            stars: 5,
            text:
                'Couldn’t sleep before my shift change. 25 minutes with Neha and I felt normal again.',
            topic: 'raat ko neend nahi aati',
            minutes: 25,
            regular: true,
            date: now - 2 * day,
          ),
          HostReview(
            firstName: 'Ritu',
            stars: 5,
            text: 'Talked in Marathi after months. She listens, no lectures.',
            topic: 'apni bhasha mein dost',
            minutes: 18,
            date: now - 7 * day,
          ),
        ],
      );
    case kDemoRohanSlug:
      return HostProfile(
        slug: kDemoRohanSlug,
        displayName: 'Rohan',
        tagline: kDemoRohanCard.tagline,
        avatarUrl: kDemoRohanAvatar,
        languages: kDemoRohanCard.languages,
        style: kDemoRohanCard.style,
        topics: kDemoRohanCard.topics,
        pricePerMin: 20,
        rating: 4.7,
        reviewCount: 31,
        ratingBreakdown: const <int, int>{5: 22, 4: 7, 3: 2, 2: 0, 1: 0},
        talkedTo: 130,
        regulars: 21,
        introAudioUrl: kDemoRohanCard.introAudioUrl,
        introSeconds: 20,
        status: HostPresence.busy,
        aboutPolished:
            'Interview next week? Exam tomorrow? I have been there. I will not tell you to stay calm, '
            'we will just talk it through until it feels smaller.',
        quote: null,
      );
  }
  return null;
}

/// What the confirm sheet shows for a demo host: wallet ₹342, about 17 minutes.
const CallEstimate kDemoEstimate = CallEstimate(
  isTokens: true,
  ratePerMinRupees: 20,
  tokensPerMinute: '20.00',
  aboutText: 'about 17 min',
  affordableSeconds: 17 * 60 + 6,
  canStart: true,
  balance: '342',
);

const ReviewTarget kDemoReviewTarget = ReviewTarget(
  hostName: 'Neha',
  hostSlug: kDemoNehaSlug,
  minutes: 2,
  canReview: true,
);

const List<ReviewTopic> kDemoReviewTopics = <ReviewTopic>[
  ReviewTopic('raat-ko-neend-nahi-aati', 'raat ko neend nahi aati'),
  ReviewTopic('roz-thodi-baat', 'roz thodi baat'),
  ReviewTopic('apni-bhasha-mein-dost', 'apni bhasha mein dost'),
];
