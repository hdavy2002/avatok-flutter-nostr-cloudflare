import 'package:flutter/material.dart';

import '../data/call_flags.dart';
import '../data/models/queue.dart';
import '../data/models/reel.dart';
import 'data.dart';
import 'desi.dart';
import 'reels_real.dart';
import 'theme.dart';
import 'verified_tick.dart';
import 'widgets.dart';

/// [HF-INTRO-A2] (D14, owner designs Reel1Call / Reel2Busy / Reel3Women) The overlay on an approved intro video: name and
/// green tick, a small icon per verified social account, the pink "Women only" tag, up to three category chips, the status
/// dot, one line of description, and the ONE main button the server asked for (`mainAction`). The right rail (Like, Comment,
/// Share, Info) is built by the reel page and passed in as [rail], so it keeps the buttons the Reels already use.
class IntroReelOverlay extends StatelessWidget {
  const IntroReelOverlay({
    super.key,
    required this.reel,
    required this.who,
    required this.rail,
    required this.onProfile,
    required this.onSocial,
    required this.onCall,
    required this.onQueue,
    required this.onBook,
  });

  final FeedReel reel;
  final Influencer who;

  /// The Like / Comment / Share / Info column.
  final Widget rail;
  final VoidCallback onProfile;
  final void Function(ReelSocial social) onSocial;
  final VoidCallback onCall;
  final VoidCallback onQueue;
  final VoidCallback onBook;

  static final List<Shadow> _shadow = [
    Shadow(color: C.cinema.withValues(alpha: 0.9), blurRadius: 4),
    Shadow(color: C.cinema.withValues(alpha: 0.9), blurRadius: 8),
  ];

  /// `12` for 1200 paise, `12.50` for 1250. Falls back to the host's rate when the reel has none.
  static String rateText(FeedReel r) {
    final paise = r.ratePaise > 0 ? r.ratePaise : r.host.ratePaise;
    final rupees = paise / 100;
    return rupees == rupees.roundToDouble() ? rupees.toStringAsFixed(0) : rupees.toStringAsFixed(2);
  }

  /// (label, dot colour) of the status line, or null when there is nothing to say.
  static (String, Color)? statusOf(FeedReel r) {
    final waiting = r.host.queueWaiting;
    switch (r.host.callState) {
      case HostCallState.available:
      case HostCallState.connecting:
        return ('Online', C.onlineDot);
      case HostCallState.onCall:
      case HostCallState.queueOnly:
        return (waiting > 0 ? 'On a call · $waiting waiting' : 'On a call', C.marigold);
      case HostCallState.appointments:
        return ('Takes bookings', C.marigold);
      case HostCallState.offline:
        return ('Offline', C.ruby);
      case null:
        switch (r.host.presence) {
          case 'online':
            return ('Online', C.onlineDot);
          case 'busy':
            return ('On a call', C.marigold);
          default:
            return null;
        }
    }
  }

  static Color socialColor(String platform) => switch (platform) {
        'youtube' => C.ruby,
        'instagram' => C.tan,
        _ => GP.blue,
      };

  static IconData socialIcon(String platform) => switch (platform) {
        'youtube' => Icons.play_arrow_rounded,
        'instagram' => Icons.camera_alt_outlined,
        _ => Icons.facebook,
      };

  static String socialName(String platform) => switch (platform) {
        'youtube' => 'YouTube',
        'instagram' => 'Instagram',
        'facebook' => 'Facebook',
        _ => platform,
      };

  Widget _socialIcon(ReelSocial s) => Semantics(
        button: true,
        label: 'Open ${socialName(s.platform)} account',
        child: InkResponse(
          key: ValueKey('intro-social-${s.platform}'),
          radius: 24,
          onTap: () => onSocial(s),
          child: SizedBox(
            width: 44,
            height: 44,
            child: Center(
              child: Container(
                width: 26,
                height: 26,
                decoration: BoxDecoration(color: socialColor(s.platform), borderRadius: BorderRadius.circular(7)),
                child: Icon(socialIcon(s.platform), color: C.white, size: 18),
              ),
            ),
          ),
        ),
      );

  /// [HF-DESI-ONB] Category chip on the video: translucent plum with a gold border.
  Widget _chip(String label) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 5),
        decoration: BoxDecoration(color: Gota.darkFill, borderRadius: BorderRadius.circular(999), border: Border.all(color: Gota.gold, width: 1.2)),
        child: Text(label, maxLines: 1, style: t(14, color: C.white, w: FontWeight.w800)),
      );

  /// [HF-DESI-ONB] Solid saffron gota-patti pill (marigolds at the ends when it is the only button), or the dark plum pill
  /// with a gold border for the second choice.
  Widget _mainButton(String label, VoidCallback onTap, {Key? key, bool outlined = false, bool flowers = true}) => Expanded(
        child: GotaButton(
          label: label,
          onTap: onTap,
          inkKey: key,
          kind: outlined ? GotaKind.dark : GotaKind.saffron,
          height: 56,
          fontSize: 17,
          flowers: !outlined && flowers,
        ),
      );

  Widget _mainArea() {
    final rate = '₹${rateText(reel)}/min';
    switch (reel.effectiveMainAction) {
      case 'call':
        return Row(children: [_mainButton('Call now · $rate', onCall, key: const ValueKey('intro-call'))]);
      case 'queue_or_book':
        return Column(mainAxisSize: MainAxisSize.min, children: [
          Text('Busy right now · $rate', key: const ValueKey('intro-busy'), textAlign: TextAlign.center, style: t(15, color: Gota.gold, w: FontWeight.w800).copyWith(shadows: _shadow)),
          const SizedBox(height: 8),
          Row(children: [
            if (CallFlags.queue) ...[
              _mainButton('Join queue', onQueue, key: const ValueKey('intro-queue'), flowers: false),
              const SizedBox(width: 10),
            ],
            _mainButton('Book a time', onBook, key: const ValueKey('intro-book'), outlined: CallFlags.queue),
          ]),
        ]);
      case 'book':
        return Column(mainAxisSize: MainAxisSize.min, children: [
          Row(children: [_mainButton('Book a time · $rate', onBook, key: const ValueKey('intro-book'))]),
          const SizedBox(height: 6),
          Text('Takes bookings only', key: const ValueKey('intro-bookings-only'), style: t(14, color: C.white, w: FontWeight.w700).copyWith(shadows: _shadow)),
        ]);
      default:
        return const SizedBox.shrink();
    }
  }

  @override
  Widget build(BuildContext context) {
    final pad = MediaQuery.paddingOf(context);
    final status = statusOf(reel);
    final chips = reel.categories.take(3).toList();
    final desc = reel.description.trim();
    return Positioned(
      left: 0,
      right: 0,
      top: pad.top + 8,
      bottom: pad.bottom + 12,
      child: Column(
        mainAxisAlignment: MainAxisAlignment.end,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // the rail scales down on a very short screen instead of overflowing
          Flexible(
            child: Align(
              alignment: Alignment.bottomRight,
              child: Padding(
                padding: const EdgeInsets.only(right: 4),
                child: FittedBox(fit: BoxFit.scaleDown, alignment: Alignment.bottomRight, child: SizedBox(width: 68, child: rail)),
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 4, 76, 8),
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
              Wrap(crossAxisAlignment: WrapCrossAlignment.center, spacing: 8, runSpacing: 0, children: [
                GestureDetector(
                  key: const ValueKey('intro-photo'),
                  onTap: onProfile,
                  child: Container(
                    width: 44,
                    height: 44,
                    padding: const EdgeInsets.all(2.5),
                    decoration: const BoxDecoration(shape: BoxShape.circle, color: C.marigold),
                    child: ClipOval(child: Avatar(who, size: 39, ring: false)),
                  ),
                ),
                ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 220),
                  child: Text(
                    reel.host.name,
                    key: const ValueKey('intro-name'),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: t(19, color: C.white, w: FontWeight.w800).copyWith(shadows: _shadow),
                  ),
                ),
                VerifiedTick(
                  name: reel.host.name,
                  videoKyc: reel.greenTick,
                  channel: reel.socials.isNotEmpty,
                  surface: 'intro_reel',
                  size: 20,
                  interactive: false,
                  color: C.onlineDot, // [HF-DESI-GAPS] verified tick is green #3FA868 on intro reels
                ),
                for (final s in reel.socials) _socialIcon(s),
                if (reel.womenOnly)
                  Container(
                    key: const ValueKey('intro-women-tag'),
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                    decoration: BoxDecoration(color: const Color(0xFFF8D3E2), borderRadius: BorderRadius.circular(999), border: Border.all(color: C.rani, width: 1.2)),
                    child: Text('♀ Women only', maxLines: 1, style: t(14, color: const Color(0xFF8A1250), w: FontWeight.w800)),
                  ),
              ]),
              if (chips.isNotEmpty || status != null) ...[
                const SizedBox(height: 4),
                Wrap(spacing: 6, runSpacing: 6, crossAxisAlignment: WrapCrossAlignment.center, children: [
                  for (final c in chips) _chip(c.label),
                  if (status != null)
                    // a rich text (not a Row) so a long status wraps instead of overflowing on a narrow phone
                    Text.rich(
                      key: const ValueKey('intro-status'),
                      TextSpan(children: [
                        WidgetSpan(
                          alignment: PlaceholderAlignment.middle,
                          child: Container(width: 10, height: 10, margin: const EdgeInsets.only(right: 5), decoration: BoxDecoration(shape: BoxShape.circle, color: status.$2)),
                        ),
                        TextSpan(text: status.$1),
                      ]),
                      style: t(14, color: C.white, w: FontWeight.w800).copyWith(shadows: _shadow),
                    ),
                ]),
              ],
              if (desc.isNotEmpty) ...[
                const SizedBox(height: 8),
                Text(desc, key: const ValueKey('intro-desc'), maxLines: 1, overflow: TextOverflow.ellipsis, style: t(14, color: C.white, w: FontWeight.w700).copyWith(shadows: _shadow)),
              ],
            ]),
          ),
          Padding(padding: const EdgeInsets.fromLTRB(16, 4, 16, 0), child: _mainArea()),
        ],
      ),
    );
  }
}

/// [HF-INTRO-A2] (D15, Reel5Info) The ⓘ sheet "Verified owner of": every verified account with an Open button. Returns the
/// account the person chose to open (the caller opens it inside the app), or null.
Future<ReelSocial?> showIntroInfoSheet(BuildContext context, {required FeedReel reel, required Influencer who}) {
  // [HF-DESI-ONB] Design Reel5Info: parchment sheet, white rows with a sand border, solid saffron "Open" pills, a marigold in
  // the top-right corner with the header padded so no text sits under it.
  return showModalBottomSheet<ReelSocial>(
    context: context,
    useRootNavigator: true,
    isScrollControlled: true,
    backgroundColor: C.page,
    showDragHandle: true,
    clipBehavior: Clip.antiAlias,
    shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(28))),
    builder: (sheet) => SafeArea(
      child: Stack(clipBehavior: Clip.none, children: [
        const Positioned(right: -18, top: -30, child: IgnorePointer(child: Marigold(size: 76))),
        SingleChildScrollView(
          key: const ValueKey('intro-info-sheet'),
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Padding(
              padding: const EdgeInsets.only(right: 56),
              child: Row(children: [
                Container(
                  width: 56,
                  height: 56,
                  padding: const EdgeInsets.all(2.5),
                  decoration: const BoxDecoration(shape: BoxShape.circle, color: C.marigold),
                  child: ClipOval(child: Avatar(who, size: 51, ring: false)),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Row(children: [
                      Flexible(child: Text(reel.host.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: t(20, color: C.deep, w: FontWeight.w800))),
                      const SizedBox(width: 6),
                      VerifiedTick(name: reel.host.name, videoKyc: reel.greenTick, channel: reel.socials.isNotEmpty, surface: 'intro_info', size: 20, interactive: false, color: C.onlineDot),
                    ]),
                    Text('Approved by our team', style: t(14, color: C.muted, w: FontWeight.w700)),
                  ]),
                ),
              ]),
            ),
            const SizedBox(height: 16),
            Row(children: [
              const Marigold(size: 20),
              const SizedBox(width: 8),
              Flexible(child: Text('VERIFIED OWNER OF', style: t(14, color: C.tan, w: FontWeight.w800, ls: 0.14))),
            ]),
            const SizedBox(height: 10),
            if (reel.socials.isEmpty)
              Text('No linked accounts yet.', style: t(15, color: C.muted, w: FontWeight.w700)),
            for (final s in reel.socials)
              Container(
                margin: const EdgeInsets.only(bottom: 10),
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(color: C.white, border: Border.all(color: C.line, width: 1.5), borderRadius: BorderRadius.circular(20), boxShadow: desiShadow),
                child: Row(children: [
                  Container(
                    width: 46,
                    height: 46,
                    decoration: BoxDecoration(color: IntroReelOverlay.socialColor(s.platform), borderRadius: BorderRadius.circular(14)),
                    child: Icon(IntroReelOverlay.socialIcon(s.platform), color: C.white, size: 26),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text(IntroReelOverlay.socialName(s.platform), style: t(16, color: C.deep, w: FontWeight.w800)),
                      Text(
                        [
                          if (s.handle.isNotEmpty) s.handle,
                          if (s.followers != null) '${compactCount(s.followers!)} ${s.platform == 'youtube' ? 'subscribers' : 'followers'}',
                        ].join(' · '),
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: t(14, color: C.muted, w: FontWeight.w700, h: 1.35),
                      ),
                    ]),
                  ),
                  const SizedBox(width: 8),
                  GotaPill(
                    label: 'Open',
                    semanticLabel: 'Open ${IntroReelOverlay.socialName(s.platform)}',
                    inkKey: ValueKey('intro-info-open-${s.platform}'),
                    onTap: () => Navigator.of(sheet).pop(s),
                  ),
                ]),
              ),
            Text(
              'She logged in to each account to prove it is hers. Links open inside the app.',
              style: t(14, color: C.muted, w: FontWeight.w700, h: 1.5),
            ),
            const SizedBox(height: 14),
            GotaButton(
              key: const ValueKey('intro-info-close'),
              label: 'Close',
              kind: GotaKind.ghost,
              height: 52,
              fontSize: 16,
              onTap: () => Navigator.of(sheet).pop(),
            ),
          ]),
        ),
      ]),
    ),
  );
}
