import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../data/api_exception.dart';
import '../../data/call_flags.dart';
import '../../data/models/booking.dart';
import '../../data/models/merch.dart';
import '../../data/models/reel.dart';
import '../../data/repos/bookings_repo.dart';
import '../../data/repos/channel_repo.dart';
import '../../data/services.dart';
import '../../ui/async_view.dart';
import '../../ui/net_image.dart';
import '../bag_kit.dart';
import '../channel_pop_kit.dart';
import '../data.dart';
import '../merch_kit.dart';
import '../reel_player.dart';
import '../reel_viewer.dart';
import '../theme.dart';
import '../widgets.dart';

/// [HF-CHANNEL-APP-1] The sections of the influencer channel page, built to the owner-approved phone mock PhoneChannel
/// (.agent-wt/mock/PhoneChannel.dc.html): Merch, Now Showing (videos), Book a time, About and Before you call.

// ================================================================================================ merch

/// "{Name}'s drop": category chips, a two-column grid of tiles with + Add, and "Show more (N)". Four tiles first (decision D4).
class ChannelMerchSection extends StatefulWidget {
  const ChannelMerchSection({super.key, required this.shop, required this.hostSlug, required this.firstName});

  final ChannelShop shop;
  final String hostSlug;
  final String firstName;

  @override
  State<ChannelMerchSection> createState() => _ChannelMerchSectionState();
}

class _ChannelMerchSectionState extends State<ChannelMerchSection> {
  static const int _firstPage = 4;
  static const int _step = 8;

  String _cat = '';
  int _shown = _firstPage;

  /// Slug, label and count of each category present, in the order they first appear.
  List<(String, String, int)> get _cats {
    final order = <String>[];
    final labels = <String, String>{};
    final counts = <String, int>{};
    for (final it in widget.shop.items) {
      if (it.category.isEmpty) continue;
      if (!counts.containsKey(it.category)) {
        order.add(it.category);
        labels[it.category] = it.categoryLabel.isEmpty ? it.category : it.categoryLabel;
      }
      counts[it.category] = (counts[it.category] ?? 0) + 1;
    }
    return [for (final c in order) (c, labels[c] ?? c, counts[c] ?? 0)];
  }

  void _pick(String slug, int count) {
    if (_cat == slug) return;
    setState(() {
      _cat = slug;
      _shown = _firstPage;
    });
    channelEvent('merch_filter_used', {'category': slug.isEmpty ? 'all' : slug, 'count': count, 'surface': 'app'});
  }

  String _priceText(PublicProduct p) {
    final prices = {for (final s in p.sizes) s.pricePaise};
    final from = merchRupees(p.fromPaise);
    return prices.length > 1 ? 'from $from' : from;
  }

  Future<void> _add(ChannelProduct it) async {
    final line = bagLineFor(host: widget.shop.host, hostSlug: widget.hostSlug, product: it.product, category: it.category);
    if (line == null) {
      toast(context, 'Sold out for now.');
      return;
    }
    await addLineToBag(context, line, surface: 'channel');
  }

  Widget _card(ChannelProduct it) {
    final p = it.product;
    return GpProductCard(
      title: p.title,
      categoryLabel: it.categoryLabel,
      categorySlug: it.category,
      priceText: _priceText(p),
      imageUrl: p.imageUrl,
      onTap: () => unawaited(context.push<Object?>('/merch/p/${Uri.encodeComponent(widget.hostSlug)}/${Uri.encodeComponent(p.slug)}', extra: it)),
      soldOut: p.sizes.isNotEmpty && !p.sizes.any((s) => s.inStock),
      onAdd: () => unawaited(_add(it)),
    );
  }

  @override
  Widget build(BuildContext context) {
    final all = widget.shop.items;
    final cats = _cats;
    final visible = _cat.isEmpty ? all : [for (final i in all) if (i.category == _cat) i];
    final shown = visible.take(_shown).toList();
    final more = visible.length - shown.length;
    final first = widget.firstName;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 44, 16, 44),
      child: Column(children: [
        GpSectionHead(
          eyebrow: 'The merch shop',
          title: TextSpan(
            style: t(32, color: GP.ink, w: FontWeight.w900, h: 1.05),
            children: [TextSpan(text: first.isEmpty ? 'The ' : '${first}’s '), gpPaintedSpan('drop', 32)],
          ),
          sub: 'Printed to order for you. Price includes GST and free delivery across India.',
          sticker: const GpSticker('Fan merch, no cap.', angle: -0.04),
        ),
        const SizedBox(height: 12),
        if (cats.length > 1) ...[
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(children: [
              Padding(padding: const EdgeInsets.only(right: 8), child: GpChip('All ${all.length}', on: _cat.isEmpty, onTap: () => _pick('', all.length))),
              for (final c in cats) Padding(padding: const EdgeInsets.only(right: 8), child: GpChip('${c.$2} ${c.$3}', on: _cat == c.$1, onTap: () => _pick(c.$1, c.$3))),
            ]),
          ),
          const SizedBox(height: 16),
        ],
        for (var i = 0; i < shown.length; i += 2)
          Padding(
            padding: const EdgeInsets.only(bottom: 18),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Expanded(child: _card(shown[i])),
              const SizedBox(width: 14),
              Expanded(child: i + 1 < shown.length ? _card(shown[i + 1]) : const SizedBox.shrink()),
            ]),
          ),
        if (more > 0) SizedBox(width: double.infinity, child: GpButton('Show more ($more)', kind: GpBtn.outline, onTap: () => setState(() => _shown += _step))),
      ]),
    );
  }
}

// ================================================================================================ videos

/// Shown in place of the merch section when the shop is on but this influencer has not put anything up yet.
class ChannelMerchEmpty extends StatelessWidget {
  const ChannelMerchEmpty({super.key, required this.firstName});

  final String firstName;

  @override
  Widget build(BuildContext context) {
    final who = firstName.isEmpty ? 'This influencer' : firstName;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 36, 16, 36),
      child: Column(children: [
        Image.asset('assets/channel/empty-merch.webp', height: 180, fit: BoxFit.contain, semanticLabel: 'No merch yet'),
        const SizedBox(height: 12),
        Text('$who has no merch yet', textAlign: TextAlign.center, style: t(22, color: GP.ink, w: FontWeight.w900, h: 1.15)),
        const SizedBox(height: 4),
        Text('Check back soon.', textAlign: TextAlign.center, style: t(16, color: GP.muted, w: FontWeight.w700)),
      ]),
    );
  }
}

/// "Now Showing": the first video plays right here (the official YouTube / Instagram embed, never a file we hold), the rest
/// are a row of tiles that open the full-screen viewer. Not built at all when the influencer has no videos.
class ChannelVideosSection extends StatefulWidget {
  const ChannelVideosSection({super.key, required this.reels});

  final List<FeedReel> reels;

  @override
  State<ChannelVideosSection> createState() => _ChannelVideosSectionState();
}

class _ChannelVideosSectionState extends State<ChannelVideosSection> {
  bool _playing = false;

  static const List<List<Color>> _washes = [
    [GP.yel, GP.red],
    [GP.blueSoft, GP.blue],
    [GP.raniTint, GP.rani],
    [GP.mari, GP.ink],
  ];

  String _platformLabel(FeedReel r) => r.platform == 'instagram' ? 'Insta' : 'YouTube';

  void _play(FeedReel r) {
    if (_playing) return;
    setState(() => _playing = true);
    channelEvent('channel_video_played', {'platform': r.platform, 'reel_id': r.id, 'surface': 'app'});
  }

  Widget _wash(int i) => DecoratedBox(
        decoration: BoxDecoration(gradient: LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: _washes[i % _washes.length])),
      );

  Widget _poster(FeedReel r) {
    final thumb = r.thumbUrl;
    return Stack(fit: StackFit.expand, children: [
      thumb == null
          ? const DecoratedBox(decoration: BoxDecoration(gradient: LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [GP.blue, GP.rani, GP.mari])))
          : NetImage(thumb, fit: BoxFit.cover, fallback: const ColoredBox(color: GP.blue)),
      Center(
        child: Container(
          width: 72,
          height: 72,
          decoration: const BoxDecoration(color: GP.paper, shape: BoxShape.circle),
          child: const Icon(Icons.play_arrow_rounded, size: 44, color: GP.ink),
        ),
      ),
    ]);
  }

  @override
  Widget build(BuildContext context) {
    final reels = widget.reels;
    if (reels.isEmpty) return const SizedBox.shrink();
    final r = reels.first;
    final ig = r.platform == 'instagram';
    final rest = reels.skip(1).take(9).toList();
    return DecoratedBox(
      decoration: const BoxDecoration(
        color: GP.ink,
        image: DecorationImage(image: AssetImage('assets/channel/now-showing-bg.webp'), fit: BoxFit.cover),
      ),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 44, 16, 44),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          GpSectionHead(
            dark: true,
            eyebrow: 'Videos',
            titleWidget: FittedBox(fit: BoxFit.scaleDown, child: Text('Now Showing', style: gpPoster(54))),
            sticker: const GpSticker('POV: you found your fav creator', tone: GpStickerTone.blue),
          ),
          const SizedBox(height: 14),
          ClipRRect(
            borderRadius: BorderRadius.circular(24),
            child: AspectRatio(
              aspectRatio: ig ? 4 / 5 : 16 / 9,
              child: _playing
                  ? ReelPlayer(key: ValueKey('inline-${r.id}'), reel: r, active: true)
                  : Semantics(
                      key: ValueKey('video-${r.id}'),
                      button: true,
                      label: 'Play video${r.caption.isEmpty ? '' : ': ${r.caption}'}',
                      child: GestureDetector(behavior: HitTestBehavior.opaque, onTap: () => _play(r), child: _poster(r)),
                    ),
            ),
          ),
          if (r.caption.isNotEmpty) ...[
            const SizedBox(height: 10),
            Text(r.caption, maxLines: 2, overflow: TextOverflow.ellipsis, style: t(16, color: GP.paper, w: FontWeight.w900)),
          ],
          if (rest.isNotEmpty) ...[
            const SizedBox(height: 18),
            GridView.count(
              crossAxisCount: 3,
              mainAxisSpacing: 10,
              crossAxisSpacing: 10,
              childAspectRatio: 9 / 16,
              shrinkWrap: true,
              physics: const NeverScrollableScrollPhysics(),
              children: [
                for (var i = 0; i < rest.length; i++)
                  Semantics(
                    key: ValueKey('video-${rest[i].id}'),
                    button: true,
                    label: 'Watch video ${i + 2}',
                    child: GestureDetector(
                      behavior: HitTestBehavior.opaque,
                      onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(fullscreenDialog: true, builder: (_) => ReelViewer(reels: reels, start: i + 1))),
                      child: ClipRRect(
                        borderRadius: BorderRadius.circular(18),
                        child: Stack(fit: StackFit.expand, children: [
                          rest[i].thumbUrl == null ? _wash(i) : NetImage(rest[i].thumbUrl!, fit: BoxFit.cover, fallback: _wash(i)),
                          Positioned(
                            left: 8,
                            bottom: 8,
                            child: Container(
                              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                              decoration: BoxDecoration(color: GP.scrim, borderRadius: BorderRadius.circular(8)),
                              child: Text(_platformLabel(rest[i]), style: t(14, color: GP.paper, w: FontWeight.w800)),
                            ),
                          ),
                        ]),
                      ),
                    ),
                  ),
              ],
            ),
          ],
        ]),
      ),
    );
  }
}

// ================================================================================================ book a time

/// "Pick a slot. Skip the wait.": the next open days with "N free", the free times, 15 / 30 length chips when the influencer sells
/// them, and the rickshaw-meter summary with "Request this slot", which continues in the existing booking confirm screen.
/// A quiet note instead when bookings are not open for this influencer.
class ChannelBookSection extends StatefulWidget {
  const ChannelBookSection({super.key, required this.slug, required this.firstName, this.hostName = '', this.avatarUrl, this.repo});

  final String slug;
  final String firstName;
  final String hostName;
  final String? avatarUrl;
  final BookingsRepo? repo;

  @override
  State<ChannelBookSection> createState() => _ChannelBookSectionState();
}

class _ChannelBookSectionState extends State<ChannelBookSection> {
  BookingsRepo get _repo => widget.repo ?? Services.instance.bookingsRepo;

  AsyncState<HostSlots> _state = const AsyncLoading();
  String? _day;
  String? _slot;
  int? _length;
  bool _lengthBusy = false;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    setState(() => _state = const AsyncLoading());
    try {
      await for (final s in _repo.watchSlots(widget.slug)) {
        if (mounted) setState(() => _state = AsyncData(s));
      }
    } catch (e) {
      if (mounted && _state is! AsyncData<HostSlots>) setState(() => _state = AsyncFailure(e));
    }
  }

  Future<void> _pickLength(int minutes) async {
    if (_lengthBusy || minutes == _length) return;
    setState(() {
      _length = minutes;
      _lengthBusy = true;
    });
    try {
      final s = await _repo.slots(widget.slug, durationMinutes: minutes);
      if (!mounted) return;
      setState(() {
        _state = AsyncData(s);
        final d = _day;
        if (d != null && _slot != null && !s.slotsOn(d).contains(_slot)) _slot = null;
      });
    } catch (e) {
      if (mounted) toast(context, e is ApiException ? e.userMessage : ApiException.genericText);
    } finally {
      if (mounted) setState(() => _lengthBusy = false);
    }
  }

  void _request(HostSlots s, String day, String hhmm, int minutes, bool lengths) {
    channelEvent('channel_slot_requested', {'minutes': minutes, 'surface': 'app', 'approval': s.needsApproval});
    final slot = Uri.encodeComponent(hhmm);
    if (s.topics.isNotEmpty) {
      // The influencer asks what the call is about: the booking sheet has the topic step.
      unawaited(context.push<Object?>('/book/${widget.slug}?day=$day&slot=$slot'));
      return;
    }
    final len = lengths ? '&len=$minutes' : '';
    final name = widget.hostName.isEmpty ? '' : '&name=${Uri.encodeQueryComponent(widget.hostName)}';
    final avatar = (widget.avatarUrl ?? '').isEmpty ? '' : '&avatar=${Uri.encodeQueryComponent(widget.avatarUrl!)}';
    unawaited(context.push<Object?>('/book/${widget.slug}/confirm?day=$day&slot=$slot$len$name$avatar'));
  }

  Widget _quiet(String text, {bool retry = false}) => Container(
        width: double.infinity,
        padding: const EdgeInsets.all(18),
        decoration: BoxDecoration(color: GP.paper, borderRadius: BorderRadius.circular(22)),
        child: Column(children: [
          Text(text, textAlign: TextAlign.center, style: t(16, color: GP.muted, w: FontWeight.w700, h: 1.35)),
          if (retry) ...[
            const SizedBox(height: 12),
            GpButton('Try again', kind: GpBtn.outline, onTap: () => unawaited(_load())),
          ],
        ]),
      );

  @override
  Widget build(BuildContext context) {
    final first = widget.firstName.isEmpty ? 'This influencer' : widget.firstName;
    final s = _state;
    final Widget body;
    var approval = false;
    if (s is AsyncLoading<HostSlots>) {
      body = const Padding(padding: EdgeInsets.all(24), child: Center(child: CircularProgressIndicator(color: GP.ink)));
    } else if (s is AsyncData<HostSlots> && s.value.openDays.isNotEmpty) {
      approval = s.value.needsApproval;
      body = _calendar(s.value);
    } else if (s is AsyncFailure<HostSlots>) {
      body = _quiet('The free times could not be loaded.', retry: true);
    } else {
      body = _quiet('$first is not taking bookings right now. Check back soon.');
    }
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 44, 16, 44),
      child: Column(children: [
        GpSectionHead(
          eyebrow: 'Book a time',
          title: TextSpan(text: 'Pick a slot. Skip the wait.', style: t(30, color: GP.ink, w: FontWeight.w900, h: 1.08)),
          sub: approval ? 'Pay only when $first confirms.' : null,
          sticker: const GpSticker('Meter down, baat shuru.', tone: GpStickerTone.blue, angle: 0.04),
        ),
        const SizedBox(height: 12),
        body,
      ]),
    );
  }

  Widget _calendar(HostSlots s) {
    final days = (s.openDays.toList()..sort()).take(10).toList();
    final day = _day != null && days.contains(_day) ? _day! : days.first;
    final times = s.slotsOn(day);
    final slot = _slot != null && times.contains(_slot) ? _slot : null;
    final lengths = CallFlags.bookingLengths && s.durationsMinutes.length > 1;
    final minutes = lengths ? (_length ?? s.minutes) : s.minutes;
    final date = parseDay(day) ?? DateTime.now();
    final total = s.ratePerMin * minutes;
    return Container(
      padding: const EdgeInsets.fromLTRB(14, 18, 14, 18),
      decoration: BoxDecoration(color: GP.paper, borderRadius: BorderRadius.circular(28), boxShadow: const [BoxShadow(color: GP.shadow, blurRadius: 40, offset: Offset(0, 12), spreadRadius: -16)]),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: IntrinsicHeight(
            child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              for (final d in days)
                Padding(
                  padding: const EdgeInsets.only(right: 8),
                  child: _DayChip(
                    key: ValueKey('channel-day-$d'),
                    date: parseDay(d) ?? date,
                    free: s.slotsOn(d).length,
                    on: d == day,
                    onTap: () => setState(() {
                      _day = d;
                      _slot = null;
                    }),
                  ),
                ),
            ]),
          ),
        ),
        const SizedBox(height: 16),
        LayoutBuilder(builder: (context, c) {
          final w = (c.maxWidth - 16) / 3;
          return Wrap(spacing: 8, runSpacing: 8, children: [
            for (final hhmm in times)
              SizedBox(
                width: w,
                child: _SlotButton(key: ValueKey('channel-slot-$hhmm'), label: slotLabel(hhmm), on: hhmm == slot, onTap: () => setState(() => _slot = hhmm)),
              ),
          ]);
        }),
        if (lengths) ...[
          const SizedBox(height: 16),
          Wrap(spacing: 10, runSpacing: 8, children: [
            for (final m in s.durationsMinutes) GpChip(lengthLabel(m), on: m == minutes, onTap: () => unawaited(_pickLength(m))),
          ]),
        ],
        const SizedBox(height: 18),
        _Meter(
          total: '₹$total',
          line: slot == null ? 'Pick a time above · ${lengthLabel(minutes)}' : '${dayLabel(date)} · ${slotLabel(slot)} · ${lengthLabel(minutes)}',
          button: GpButton(
            slot == null ? 'Pick a time' : 'Request this slot',
            kind: GpBtn.yellow,
            onTap: slot == null || _lengthBusy ? null : () => _request(s, day, slot, minutes, lengths),
          ),
        ),
        if (s.needsApproval)
          Padding(
            padding: const EdgeInsets.only(top: 10),
            child: Text(
              "Each booking needs the influencer's approval. If it isn't accepted within 24 hours, your money returns to your wallet.",
              style: t(14, color: GP.muted, w: FontWeight.w700, h: 1.35),
            ),
          ),
      ]),
    );
  }
}

class _DayChip extends StatelessWidget {
  const _DayChip({super.key, required this.date, required this.free, required this.on, required this.onTap});

  final DateTime date;
  final int free;
  final bool on;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final wd = weekdayShort[date.weekday - 1];
    return Semantics(
      button: true,
      selected: on,
      label: '$wd ${date.day}, $free free',
      child: Material(
        color: on ? GP.ink : GP.paper,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18), side: BorderSide(color: on ? GP.ink : GP.line, width: 1.5)),
        child: InkWell(
          borderRadius: BorderRadius.circular(18),
          onTap: onTap,
          child: ConstrainedBox(
            constraints: const BoxConstraints(minWidth: 76, minHeight: 48),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 10),
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                Text(wd.toUpperCase(), style: t(14, color: on ? GP.onDarkMuted : GP.muted, w: FontWeight.w800, ls: .06)),
                Text('${date.day}', style: t(24, color: on ? GP.paper : GP.ink, w: FontWeight.w900, h: 1.1)),
                Text('$free free', style: t(14, color: on ? GP.yel : GP.red, w: FontWeight.w800)),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}

class _SlotButton extends StatelessWidget {
  const _SlotButton({super.key, required this.label, required this.on, required this.onTap});

  final String label;
  final bool on;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      selected: on,
      child: Material(
        color: on ? GP.yel : GP.paper,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14), side: BorderSide(color: on ? GP.ink : GP.line, width: on ? 2 : 1.5)),
        child: InkWell(
          borderRadius: BorderRadius.circular(14),
          onTap: onTap,
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 54),
            child: Center(child: Padding(padding: const EdgeInsets.symmetric(horizontal: 4), child: Text(label, textAlign: TextAlign.center, style: t(16, color: GP.ink, w: FontWeight.w900)))),
          ),
        ),
      ),
    );
  }
}

/// The rickshaw-meter summary: ink card, yellow/black chequer edge, big yellow total.
class _Meter extends StatelessWidget {
  const _Meter({required this.total, required this.line, required this.button});

  final String total;
  final String line;
  final Widget button;

  @override
  Widget build(BuildContext context) {
    return ClipRRect(
      borderRadius: BorderRadius.circular(22),
      child: ColoredBox(
        color: GP.ink,
        child: Stack(children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(26, 16, 16, 16),
            child: Column(children: [
              Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                ExcludeSemantics(child: Image.asset('assets/channel/meter-icon.png', width: 56, height: 56, fit: BoxFit.contain)),
                const SizedBox(width: 12),
                Flexible(child: Text(total, textAlign: TextAlign.center, style: t(30, color: GP.yel, w: FontWeight.w900, ls: .04))),
              ]),
              Text(line, textAlign: TextAlign.center, style: t(14, color: GP.onDarkMuted, w: FontWeight.w700)),
              const SizedBox(height: 12),
              SizedBox(width: double.infinity, child: button),
            ]),
          ),
          const Positioned(left: 0, top: 0, bottom: 0, width: 10, child: ExcludeSemantics(child: CustomPaint(painter: _CheckerPainter()))),
        ]),
      ),
    );
  }
}

class _CheckerPainter extends CustomPainter {
  const _CheckerPainter();

  @override
  void paint(Canvas canvas, Size size) {
    const sq = 10.0;
    final p = Paint();
    for (var r = 0; r * sq < size.height; r++) {
      p.color = r.isEven ? GP.black : GP.yel;
      canvas.drawRect(Rect.fromLTWH(0, r * sq, size.width, sq), p);
    }
  }

  @override
  bool shouldRepaint(covariant CustomPainter old) => false;
}

// ================================================================================================ about + rules

/// White band with the influencer's own words as a big quote, and a few chips.
class ChannelAboutSection extends StatelessWidget {
  const ChannelAboutSection({super.key, required this.bio, this.tags = const []});

  final String bio;
  final List<String> tags;

  @override
  Widget build(BuildContext context) {
    return ColoredBox(
      color: GP.paper,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 44, 16, 44),
        child: Column(children: [
          Text('ABOUT', style: gpEyebrow()),
          const SizedBox(height: 8),
          Semantics(header: true, child: Text('“$bio”', textAlign: TextAlign.center, style: t(26, color: GP.ink, w: FontWeight.w900, h: 1.2))),
          if (tags.isNotEmpty) ...[
            const SizedBox(height: 18),
            Wrap(spacing: 8, runSpacing: 8, alignment: WrapAlignment.center, children: [
              for (final tag in tags)
                Container(
                  constraints: const BoxConstraints(minHeight: 40),
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                  decoration: BoxDecoration(color: GP.paper, borderRadius: BorderRadius.circular(999), border: Border.all(color: GP.line, width: 1.5)),
                  child: Text(tag, style: t(15, color: GP.ink, w: FontWeight.w800)),
                ),
            ]),
          ],
        ]),
      ),
    );
  }
}

/// "Before you call": three cards and the safety line. The copy is the owner's (decision D7); do not reword it.
class ChannelRulesSection extends StatelessWidget {
  const ChannelRulesSection({super.key});

  static const List<(String, String, String)> _cards = [
    ('01', 'Just a conversation', 'No professional advice or promised results.'),
    ('02', 'Keep it friendly', '18+ only. Be kind and respectful; abusive or sexual talk is not allowed and gets reported.'),
    ('03', 'Pay only for talk time', 'Charged per minute only while you are connected. Ringing, a missed or a declined call costs ₹0.'),
  ];

  static const String note =
      'Yahan sirf baat hoti hai. No medical, legal or money advice. Not a replacement for a doctor or counsellor. In crisis, call Tele-MANAS 14416 or 112. 18+ only.';

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 44, 16, 32),
      child: Column(children: [
        GpSectionHead(eyebrow: 'Good to know', title: TextSpan(text: 'Before you call', style: t(32, color: GP.ink, w: FontWeight.w900, h: 1.05))),
        const SizedBox(height: 18),
        for (final c in _cards)
          Container(
            width: double.infinity,
            margin: const EdgeInsets.only(bottom: 14),
            padding: const EdgeInsets.all(20),
            decoration: BoxDecoration(color: GP.paper, borderRadius: BorderRadius.circular(22)),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(c.$1, style: t(38, color: GP.mari, w: FontWeight.w900, h: 1)),
              const SizedBox(height: 6),
              Text(c.$2, style: t(20, color: GP.ink, w: FontWeight.w900)),
              const SizedBox(height: 4),
              Text(c.$3, style: t(16, color: GP.muted, w: FontWeight.w700, h: 1.4)),
            ]),
          ),
        Container(
          width: double.infinity,
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(color: GP.mariTint, borderRadius: BorderRadius.circular(18)),
          child: Text(note, style: t(15, color: GP.ink, w: FontWeight.w700, h: 1.4)),
        ),
      ]),
    );
  }
}
