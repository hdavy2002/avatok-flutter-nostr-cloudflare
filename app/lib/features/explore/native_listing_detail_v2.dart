
import '../../core/localization/ui_text.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:qr_flutter/qr_flutter.dart';
import 'package:share_plus/share_plus.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:youtube_player_iframe/youtube_player_iframe.dart';

import '../../core/analytics.dart';
import '../../core/availability_time.dart';
import '../../core/avatar.dart';
import '../../core/cached_image.dart';
import '../../core/listing_groups.dart';
import '../../core/listings_api.dart';
import '../../core/remote_config.dart';
import '../../core/ui/avatok_dark.dart';
import '../../core/ui/messenger_theme.dart';
import '../../core/ui/motion/motion.dart';
import 'creator_channel.dart';
import 'native_listing_booking_flow.dart';

/// [AGENT-LIVE-1 D1/D11, Specs/SPEC-2026-09-12-AGENT-LIVE-1-BUILD.md §7]
/// Mirrors `agentSlotMinutes` server default (`5,10,20,30,40,60`,
/// `worker/src/routes/config.ts` DEFAULTS) — shown as read-only chips when a
/// card doesn't carry its own `slot_minutes` (today, no `ListingCard` field
/// does; see `core/listings_api.dart`).
const List<int> kAgentDefaultSlotMinutes = [5, 10, 20, 30, 40, 60];

/// The durations this agent can be booked for. Reads `attrs['slot_minutes']`
/// defensively (same pattern as `_howItWorks`'s `content_how_it_works`) in
/// case a future server ships it there; falls back to the platform default.
List<int> _agentSlotMinutes(ListingCard l) {
  final raw = l.attrs['slot_minutes'];
  if (raw is List) {
    final mins = raw
        .whereType<num>()
        .map((n) => n.toInt())
        .where((n) => n > 0)
        .toList();
    if (mins.isNotEmpty) return mins;
  }
  return kAgentDefaultSlotMinutes;
}

/// [LISTING-EXPIRY-1 / P1-6] Show time in the LISTING's timezone. India has one
/// fixed offset (+05:30, no DST), so an IST listing is rendered in IST whatever
/// zone the phone is set to — the old `toLocal()` showed a traveller a different
/// time from the website. Other zones fall back to the phone's local time.
String _when(int? epochMs, [String? timezone]) {
  if (epochMs == null || epochMs <= 0) return uiCopy(UiMessage.m_on_request_3ffca9ca59);
  final ms = epochMs < 100000000000 ? epochMs * 1000 : epochMs;
  final utc = DateTime.fromMillisecondsSinceEpoch(ms, isUtc: true);
  final zone = timezone;
  DateTime date;
  var ist = false;
  if (zone == null || zone.isEmpty || zone == 'Asia/Kolkata' || zone == 'Asia/Calcutta') {
    ist = true;
    date = utc.add(const Duration(hours: 5, minutes: 30));
  } else {
    try {
      date = AvailabilityTime.inTimezone(utc, zone);
    } catch (_) {
      date = utc.toLocal();
    }
  }
  String two(int v) => v.toString().padLeft(2, '0');
  return '${two(date.day)}/${two(date.month)} · ${two(date.hour)}:${two(date.minute)}${ist ? ' IST' : ''}';
}

/// [LIST-APP-PARITY-1] The YouTube id inside a listing's `video_url`, or null.
///
/// Same pattern as `features/avatok/chat_media_cards.dart#firstYouTubeId`;
/// duplicated rather than imported so the detail page does not pull the whole
/// chat media-card library in for eleven characters.
String? youTubeIdOf(String? url) {
  final text = (url ?? '').trim();
  if (text.isEmpty) return null;
  final match = RegExp(
    r'(?:youtube\.com/(?:watch\?(?:.*&)?v=|shorts/|embed/|live/|v/)|youtu\.be/)([A-Za-z0-9_-]{11})',
    caseSensitive: false,
  ).firstMatch(text);
  return match?.group(1);
}

/// [LIST-APP-PARITY-2 2026-09-14] The four `join_requirements` keys the server
/// accepts (`worker/src/routes/listings.ts:534`), in the buyer's words. Kept in
/// step with the creator-side copy in
/// `features/marketplace/native_listing/native_listing_wizard_screen.dart`
/// (`_kJoinRequirementLabels`), which is private to that screen.
const Map<String, String> kJoinRequirementLabels = {
  'mic': 'MIC NEEDED',
  'cam': 'CAMERA NEEDED',
  'listen_only': 'LISTENING ONLY',
  'recording': uiCopy(UiMessage.m_this_session_is_recorded_8fa5887b9d),
};

/// [LISTING-EXPIRY-1] The one line a closed listing shows instead of a CTA.
String _closedLabel(ListingCard l) {
  switch (l.scheduleState) {
    case 'cancelled':
      return uiCopy(UiMessage.m_show_cancelled_8823dcbc7f);
    case 'ended':
    case 'expired':
      return uiCopy(UiMessage.m_show_ended_dcd96e63c0);
    default:
      return uiCopy(UiMessage.m_booking_closed_bb33314574);
  }
}

/// The second-generation native listing surface. This is a deliberate replacement
/// for both the old monolithic detail widget and the embedded website: every
/// section is a Flutter widget and every CTA stays inside the app.
class NativeListingDetailV2 extends StatefulWidget {
  const NativeListingDetailV2(
      {super.key, required this.listingId, this.source = 'unknown'});
  final String listingId;
  final String source;

  @override
  State<NativeListingDetailV2> createState() => _NativeListingDetailV2State();
}

class _NativeListingDetailV2State extends State<NativeListingDetailV2> {
  ListingDetail? detail;
  CreatorChannel? creator;
  List<ListingCard> related = const [];
  bool loading = true;
  bool favouriteBusy = false;
  String? error;
  /// [LIST-APP-PARITY-1] Created only when the viewer actually taps play, so a
  /// listing page never boots an embedded webview nobody asked for.
  YoutubePlayerController? _ytController;

  @override
  void dispose() {
    _ytController?.close();
    super.dispose();
  }

  @override
  void initState() {
    super.initState();
    Analytics.capture('listing_detail_opened', {
      'listing_id': widget.listingId,
      'source': widget.source,
      'render_mode': 'native_v2'
    });
    _load();
  }

  Future<void> _load() async {
    try {
      final d = await ListingsApi.detail(widget.listingId);
      if (d == null) throw StateError('Listing not found');
      CreatorChannel? c;
      try {
        c = await ListingsApi.creator(d.listing.creator.uid);
      } catch (_) {}
      List<ListingCard> r = const [];
      try {
        r = await ListingsApi.explore(
            category: d.listing.category, cache: true);
      } catch (_) {}
      if (!mounted) return;
      setState(() {
        detail = d;
        creator = c;
        related = r.where((x) => x.id != d.listing.id).take(8).toList();
        loading = false;
      });
      // [AGENT-LIVE-1 §8] `agent_listing_view{agent_id}` — mirrors the web
      // telemetry catalog entry so an agent's views are comparable across
      // surfaces, even though this app never lets a session start natively.
      if (d.listing.kind == 'agent') {
        Analytics.capture('agent_listing_view', {
          'agent_id': d.listing.id,
          'listing_id': d.listing.id,
          'source': widget.source,
        });
      }
    } catch (e) {
      if (mounted)
        setState(() {
          loading = false;
          error =
              'Could not load this listing. Check your connection and try again.';
        });
    }
  }

  Future<void> _toggleFavourite() async {
    final d = detail;
    if (d == null || favouriteBusy) return;
    setState(() {
      favouriteBusy = true;
      d.listing.favorited = !d.listing.favorited;
    });
    final ok = d.listing.favorited
        ? await ListingsApi.favorite(d.listing.id)
        : await ListingsApi.unfavorite(d.listing.id);
    if (!ok && mounted)
      setState(() => d.listing.favorited = !d.listing.favorited);
    if (mounted) setState(() => favouriteBusy = false);
  }

  void _openBooking() {
    final d = detail;
    if (d == null) return;
    // [LISTING-EXPIRY-1] Never start a checkout for a show that is over. A buyer who
    // already holds a ticket still gets into their booking (refund status lives there).
    if (!d.booked && !d.listing.canBook) {
      Analytics.capture('listing_booking_blocked_closed', {
        'listing_id': d.listing.id,
        'schedule_state': d.listing.scheduleState,
        'reason': d.listing.bookingClosedReason ?? uiCopy(UiMessage.m_none_140bedbf9c),
      });
      showAdToast(context, message: _closedLabel(d.listing) == 'SHOW CANCELLED'
          ? uiCopy(UiMessage.m_this_show_was_cancelled_fa0e32f868)
          : uiCopy(UiMessage.m_this_show_is_no_longer_8399fdeace));
      return;
    }
    Navigator.push(
        context,
        MaterialPageRoute(
            builder: (_) => NativeListingBookingFlow(
                listing: d.listing)));
  }

  /// [AGENT-LIVE-1 D11] The ONLY thing the app ever does for an agent
  /// listing: hand off to the web. No hold, no quote, no checkout sheet, no
  /// talk session ever starts natively — those all live behind
  /// `agentCheckoutEnabled`/`agentTalkEnabled` on the web surface (WS-D/E1/G).
  Future<void> _talkOnWeb(ListingCard l) async {
    final startedMs = DateTime.now().millisecondsSinceEpoch;
    final uri = Uri.parse('https://avatok.ai/l/${l.id}');
    bool opened = false;
    try {
      opened = await launchUrl(uri, mode: LaunchMode.externalApplication);
    } catch (_) {
      opened = false;
    }
    Analytics.uiInteraction(
        'agent_talk_on_web_tap', DateTime.now().millisecondsSinceEpoch - startedMs,
        phase: 'interactive',
        extra: {'listing_id': l.id, 'agent_id': l.id, 'opened': opened});
    if (!opened && mounted) {
      showAdToast(context,
          message: uiCopy(UiMessage.m_could_not_open_the_browser_e13458cbf7));
    }
  }

  @override
  Widget build(BuildContext context) {
    UiLocaleScope.watch(context);
    if (loading)
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    if (error != null || detail == null) {
      return Scaffold(
          appBar: AppBar(),
          body: Center(
              child:
                  FilledButton(onPressed: _load, child: const UiText(UiMessage.m_retry_942087cc2d))));
    }
    final d = detail!;
    // [AGENT-LIVE-1 §2/§7] Fail closed while the flag is off, including for a
    // direct `/l/<id>` deep link that skips the browse row entirely — the
    // browse row isn't the only door into this screen.
    if (d.listing.kind == 'agent' && !RemoteConfig.agentListingsEnabled) {
      return Scaffold(
          backgroundColor: AD.bg,
          appBar: AppBar(
              backgroundColor: AD.bg,
              foregroundColor: AD.textPrimary,
              title: UiText(UiMessage.m_bazaar_12dfddb2d5, style: ADText.rowName())),
          body: Center(
              child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        PhosphorIcon(PhosphorIcons.microphone(PhosphorIconsStyle.regular),
                            size: 40, color: AD.textTertiary),
                        const SizedBox(height: 12),
                        UiText(UiMessage.m_this_ai_voice_agent_isn_e62d49925c,
                            textAlign: TextAlign.center, style: ADText.appTitle()),
                        const SizedBox(height: 8),
                        UiText(UiMessage.m_check_back_soon_d3bbb78857,
                            textAlign: TextAlign.center,
                            style: ADText.preview(c: AD.textTertiary)),
                      ]))));
    }
    return Scaffold(
      backgroundColor: AD.bg,
      appBar: AppBar(
        backgroundColor: AD.bg,
        foregroundColor: AD.textPrimary,
        title: UiText(UiMessage.m_bazaar_12dfddb2d5, style: ADText.rowName()),
        actions: [
          IconButton(
              onPressed: () => Share.share(
                  'See ${d.listing.title} on AvaTOK — https://avatok.ai/l/${d.listing.id}'),
              icon: PhosphorIcon(PhosphorIcons.shareNetwork(PhosphorIconsStyle.bold))),
          IconButton(
              onPressed: _toggleFavourite,
              icon: Icon(
                  d.listing.favorited ? PhosphorIcons.heart(PhosphorIconsStyle.fill) : PhosphorIcons.heart(PhosphorIconsStyle.regular),
                  color: d.listing.favorited ? AD.danger : AD.textPrimary)),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        child: LayoutBuilder(builder: (context, constraints) {
          final wide = constraints.maxWidth >= 760;
          final content = _content(d, wide, constraints.maxWidth);
          return ListView(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 48),
              children: [content]);
        }),
      ),
      bottomNavigationBar: SafeArea(
          child: Padding(
              padding: const EdgeInsets.all(12),
              // [AGENT-LIVE-1 D11] Agents never see the native booking CTA —
              // "Talk on the web" is the only affordance, same as the card.
              child: d.listing.kind == 'agent'
                  ? FilledButton.icon(
                      onPressed: () => _talkOnWeb(d.listing),
                      icon: PhosphorIcon(PhosphorIcons.globe(PhosphorIconsStyle.regular)),
                      label: const UiText(UiMessage.m_talk_on_the_web_3bc28c38e2))
                  : FilledButton.icon(
                      onPressed: d.booked || d.listing.canBook ? _openBooking : null,
                      icon: PhosphorIcon(PhosphorIcons.calendarCheck(PhosphorIconsStyle.bold)),
                      label: Text(d.booked
                          ? uiCopy(UiMessage.m_open_booking_58fc42ee5b)
                          : (d.listing.canBook ? _cta(d.listing) : _closedLabel(d.listing)))))),
    );
  }

  String _cta(ListingCard l) => l.status == 'live'
      ? uiCopy(UiMessage.m_book_join_now_19a439e3fe)
      : (l.freeEntry || l.effectivePrice == 0
          ? uiCopy(UiMessage.m_reserve_your_seat_e1b12c7929)
          : uiCopy(UiMessage.m_book_a_seat_value1_5b2a3b915f, {'value1': (l.priceLabel).toString()}));

  Widget _content(ListingDetail d, bool wide, double width) {
    final l = d.listing;
    final hero = _hero(l, width);
    final galleryUrls = _galleryUrls(l);
    final hasVideoHero = youTubeIdOf(l.videoUrl) != null;
    final summary = _summary(d);
    // [AGENT-LIVE-1 D11] Agents get their own read-only card — price + slot
    // chips + "Talk on the web" — never the native booking flow.
    final booking = l.kind == 'agent' ? _agentTalkCard(l) : _bookingCard(l);
    final body =
        Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      _ticker(l),
      hero,
      // [LIST-APP-PARITY-1] Gate on the FILTERED count. The old gate was
      // `coverMedia.length > 1` — two entries with one usable url built an empty
      // 88px strip. When the video OR the AI poster owns the hero, the creator's
      // photos have nowhere else to appear, so one photo is worth a strip;
      // otherwise the first photo is already the hero and one is a duplicate.
      if (galleryUrls.length > 1 ||
          ((hasVideoHero || l.hasAiPoster) && galleryUrls.isNotEmpty))
        _gallery(l, galleryUrls),
      _shareCard(l),
      summary,
      if (wide)
        Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Expanded(child: _sections(d)),
          const SizedBox(width: 16),
          SizedBox(width: 340, child: booking)
        ])
      else ...[_sections(d), booking],
      if (related.isNotEmpty) _related(),
    ]);
    return Center(
        child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 1180), child: body));
  }

  Widget _shareCard(ListingCard l) {
    final link = 'https://avatok.ai/l/${l.id}';
    return Card(
        color: AD.headerFooter,
        elevation: 0,
        shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(AD.rListCard),
            side: const BorderSide(color: AD.textPrimary, width: 2)),
        child: Padding(
            padding: const EdgeInsets.all(14),
            child: Row(children: [
              QrImageView(data: link, size: 78, backgroundColor: AD.card),
              const SizedBox(width: 14),
              Expanded(
                  child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                    const UiText(UiMessage.m_share_this_show_c8d4f289ce,
                        style: TextStyle(
                            color: Colors.white, fontWeight: FontWeight.w700)),
                    const SizedBox(height: 4),
                    const UiText(UiMessage.m_copy_the_link_or_scan_c7128b7983,
                        style: TextStyle(color: AD.card)),
                    const SizedBox(height: 8),
                    Wrap(spacing: 8, children: [
                      OutlinedButton(
                          onPressed: () {
                            Clipboard.setData(ClipboardData(text: link));
                            showAdToast(context, message: uiCopy(UiMessage.m_listing_link_copied_45b46a26fb));
                          },
                          child: const UiText(UiMessage.m_copy_link_7473b9adb7)),
                      OutlinedButton(
                          onPressed: () => Share.share('$link\n${l.title}'),
                          child: const UiText(UiMessage.m_share_0b060acf4d))
                    ])
                  ]))
            ])));
  }

  Widget _ticker(ListingCard l) {
    final state = l.scheduleState;
    final closed = l.isEnded || !l.canBook;
    final lead = l.status == 'live'
        ? uiCopy(UiMessage.m_live_now_value1_b5ea45acfc, {'value1': (l.title.toUpperCase()).toString()})
        : state == 'cancelled'
            ? uiCopy(UiMessage.m_this_show_was_cancelled_a7f06c1ed6)
            : (state == 'ended' || state == 'expired')
                ? uiCopy(UiMessage.m_this_show_has_ended_value1_e969918337, {'value1': (_when(l.startsAt, l.timezone)).toString()})
                : state == 'starting'
                    ? uiCopy(UiMessage.m_starting_now_host_is_getting_61e656daac)
                    : uiCopy(UiMessage.m_next_show_value1_18ada5d7f8, {'value1': (_when(l.startsAt, l.timezone)).toString()});
    final tail = l.status == 'live'
        ? uiCopy(UiMessage.m_join_now_d10d1ddc37)
        : closed
            ? uiCopy(UiMessage.m_closed_f6deab2b12)
            : uiCopy(UiMessage.m_book_ahead_ae26436941);
    return _tickerBar(l, lead, tail);
  }

  Widget _tickerBar(ListingCard l, String lead, String tail) => Container(
      margin: const EdgeInsets.only(bottom: 14),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      decoration: BoxDecoration(
          color: l.status == 'live'
              ? AD.danger
              : AD.headerFooter,
          borderRadius: BorderRadius.circular(AD.rListCard)),
      child: Row(children: [
        Container(width: 10, height: 10,
            decoration: BoxDecoration(shape: BoxShape.circle,
                color: l.status == 'live' ? AD.card : AD.bg)),
        const SizedBox(width: 8),
        Expanded(
            child: Text(lead,
            style: ADText.rowName(c: Colors.white))),
        Text(tail,
            style: ADText.rowName(c: Colors.white))
      ]));

  /// [LIST-APP-PARITY-1] The hero.
  ///
  /// THREE things were wrong here. (1) The listing's video was never read at
  /// all — zero references to `videoUrl` on this screen, though the wizard
  /// collects it and `ListingCard.videoUrl` has carried it for months. (2) The
  /// whole `[POSTER-FIRST-1]` system (`hasAiPoster`, `posterUrlForWidth`,
  /// `posterNeedsLettering`, `posterTitle`) was ignored in favour of a raw
  /// `coverUrl`. (3) The title was painted over the image unconditionally, so a
  /// poster that already carries painted lettering got it twice.
  ///
  /// The rule now: a video is CENTRE-STAGE and playable in place; with no video
  /// the poster owns the hero at the right width variant; `coverUrl` is the last
  /// fallback.
  Widget _hero(ListingCard l, double width) {
    final videoId = youTubeIdOf(l.videoUrl);
    return Container(
        decoration: BoxDecoration(
            color: AD.headerFooter,
            border: Border.all(color: AD.textPrimary, width: 3),
            borderRadius: BorderRadius.circular(AD.rHero),
            boxShadow: const [
              BoxShadow(color: AD.textPrimary, offset: Offset(5, 6))
            ]),
        clipBehavior: Clip.antiAlias,
        child: videoId == null
            ? SizedBox(height: 250, child: _imageHero(l, width))
            : AspectRatio(aspectRatio: 16 / 9, child: _videoHero(l, videoId)));
  }

  Widget _imageHero(ListingCard l, double width) {
    // `posterUrlForWidth` falls back to the portrait when the wider variants
    // were never generated, so this is safe on every listing published before
    // `posterVariantsEnabled`.
    final poster = l.hasAiPoster ? l.posterUrlForWidth(width) : null;
    final url = poster ?? l.coverUrl;
    // "overlay" means the artwork is deliberately textless because the model
    // could not be trusted to spell the title — the CLIENT draws it. A poster
    // that already carries its lettering must NOT have the title printed on top.
    final letterOverPoster = poster != null && l.posterNeedsLettering;
    final showTitle = poster == null || letterOverPoster;
    final heroTitle = letterOverPoster ? l.posterTitle : l.title;
    final heroTagline = letterOverPoster ? l.posterTagline : '';
    return Stack(fit: StackFit.expand, children: [
      if (url != null)
        CachedThumb(url: url, px: 1024,
            fit: BoxFit.cover, fallback: const SizedBox())
      else
        Center(
            child: Text(l.title.toUpperCase(),
                textAlign: TextAlign.center,
                style: const TextStyle(
                    fontFamily: ADText.display,
                    fontSize: 28,
                    fontWeight: FontWeight.w700,
                    color: Colors.white))),
      DecoratedBox(
          decoration: BoxDecoration(
              gradient: LinearGradient(
                  begin: Alignment.topCenter,
                  end: Alignment.bottomCenter,
                  colors: [AD.card.withOpacity(0), AD.scrim]))),
      if (showTitle)
        Positioned(
            left: 16,
            right: 16,
            bottom: 14,
            child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(heroTitle,
                      style: const TextStyle(
                          fontFamily: ADText.display,
                          color: Colors.white,
                          fontSize: 26,
                          fontWeight: FontWeight.w700)),
                  if (heroTagline.isNotEmpty)
                    Text(heroTagline,
                        style: const TextStyle(color: Colors.white, fontSize: 13)),
                ])),
      Positioned(
          top: 12,
          left: 12,
          child: _pill(
              l.status == 'live'
                  ? uiCopy(UiMessage.m_live_bdf810a849)
                  : l.isEnded
                      ? _closedLabel(l)
                      : (l.scheduleState == 'starting' ? uiCopy(UiMessage.m_starting_now_fee6eff1e3) : uiCopy(UiMessage.m_next_show_a7702ddcc2)),
              AD.danger)),
    ]);
  }

  /// A real inline player, using the `youtube_player_iframe` already pinned in
  /// `pubspec.yaml` and already shipping in chat (`YouTubeCard`). No new
  /// dependency: with no local toolchain, a bad pin costs a CI round trip.
  Widget _videoHero(ListingCard l, String videoId) {
    final controller = _ytController;
    if (controller != null) {
      return YoutubePlayer(controller: controller, aspectRatio: 16 / 9);
    }
    return GestureDetector(
        onTap: () => _playVideo(l, videoId),
        child: Stack(fit: StackFit.expand, alignment: Alignment.center, children: [
          CachedThumb(
              url: 'https://img.youtube.com/vi/$videoId/hqdefault.jpg',
              px: 720,
              fallback: const ColoredBox(color: AD.headerFooter)),
          DecoratedBox(
              decoration: BoxDecoration(
                  gradient: LinearGradient(
                      begin: Alignment.topCenter,
                      end: Alignment.bottomCenter,
                      colors: [AD.card.withOpacity(0), AD.scrim]))),
          Center(
              child: Container(
                  width: 64,
                  height: 64,
                  alignment: Alignment.center,
                  decoration:
                      const BoxDecoration(color: AD.danger, shape: BoxShape.circle),
                  child: PhosphorIcon(PhosphorIcons.play(PhosphorIconsStyle.fill),
                      color: Colors.white, size: 30))),
          Positioned(
              left: 16,
              right: 16,
              bottom: 14,
              child: Text(l.title,
                  style: const TextStyle(
                      fontFamily: ADText.display,
                      color: Colors.white,
                      fontSize: 26,
                      fontWeight: FontWeight.w700))),
        ]));
  }

  void _playVideo(ListingCard l, String videoId) {
    setState(() {
      _ytController = YoutubePlayerController.fromVideoId(
        videoId: videoId,
        autoPlay: true,
        params: const YoutubePlayerParams(
          showControls: true,
          showFullscreenButton: true,
          enableCaption: true,
        ),
      );
    });
    Analytics.capture('listing_video_play', {
      'listing_id': l.id,
      'video_id': videoId,
      'surface': 'detail_hero',
      'outcome': 'started',
    });
  }

  /// The creator's photos, filtered BEFORE anything counts them.
  ///
  /// The AI poster is prepended to `cover_media` by the worker as a
  /// `source: 'ai_poster'` entry — it belongs on cards, not in the creator's own
  /// photo strip, so it is excluded here.
  List<String> _galleryUrls(ListingCard l) => l.coverMedia
      .whereType<Map>()
      .where((m) => m['source'] != 'ai_poster')
      .map((m) => (m['url'] ?? m['r2_key'])?.toString())
      .whereType<String>()
      .where((u) => u.startsWith('http'))
      .take(12)
      .toList();

  Widget _gallery(ListingCard l, List<String> urls) => SizedBox(
      height: 88,
      child: ListView.separated(
          padding: const EdgeInsets.symmetric(vertical: 10),
          scrollDirection: Axis.horizontal,
          itemCount: urls.length,
          separatorBuilder: (_, __) => const SizedBox(width: 8),
          itemBuilder: (_, i) => GestureDetector(
              onTap: () => _openGallery(l, urls, i),
              child: ClipRRect(
                  borderRadius: BorderRadius.circular(AD.rImage),
                  child: CachedThumb(url: urls[i], px: 256,
                      width: 110,
                      fit: BoxFit.cover,
                      // A dead url degrades to a marked tile, never to a blank
                      // one that reads as a broken layout.
                      fallback: Container(
                          width: 110,
                          alignment: Alignment.center,
                          color: AD.cardHover,
                          child: PhosphorIcon(
                              PhosphorIcons.imageBroken(PhosphorIconsStyle.regular),
                              color: AD.textTertiary)))))));

  void _openGallery(ListingCard l, List<String> urls, int index) {
    Analytics.capture('listing_gallery_opened', {
      'listing_id': l.id,
      'photo_index': index,
      'photo_count': urls.length,
      'outcome': 'opened',
    });
    Navigator.of(context).push(MaterialPageRoute(
        fullscreenDialog: true,
        builder: (_) => _FullScreenGallery(urls: urls, initialIndex: index)));
  }

  Widget _summary(ListingDetail d) {
    final l = d.listing;
    final badges = <String>[
      if (l.ratingAvg != null)
        '★ ${l.ratingAvg!.toStringAsFixed(1)} · ${l.ratingCount} RATINGS',
      if (l.durationMin != null) '${l.durationMin} MIN',
      if (l.mediaMode == 'audio_only') '🎧 AUDIO ONLY' else '🎥 AUDIO + VIDEO',
      l.kind == 'agent' ? '⚙ AI VOICE AGENT' : '✓ REAL HUMAN'
    ];
    return Padding(
        padding: const EdgeInsets.fromLTRB(2, 20, 2, 20),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          // [LIST-LABEL-1 2026-09-14] `category` is an ID, not a label. This
          // eyebrow printed it raw, so the buyer page for the new Puja category
          // read "LIVE_PUJA_RITUAL" where "PUJA" belongs.
          Text(listingCategoryLabel(l.category).toUpperCase(),
              style: ADText.sectionLabel(c: AD.textTertiary)),
          const SizedBox(height: 6),
          Text(l.title,
              style: const TextStyle(
                  fontFamily: ADText.display,
                  fontSize: 34,
                  height: 1,
                  fontWeight: FontWeight.w700,
                  color: AD.textPrimary)),
          const SizedBox(height: 10),
          Wrap(
              spacing: 7,
              runSpacing: 7,
              children: badges
                  .map((x) => _pill(x, AD.cardHover, dark: true))
                  .toList()),
          if ((l.description ?? l.blurb ?? l.oneLiner).isNotEmpty)
            Padding(
                padding: const EdgeInsets.only(top: 14),
                child: Text(l.description ?? l.blurb ?? l.oneLiner,
                    style: const TextStyle(
                        fontSize: 16, height: 1.45, color: AD.textPrimary))),
          const SizedBox(height: 12),
          Row(children: [
            CachedThumb(url: 'https://avatok.ai/assets/desi-swag.png', px: 128,fit: BoxFit.contain,
                width: 62,
                height: 62,
                fallback: const SizedBox()),
            const Expanded(
                child: UiText(UiMessage.m_jo_jeeta_wahi_asli_scene_2a06a8c2b2,
                    style: TextStyle(
                        fontStyle: FontStyle.italic,
                        color: AD.textTertiary))),
            CachedThumb(url: 'https://avatok.ai/assets/luv-it-sticker.png', px: 128,fit: BoxFit.contain,
                width: 58,
                height: 58,
                fallback: const SizedBox()),
          ]),
          const SizedBox(height: 16),
          _stats(d)
        ]));
  }

  Widget _stats(ListingDetail d) {
    final l = d.listing;
    return Container(
        padding: const EdgeInsets.symmetric(vertical: 14),
        decoration: const BoxDecoration(
            border: Border.symmetric(
                horizontal: BorderSide(color: AD.textTertiary, width: 1))),
        child: Row(mainAxisAlignment: MainAxisAlignment.spaceAround, children: [
          _stat('${l.joinedCount}', 'BOOKED'),
          // [LIST-APP-PARITY-2] This was labelled FAVOURITES and showed
          // `ratingCount` — there is no favourite count on the wire at all, so
          // the number under it was simply the wrong number. It is labelled what
          // it is; a real favourites count needs a server field first.
          _stat('${l.ratingCount}', 'RATINGS'),
          _stat('${creator?.listings.length ?? 1}', 'SHOWS LISTED'),
          _stat('${d.creatorRating?.toStringAsFixed(1) ?? '—'}', 'HOST RATING')
        ]));
  }

  Widget _stat(String value, String label) => Column(children: [
        Text(value,
            style: const TextStyle(fontFamily: ADText.display, fontSize: 22, fontWeight: FontWeight.w700)),
        Text(label, style: ADText.sectionLabel(c: AD.textTertiary))
      ]);
  Widget _pill(String text, Color color, {bool dark = false}) => Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration:
          BoxDecoration(color: color, borderRadius: BorderRadius.circular(99)),
      child: Text(text,
          style: TextStyle(
              fontSize: 11,
              fontWeight: FontWeight.w700,
              letterSpacing: .3,
              color: dark ? AD.textPrimary : Colors.white)));

  Widget _bookingCard(ListingCard l) => Card(
      color: AD.card,
      elevation: 0,
      shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AD.rSheet),
          side: const BorderSide(color: AD.textPrimary, width: 2.5)),
      child: Padding(
          padding: const EdgeInsets.all(18),
          child:
              Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            UiText(UiMessage.m_book_a_seat_886ff338a6, style: ADText.appTitle()),
            const SizedBox(height: 4),
            Text(
                l.freeEntry || l.effectivePrice == 0
                    ? uiCopy(UiMessage.m_free_19f1fa5ec9)
                    : uiCopy(UiMessage.m_value1_seat_8d3e232b1a, {'value1': (l.priceLabel).toString()}),
                style:
                    const TextStyle(fontFamily: ADText.display, fontSize: 20, fontWeight: FontWeight.w700)),
            const SizedBox(height: 14),
            Text(
                !l.canBook
                    ? (l.scheduleState == 'cancelled'
                        ? uiCopy(UiMessage.m_this_show_was_cancelled_everyone_fc57ead691)
                        : (l.isEnded
                            ? uiCopy(UiMessage.m_this_show_has_ended_if_bdebfc5186)
                            : uiCopy(UiMessage.m_the_show_has_already_started_e1619d65cc)))
                    : l.status == 'live'
                        ? uiCopy(UiMessage.m_book_and_join_instantly_163ef13a5e)
                        : uiCopy(UiMessage.m_choose_your_slot_and_confirm_c41741b1a7),
                style: ADText.preview()),
            const SizedBox(height: 16),
            FilledButton(
                onPressed: l.canBook || (detail?.booked ?? false) ? _openBooking : null,
                child: Text(!l.canBook
                    ? ((detail?.booked ?? false) ? uiCopy(UiMessage.m_open_booking_58fc42ee5b) : _closedLabel(l))
                    : l.status == 'live'
                        ? uiCopy(UiMessage.m_book_join_now_19a439e3fe)
                        : uiCopy(UiMessage.m_choose_date_time_8a744aaa5a))),
            const SizedBox(height: 8),
            UiText(UiMessage.m_no_hidden_fees_policy_shown_147e999f68,
                textAlign: TextAlign.center,
                style: ADText.sectionLabel(c: AD.textTertiary))
          ])));

  /// [AGENT-LIVE-1 D1/D11] The `kind=='agent'` replacement for [_bookingCard]:
  /// price-per-minute + read-only slot chips + one CTA that hands off to the
  /// web. No hold, no quote, no in-app checkout sheet — the app never starts
  /// an agent session.
  Widget _agentTalkCard(ListingCard l) => Card(
      color: AD.card,
      elevation: 0,
      shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AD.rSheet),
          side: const BorderSide(color: AD.textPrimary, width: 2.5)),
      child: Padding(
          padding: const EdgeInsets.all(18),
          child:
              Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            UiText(UiMessage.m_talk_to_the_agent_d3c574a7fa, style: ADText.appTitle()),
            const SizedBox(height: 4),
            UiText(UiMessage.m_from_value1_min_23e7e8e5b5, params: {'value1': (l.money(l.price)).toString()},
                style: const TextStyle(
                    fontFamily: ADText.display, fontSize: 20, fontWeight: FontWeight.w700)),
            const SizedBox(height: 14),
            UiText(UiMessage.m_available_session_lengths_28dc2ef2aa, style: ADText.sectionLabel(c: AD.textTertiary)),
            const SizedBox(height: 8),
            Wrap(
                spacing: 7,
                runSpacing: 7,
                children: [
                  for (final m in _agentSlotMinutes(l)) _pill('$m MIN', AD.cardHover, dark: true)
                ]),
            const SizedBox(height: 16),
            FilledButton.icon(
                onPressed: () => _talkOnWeb(l),
                icon: PhosphorIcon(PhosphorIcons.globe(PhosphorIconsStyle.regular)),
                label: const UiText(UiMessage.m_talk_on_the_web_3bc28c38e2)),
            const SizedBox(height: 8),
            UiText(UiMessage.m_booking_payment_and_the_call_2f6e21ec46,
                textAlign: TextAlign.center,
                style: ADText.sectionLabel(c: AD.textTertiary))
          ])));

  Widget _sections(ListingDetail d) =>
      Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        _section('HOW THE SHOW WORKS.', _howItWorks(d.listing)),
        _extras(d.listing),
        _host(d),
        _rules(d.listing),
        _reviews(d),
        _trust()
      ]);
  Widget _section(String title, Widget child) => Padding(
      padding: const EdgeInsets.only(bottom: 24),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(title,
            style: const TextStyle(fontFamily: ADText.display, fontSize: 22, fontWeight: FontWeight.w700)),
        const SizedBox(height: 10),
        child
      ]));
  /// [LIST-APP-PARITY-1] `'$steps[i]'` printed the WHOLE list's `toString()`
  /// followed by a literal `[i]` — Dart's bare-identifier interpolation stops at
  /// the identifier. Unpacked properly through [_pairHeading]/[_pairBody] now,
  /// which `_rules` shares.
  Widget _howItWorks(ListingCard l) {
    final raw = l.attrs['content_how_it_works'];
    final steps = raw is List ? raw : const [];
    return steps.isEmpty
        ? _infoCard(
            'Pick a time, review the host rules, then join from your booking confirmation.')
        : Column(children: [
            for (var i = 0; i < steps.length; i++)
              _infoCard(
                  'STEP ${i + 1} · ${_pairHeading(steps[i], 'label', 'YOUR SESSION')}',
                  body: _pairBody(steps[i], 'body'))
          ]);
  }

  /// The server stores every `content_*` object list as `{heading|label|q, body|a}`
  /// (contentAttrsError, worker/src/routes/listings.ts:439). A plain string is
  /// tolerated as the heading — some older rows hold one.
  static String _pairHeading(dynamic row, String key, String fallback) {
    final value = row is Map
        ? (row[key] ?? '').toString().trim()
        : row.toString().trim();
    return value.isEmpty ? fallback : value;
  }

  static String? _pairBody(dynamic row, String key) {
    if (row is! Map) return null;
    final value = (row[key] ?? '').toString().trim();
    return value.isEmpty ? null : value;
  }

  Widget _infoCard(String title, {String? body}) => Container(
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
          color: AD.card,
          border: Border.all(color: AD.textPrimary, width: 1.5),
          borderRadius: BorderRadius.circular(AD.rListCard)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(title, style: ADText.rowName()),
        if (body != null)
          Padding(
              padding: const EdgeInsets.only(top: 5),
              child: Text(body, style: ADText.preview()))
      ]));

  /// Every `content_*` list is stored as plain strings (listings.ts:439) —
  /// anything else in the row is dropped rather than printed as a Dart literal.
  static List<String> _stringList(dynamic value) => value is List
      ? value
          .map((v) => (v ?? '').toString().trim())
          .where((v) => v.isNotEmpty)
          .toList()
      : const <String>[];

  /// [LIST-APP-PARITY-2 2026-09-14] Everything the wizard collects that this
  /// page never showed.
  ///
  /// `spoken_lang`, `content_what_you_get`, `content_who_for`,
  /// `content_not_for`, `content_faq` and `join_requirements` are all on the web
  /// buyer page (`web/src/components/ListingDetailView.astro`) and none of them
  /// were here — the wizard makes a creator write at least three FAQ entries and
  /// pick their languages, and an app buyer was shown neither. Every section
  /// disappears when its field is empty, so a listing that carries none of them
  /// renders exactly as it did before.
  Widget _extras(ListingCard l) {
    final langs = (l.spokenLang ?? '')
        .split(',')
        .map((s) => s.trim())
        .where((s) => s.isNotEmpty)
        .toList();
    final whatGet = _stringList(l.attrs['content_what_you_get']);
    final whoFor = _stringList(l.attrs['content_who_for']);
    final notFor = _stringList(l.attrs['content_not_for']);
    final rawFaq = l.attrs['content_faq'];
    final faq = rawFaq is List ? rawFaq : const [];
    final rawJoin = l.attrs['join_requirements'];
    final join = rawJoin is Map
        ? [
            for (final e in kJoinRequirementLabels.entries)
              if (rawJoin[e.key] == true) e.value
          ]
        : const <String>[];
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      if (whatGet.isNotEmpty)
        _section('WHAT YOU GET.',
            Column(children: [for (final line in whatGet) _infoCard(line)])),
      if (whoFor.isNotEmpty || notFor.isNotEmpty)
        _section(
            'WHO IT IS FOR.',
            Column(children: [
              for (final line in whoFor) _infoCard('FOR YOU IF', body: line),
              for (final line in notFor) _infoCard('NOT FOR YOU IF', body: line),
            ])),
      if (langs.isNotEmpty || join.isNotEmpty)
        _section(
            'GOOD TO KNOW.',
            Wrap(spacing: 7, runSpacing: 7, children: [
              for (final lang in langs)
                _pill(lang.toUpperCase(), AD.cardHover, dark: true),
              for (final need in join) _pill(need, AD.cardHover, dark: true),
            ])),
      if (faq.isNotEmpty)
        _section(
            'COMMON QUESTIONS.',
            Column(children: [
              for (final row in faq)
                _infoCard(_pairHeading(row, 'q', 'QUESTION'),
                    body: _pairBody(row, 'a'))
            ])),
    ]);
  }

  Widget _host(ListingDetail d) {
    final c = creator;
    final l = d.listing;
    final name = c?.name ?? l.creator.name ?? l.creator.handle ?? uiCopy(UiMessage.m_host_4a823118b9);
    return _section(
        'MEET THE HOST.',
        Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          // [LIST-APP-PARITY-1] An unconditional `_infoCard('', body: null)`
          // used to sit here: an always-empty bordered box above every host.
          Row(children: [
            Avatar(
                seed: l.creator.uid,
                name: name,
                avatarUrl: c?.avatarUrl ?? l.creator.avatarUrl,
                size: 64),
            const SizedBox(width: 12),
            Expanded(
                child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                  Text(name,
                      style: const TextStyle(
                          fontWeight: FontWeight.w700, fontSize: 18)),
                  UiText(
                      UiMessage.m_value1_host_rating_value2_followers_ee50b3fc84, params: {'value1': (d.creatorRating?.toStringAsFixed(1) ?? '—').toString(), 'value2': (d.followerCount).toString()},
                      style: ADText.preview()),
                  if (l.creator.kycVerified)
                    const UiText(UiMessage.m_id_verified_1d7a10662e,
                        style: TextStyle(
                            color: AD.headerFooter,
                            fontWeight: FontWeight.w700))
                ]))
          ]),
          if ((c?.bio ?? '').isNotEmpty)
            Padding(
                padding: const EdgeInsets.only(top: 12),
                child: Text(c!.bio!, style: ADText.preview())),
          TextButton.icon(
              onPressed: () => Navigator.push(
                  context,
                  MaterialPageRoute(
                      builder: (_) =>
                          CreatorChannelScreen(creatorUid: l.creator.uid))),
              icon: PhosphorIcon(PhosphorIcons.envelope(PhosphorIconsStyle.bold)),
              label: UiText(UiMessage.m_message_value1_66a662c4f0, params: {'value1': (name.split(' ').first).toString()})),
          if (c != null && c.listings.isNotEmpty)
            Padding(
                padding: const EdgeInsets.only(top: 12),
                child: UiText(UiMessage.m_also_listed_by_value1_f3d4d0d087, params: {'value1': (name.toUpperCase()).toString()},
                    style: ADText.sectionLabel()))
        ]));
  }

  /// [LIST-APP-PARITY-1] House rules.
  ///
  /// This read `attrs['rules']` — a key nothing writes. The wizard writes, and
  /// the server validates, `content_house_rules`: a list of `{heading, body}`
  /// objects (listings.ts:503). So EVERY custom house rule a creator wrote was
  /// invisible and every listing showed the same generic fallback; and even
  /// with the key fixed, `'${rules[i]}'` would have printed a raw Dart map.
  /// The fallback below is now reached only when the creator truly wrote none.
  Widget _rules(ListingCard l) {
    final raw = l.attrs['content_house_rules'];
    final rules = raw is List ? raw : const [];
    if (rules.isEmpty)
      return _section(
          'HOUSE RULES.',
          _infoCard(
              'Respect the host and other attendees. No harassment, hate, or recording without consent.'));
    return _section(
        'HOUSE RULES.',
        Column(children: [
          for (var i = 0; i < rules.length; i++)
            _infoCard(
                '${i + 1}. ${_pairHeading(rules[i], 'heading', 'HOUSE RULE')}',
                body: _pairBody(rules[i], 'body'))
        ]));
  }

  Widget _reviews(ListingDetail d) => _section(
      'PUBLIC KI RAI.',
      Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        _infoCard(
            '${d.creatorRating?.toStringAsFixed(1) ?? '—'} / 5 · ${d.reviews.length} VERIFIED REVIEWS'),
        for (final r in d.reviews.take(5)) _review(r)
      ]));

  Widget _trust() => _section(
      'SEEDHI BAAT, NO CHAKKAR.',
      GridView.count(
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          crossAxisCount: 2,
          childAspectRatio: 1.45,
          crossAxisSpacing: 8,
          mainAxisSpacing: 8,
          children: const [
            _TrustTile(
                'FULL PRICE UPFRONT', 'Fees and GST are shown before booking.'),
            _TrustTile('CANCEL = REFUND',
                'Cancellation follows the policy shown before payment.'),
            _TrustTile('REAL SEATS', 'Availability comes from live inventory.'),
            _TrustTile('HUMAN OR AI', 'The host type is clearly labelled.'),
            _TrustTile(
                'RECORDING OFF', 'Recording is off unless people consent.'),
            _TrustTile(
                'MODERATED ROOM', 'Report bad behaviour from every session.'),
          ]));
  Widget _review(ListingReview r) => Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(vertical: 10),
      decoration: const BoxDecoration(
          border: Border(bottom: BorderSide(color: AD.borderHairline))),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('★' * r.rating, style: TextStyle(color: AD.danger)),
        const SizedBox(width: 8),
        Expanded(
            child:
                Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(r.body.isEmpty ? uiCopy(UiMessage.m_verified_booking_11377bc800) : r.body,
              style: ADText.preview()),
          Text(r.authorName ?? uiCopy(UiMessage.m_avatok_member_765f09f39c),
              style: ADText.sectionLabel(c: AD.textTertiary))
        ]))
      ]));
  Widget _related() => _section(
        'BROWSE MORE EVENTS.',
        SizedBox(
          height: 160,
          child: ListView.separated(
            scrollDirection: Axis.horizontal,
            itemCount: related.length,
            separatorBuilder: (_, __) => const SizedBox(width: 10),
            itemBuilder: (_, i) {
              final l = related[i];
              return SizedBox(
                width: 190,
                child: InkWell(
                  onTap: () => Navigator.pushReplacement(
                    context,
                    MaterialPageRoute(
                        builder: (_) => NativeListingDetailV2(listingId: l.id)),
                  ),
                  child: Card(
                    color: AD.card,
                    child: Padding(
                      padding: const EdgeInsets.all(10),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Expanded(
                            child: l.coverUrl == null
                                ? ColoredBox(color: AD.headerFooter)
                                : ClipRRect(
                                    borderRadius: BorderRadius.circular(AD.rImage),
                                    child: CachedThumb(url: l.coverUrl!, px: 256,fallback: const SizedBox(),
                                        width: double.infinity, fit: BoxFit.cover),
                                  ),
                          ),
                          const SizedBox(height: 7),
                          Text(l.title,
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                              style: ADText.rowName()),
                          Text(l.displayPrice, style: ADText.sectionLabel()),
                        ],
                      ),
                    ),
                  ),
                ),
              );
            },
          ),
        ),
      );
}

/// [LIST-APP-PARITY-1] Tapping a gallery thumbnail opens this: the photos at
/// full size, swipeable and pinch-zoomable. Before, a thumbnail did nothing.
class _FullScreenGallery extends StatefulWidget {
  const _FullScreenGallery({required this.urls, required this.initialIndex});
  final List<String> urls;
  final int initialIndex;

  @override
  State<_FullScreenGallery> createState() => _FullScreenGalleryState();
}

class _FullScreenGalleryState extends State<_FullScreenGallery> {
  late final PageController _pages =
      PageController(initialPage: widget.initialIndex);
  late int _index = widget.initialIndex;

  @override
  void dispose() {
    _pages.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) { UiLocaleScope.watch(context); return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
          backgroundColor: Colors.black,
          foregroundColor: Colors.white,
          title: Text('${_index + 1} / ${widget.urls.length}',
              style: const TextStyle(color: Colors.white))),
      body: PageView.builder(
          controller: _pages,
          itemCount: widget.urls.length,
          onPageChanged: (i) => setState(() => _index = i),
          itemBuilder: (_, i) => InteractiveViewer(
              minScale: 1,
              maxScale: 4,
              child: Center(
                  child: CachedThumb(url: widget.urls[i], px: 1600,
                      fit: BoxFit.contain,
                      fallback: PhosphorIcon(
                          PhosphorIcons.imageBroken(PhosphorIconsStyle.regular),
                          color: Colors.white,
                          size: 48)))))); }
}

class _TrustTile extends StatelessWidget {
  const _TrustTile(this.title, this.body);
  final String title;
  final String body;

  @override
  Widget build(BuildContext context) { UiLocaleScope.watch(context); return Container(
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
          color: AD.cardHover,
          borderRadius: BorderRadius.circular(AD.rListCard),
          border: Border.all(color: AD.textPrimary)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(title,
            style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w700)),
        const SizedBox(height: 4),
        Text(body, style: const TextStyle(fontSize: 11, height: 1.2))
      ])); }
}

/// Kept as a small, native preview adapter for the listing editor. It is not
/// the details page and shares no implementation with the removed legacy view.
class NativeListingPreview extends StatelessWidget {
  const NativeListingPreview({super.key, required this.card});
  final ListingCard card;
  @override
  Widget build(BuildContext context) { UiLocaleScope.watch(context); return Card(
      child: ListTile(
          leading: SizedBox(
              width: 64,
              child: card.coverUrl == null
                  ? ColoredBox(color: AD.headerFooter)
                  : ClipRRect(
                      borderRadius: BorderRadius.circular(AD.rImage),
                      child: CachedThumb(url: card.coverUrl!, px: 256,fallback: const SizedBox(), fit: BoxFit.cover))),
          title: Text(card.title),
          subtitle: Text(card.displayPrice))); }
}
