import 'package:flutter/material.dart';

import '../data/call_flags.dart';
import '../data/models/queue.dart';
import '../ui/net_image.dart';
import 'data.dart';
import 'desi.dart';
import 'theme.dart';
import 'widgets.dart';

/// [HF-APP-DESI-4] Influencer profile pieces, built to the owner-approved canvas previews "4 · Influencer profile (online,
/// Videos)" and "4b · Influencer profile (offline, Calendar)" (2026-10-22). Used by the demo and real profile.

/// Photo of [who]: live avatar, else demo portrait, else her colour tones.
Widget profilePhoto(Influencer who) {
  final fallback = DecoratedBox(decoration: BoxDecoration(gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [who.tones.first, who.tones.last])));
  if (who.avatarUrl != null && who.avatarUrl!.isNotEmpty) return NetImage(who.avatarUrl!, fit: BoxFit.cover, alignment: Alignment.topCenter, fallback: fallback);
  if (who.portrait != null) return Art(who.portrait!, fit: BoxFit.cover, alignment: Alignment.topCenter, fallback: fallback);
  return fallback;
}

/// Big rounded photo card: flower string on top, Back and heart, Online/Offline label, name and handle line.
class ProfileCover extends StatelessWidget {
  const ProfileCover({super.key, required this.who, required this.line, this.faved = false, this.onHeart, this.onShare});
  final Influencer who;
  final String line;
  final bool faved;

  /// Null hides the heart.
  final VoidCallback? onHeart;

  /// [HF-SHARE-APP-1] Null hides the share button.
  final VoidCallback? onShare;

  @override
  Widget build(BuildContext context) {
    final online = who.online;
    return Container(
      height: 330,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(28),
        border: Border.all(color: C.white, width: 3),
        boxShadow: const [BoxShadow(color: Color(0x8C4A1747), offset: Offset(0, 16), blurRadius: 34, spreadRadius: -16)],
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(25),
        child: Stack(fit: StackFit.expand, children: [
          online
              ? profilePhoto(who)
              : ColorFiltered(colorFilter: const ColorFilter.matrix([.8, .15, .05, 0, 0, .05, .9, .05, 0, 0, .05, .15, .8, 0, 0, 0, 0, 0, 1, 0]), child: profilePhoto(who)),
          const DecoratedBox(
            decoration: BoxDecoration(
              gradient: LinearGradient(
                begin: Alignment.topCenter,
                end: Alignment.bottomCenter,
                stops: [0, .28, .48, 1],
                colors: [Color(0x592B1530), Color(0x002B1530), Color(0x002B1530), Color(0xEB2B1530)],
              ),
            ),
          ),
          Positioned(
            left: 30,
            right: 30,
            top: 0,
            child: Row(mainAxisAlignment: MainAxisAlignment.spaceAround, children: [
              for (var i = 0; i < 10; i++) i % 3 == 0 ? const Marigold(size: 20, yellow: true) : const Padding(padding: EdgeInsets.only(top: 2), child: Jasmine(size: 16)),
            ]),
          ),
          Positioned(left: 10, top: 24, child: const BackBtn()),
          if (onShare != null)
            Positioned(
              right: onHeart != null ? 62 : 10,
              top: 24,
              child: Tooltip(
                message: 'Share this page',
                child: Semantics(
                  button: true,
                  label: 'Share this page',
                  child: GestureDetector(
                    onTap: onShare,
                    behavior: HitTestBehavior.opaque,
                    child: SizedBox(
                      width: 52,
                      height: 52,
                      child: Center(
                        child: Container(
                          width: 48,
                          height: 48,
                          decoration: const BoxDecoration(color: Color(0xF2FFFFFF), shape: BoxShape.circle),
                          child: const Icon(Icons.share_rounded, color: C.rani, size: 22),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          if (onHeart != null)
            Positioned(
              right: 10,
              top: 24,
              child: Tooltip(
                message: faved ? 'Remove from favourites' : 'Add to favourites',
                child: Semantics(
                  button: true,
                  label: faved ? 'Remove from favourites' : 'Add to favourites',
                  child: GestureDetector(
                    onTap: onHeart,
                    behavior: HitTestBehavior.opaque,
                    child: SizedBox(
                      width: 52,
                      height: 52,
                      child: Center(
                        child: Container(
                          width: 48,
                          height: 48,
                          decoration: const BoxDecoration(color: Color(0xF2FFFFFF), shape: BoxShape.circle),
                          child: Icon(faved ? Icons.favorite_rounded : Icons.favorite_border_rounded, color: C.rani, size: 22),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          Positioned(
            left: 18,
            right: 18,
            bottom: 16,
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                decoration: BoxDecoration(color: online ? C.onlineBg : const Color(0xFFF3EEF2), borderRadius: BorderRadius.circular(999)),
                child: Text(online ? '● Online now' : 'Offline', style: t(14, color: online ? C.onlineInk : C.muted, w: FontWeight.w800)),
              ),
              const SizedBox(height: 8),
              Text(who.name, maxLines: 2, overflow: TextOverflow.ellipsis, style: t(32, color: C.white, w: FontWeight.w900, h: 1.05)),
              if (line.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 2), child: Text(line, maxLines: 1, overflow: TextOverflow.ellipsis, style: t(15, color: C.white, w: FontWeight.w700))),
            ]),
          ),
        ]),
      ),
    );
  }
}

/// Likes (pink), Videos (lavender), Rate (gold with a marigold).
class ProfileStats extends StatelessWidget {
  const ProfileStats({super.key, required this.likes, required this.videos, required this.rate});
  final String likes;
  final String videos;
  final String rate;

  Widget _tile(Color tint, Color edge, Color ink, String label, String value, {bool flower = false}) => Container(
        clipBehavior: Clip.antiAlias,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(20),
          border: Border.all(color: edge, width: 1.5),
          gradient: LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [C.white, tint]),
        ),
        child: Stack(children: [
          if (flower) const Positioned(right: -14, top: -14, child: Marigold(size: 46, yellow: true)),
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 12, 12, 10),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(label, style: t(14, color: ink, w: FontWeight.w800)),
              const SizedBox(height: 2),
              FittedBox(fit: BoxFit.scaleDown, alignment: Alignment.centerLeft, child: Text(value, style: t(24, color: C.deep, w: FontWeight.w900))),
            ]),
          ),
        ]),
      );

  @override
  Widget build(BuildContext context) => IntrinsicHeight(
        child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Expanded(flex: 10, child: _tile(C.blush, const Color(0xFFF8C4D9), C.rani, '♥ Likes', likes)),
          const SizedBox(width: 10),
          Expanded(flex: 10, child: _tile(C.lavtint, const Color(0xFFDDD2FB), C.lav, '▶ Videos', videos)),
          const SizedBox(width: 10),
          Expanded(flex: 12, child: _tile(C.goldtint, const Color(0xFFF3DFB3), C.amber, '₹ Rate', rate, flower: true)),
        ]),
      );
}

/// White "Mere baare mein" card with a hibiscus and niche/city chips.
class ProfileBio extends StatelessWidget {
  const ProfileBio({super.key, required this.bio, this.tags = const []});
  final String bio;
  final List<String> tags;
  @override
  Widget build(BuildContext context) {
    const tones = [DesiTone.tea, DesiTone.lav, DesiTone.rani, DesiTone.gold];
    return DesiCard(
      corner: DesiCorner.hibiscus,
      padding: const EdgeInsets.fromLTRB(18, 16, 18, 16),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('MERE BAARE MEIN', style: t(14, color: C.rani, w: FontWeight.w800, ls: .06)),
        const SizedBox(height: 6),
        Padding(
          padding: const EdgeInsets.only(right: 30),
          child: Text(bio.isEmpty ? 'No bio yet.' : bio, style: t(16, w: FontWeight.w700, h: 1.45)),
        ),
        if (tags.isNotEmpty) ...[
          const SizedBox(height: 10),
          Wrap(spacing: 6, runSpacing: 6, children: [for (var i = 0; i < tags.length; i++) DesiChip(tags[i], tone: tones[i % tones.length])]),
        ],
      ]),
    );
  }
}

/// Pink Call now (online) or the given notify button (offline), orange Book, and a line underneath.
/// [HF-CALL-MODES-E2] With call modes on and a [callState] from the server the buttons follow the table in spec 2.1
/// (Call now / Join the queue / Book a time / Notify me); without it the classic online/offline pair is shown.
class ProfileActions extends StatelessWidget {
  const ProfileActions({
    super.key,
    required this.online,
    required this.first,
    required this.onCall,
    required this.onBook,
    required this.notify,
    this.callState,
    this.queueWaiting = 0,
    this.onQueue,
  });
  final bool online;
  final String first;
  final VoidCallback onCall;
  final VoidCallback onBook;
  final Widget notify;
  final HostCallState? callState;
  final int queueWaiting;
  final VoidCallback? onQueue;

  Widget get _callPill => _Pill(
        label: 'Call now',
        icon: Icons.call_rounded,
        gradient: const LinearGradient(colors: [Color(0xFFD81B72), Color(0xFFF0408F)]),
        ink: C.white,
        glow: const Color(0xCCD81B72),
        onTap: onCall,
      );

  Widget get _queuePill => _Pill(
        label: 'Join the queue',
        icon: Icons.groups_rounded,
        gradient: const LinearGradient(colors: [Color(0xFF4A1747), Color(0xFF6B2468)]),
        ink: C.white,
        onTap: onQueue ?? onCall,
      );

  Widget _bookPill(String label) => _Pill(label: label, gradient: const LinearGradient(colors: [Color(0xFFF59E0B), Color(0xFFEA6A12)]), ink: const Color(0xFF3B1600), onTap: onBook);

  @override
  Widget build(BuildContext context) {
    final cs = CallFlags.modes ? callState : null;
    if (cs == null) return _classic();
    final queueOn = CallFlags.queue && onQueue != null;
    final Widget main;
    var showBook = true;
    final String note;
    switch (cs) {
      case HostCallState.available:
        main = _callPill;
        note = 'Rings $first right away · you pay per minute from your wallet';
      case HostCallState.onCall:
        main = queueOn ? _queuePill : notify;
        final w = queueWaiting > 0 ? '$queueWaiting waiting. ' : '';
        note = queueOn
            ? '$first is on a call. ${w}Join the queue and we WhatsApp you just before we call, or book a time.'
            : '$first is on a call right now. Book a time, or we will WhatsApp you when she is free.';
      case HostCallState.connecting:
        main = queueOn ? _queuePill : _callPill;
        note = queueOn ? '$first is about to take a call. Join the queue to keep your place.' : 'Rings $first right away · you pay per minute from your wallet';
      case HostCallState.queueOnly:
        main = queueOn ? _queuePill : notify;
        note = '$first has people waiting. Join the queue to keep your place.';
      case HostCallState.appointments:
        main = notify;
        note = '$first is available by appointment. Book a time that suits you.';
      case HostCallState.offline:
        main = notify;
        showBook = false;
        note = "$first is offline right now. We'll tell you the moment she is back.";
    }
    return Column(children: [
      Row(children: [
        Expanded(flex: 3, child: main),
        if (showBook) ...[
          const SizedBox(width: 10),
          Expanded(flex: 2, child: _bookPill('Book a time')),
        ],
      ]),
      const SizedBox(height: 8),
      Text(note, key: const ValueKey('profile-actions-note'), textAlign: TextAlign.center, style: t(14, color: C.muted, w: FontWeight.w700)),
    ]);
  }

  Widget _classic() => Column(children: [
        Row(children: [
          Expanded(flex: 3, child: online ? _callPill : notify),
          const SizedBox(width: 10),
          Expanded(flex: 2, child: _bookPill('Book')),
        ]),
        const SizedBox(height: 8),
        Text(
          online ? 'Rings $first right away · you pay per minute from your wallet' : '$first is offline right now. We\'ll tell you the moment she comes online.',
          textAlign: TextAlign.center,
          style: t(14, color: C.muted, w: FontWeight.w700),
        ),
      ]);
}

class _Pill extends StatelessWidget {
  const _Pill({required this.label, required this.gradient, required this.ink, required this.onTap, this.icon, this.glow});
  final String label;
  final IconData? icon;
  final Gradient gradient;
  final Color ink;
  final Color? glow;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => Semantics(
        button: true,
        child: Container(
          height: 58,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(999),
            gradient: gradient,
            boxShadow: glow == null ? null : [BoxShadow(color: glow!, offset: const Offset(0, 12), blurRadius: 24, spreadRadius: -12)],
          ),
          child: Material(
            color: C.clear,
            child: InkWell(
              customBorder: const StadiumBorder(),
              onTap: onTap,
              child: Center(
                child: FittedBox(
                  fit: BoxFit.scaleDown,
                  child: Row(mainAxisSize: MainAxisSize.min, children: [
                    if (icon != null) ...[Icon(icon, color: ink, size: 20), const SizedBox(width: 8)],
                    Text(label, style: t(18, color: ink, w: FontWeight.w900)),
                  ]),
                ),
              ),
            ),
          ),
        ),
      );
}

/// Plum segmented switch between Videos and Calendar.
class ProfileTabs extends StatelessWidget {
  const ProfileTabs({super.key, required this.tab, required this.onTab});
  final int tab;
  final ValueChanged<int> onTab;
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.all(4),
        decoration: BoxDecoration(color: C.white, borderRadius: BorderRadius.circular(999), border: Border.all(color: C.line, width: 1.5)),
        child: Row(children: [
          for (final (i, label) in [(0, 'Videos'), (1, 'Calendar')])
            Expanded(
              child: Semantics(
                button: true,
                selected: tab == i,
                child: Material(
                  color: tab == i ? C.maroon : C.clear,
                  shape: const StadiumBorder(),
                  child: InkWell(
                    customBorder: const StadiumBorder(),
                    onTap: () => onTab(i),
                    child: SizedBox(height: 48, child: Center(child: Text(label, style: t(16, color: tab == i ? C.white : C.maroon, w: FontWeight.w800)))),
                  ),
                ),
              ),
            ),
        ]),
      );
}

const _edges = [Color(0xFFF8C4D9), Color(0xFFDDD2FB), Color(0xFFB9E2E5), Color(0xFFF3DFB3)];
const _grads = [
  [Color(0xFFD81B72), Color(0xFFF59E0B)],
  [Color(0xFF6D4FD0), Color(0xFFD81B72)],
  [Color(0xFF0E7C86), Color(0xFF6D4FD0)],
  [Color(0xFFEA6A12), Color(0xFFFBBF24)],
  [Color(0xFF4A1747), Color(0xFFD81B72)],
  [Color(0xFFF59E0B), Color(0xFF0E7C86)],
];

/// One video in the 3-column grid: coloured border, thumbnail (or a colour wash), play mark and view count.
class ProfileVideoTile extends StatelessWidget {
  const ProfileVideoTile({super.key, required this.index, required this.views, required this.onTap, this.thumbUrl});
  final int index;
  final String views;
  final String? thumbUrl;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final g = _grads[index % _grads.length];
    final wash = DecoratedBox(decoration: BoxDecoration(gradient: LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: g)));
    return Semantics(
      button: true,
      label: 'Watch video ${index + 1}',
      child: GestureDetector(
        onTap: onTap,
        child: Container(
          decoration: BoxDecoration(borderRadius: BorderRadius.circular(16), border: Border.all(color: _edges[index % _edges.length], width: 2)),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(14),
            child: Stack(fit: StackFit.expand, children: [
              thumbUrl == null ? wash : NetImage(thumbUrl!, fit: BoxFit.cover, fallback: wash),
              const Center(child: Icon(Icons.play_arrow_rounded, color: Color(0xE6FFFFFF), size: 34)),
              Positioned(
                left: 6,
                bottom: 6,
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 1),
                  decoration: BoxDecoration(color: const Color(0x8C2B1530), borderRadius: BorderRadius.circular(999)),
                  child: Text(views, style: t(14, color: C.white, w: FontWeight.w800)),
                ),
              ),
            ]),
          ),
        ),
      ),
    );
  }
}

/// Teal "Free times · Pick a day" card holding the day chips and time slots.
class FreeTimesCard extends StatelessWidget {
  const FreeTimesCard({super.key, required this.child});
  final Widget child;
  @override
  Widget build(BuildContext context) => Container(
        clipBehavior: Clip.antiAlias,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(24),
          border: Border.all(color: const Color(0xFFB9E2E5), width: 1.5),
          gradient: const LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [C.white, C.teatint]),
        ),
        child: Stack(children: [
          const Positioned(right: -16, top: -16, child: Marigold(size: 60)),
          Padding(
            padding: const EdgeInsets.all(16),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('FREE TIMES', style: t(14, color: C.peacock, w: FontWeight.w800, ls: .06)),
              const SizedBox(height: 2),
              Text('Pick a day', style: t(20, w: FontWeight.w900)),
              const SizedBox(height: 12),
              child,
            ]),
          ),
        ]),
      );
}

/// One day chip: weekday over date; chosen day solid teal.
class CalDayChip extends StatelessWidget {
  const CalDayChip({super.key, required this.weekday, required this.day, required this.on, required this.onTap});
  final String weekday;
  final int day;
  final bool on;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => Semantics(
        button: true,
        selected: on,
        child: GestureDetector(
          onTap: onTap,
          child: Container(
            width: 62,
            decoration: BoxDecoration(
              color: on ? C.peacock : C.white,
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: on ? C.peacock : const Color(0xFFB9E2E5), width: 2),
            ),
            child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
              Text(weekday, style: t(14, color: on ? C.white : C.deep, w: FontWeight.w800)),
              Text('$day', style: t(22, color: on ? C.white : C.deep, w: FontWeight.w900)),
            ]),
          ),
        ),
      );
}

/// One free-time pill.
class CalSlotChip extends StatelessWidget {
  const CalSlotChip({super.key, required this.label, required this.onTap});
  final String label;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => Semantics(
        button: true,
        child: Material(
          color: C.white,
          shape: const StadiumBorder(side: BorderSide(color: Color(0xFFB9E2E5), width: 1.5)),
          child: InkWell(
            customBorder: const StadiumBorder(),
            onTap: onTap,
            child: Container(
              constraints: const BoxConstraints(minHeight: 44),
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: Center(widthFactor: 1, child: Text(label, style: t(15, color: const Color(0xFF0B5F66), w: FontWeight.w800))),
            ),
          ),
        ),
      );
}

const _months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const _weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/// "Friday, 24 Oct".
String calDayTitle(DateTime d) => '${_weekdays[d.weekday - 1]}, ${d.day} ${_months[d.month - 1]}';
