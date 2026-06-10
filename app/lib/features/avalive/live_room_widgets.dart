// Phase 7 — shared AvaLive overlay layer (TikTok/YouTube-Live conventions):
// scrolling chat, flying (bullet) messages, tap-burst emoji reactions, sticker
// sends, donation banners, viewer count, countdowns. Pure presentation — the
// screens own the RoomChannel and feed events in.
import 'dart:math';

import 'package:flutter/material.dart';

import '../../core/theme.dart';

const kStickerCatalog = ['🔥', '💎', '🎉', '👏', '😂', '😍', '🚀', '👑']; // tiny static set, tree-shaken
const kReactionEmojis = ['❤️', '🔥', '😂', '👏', '😮', '💯'];

String fmtClock(int ms) {
  final s = (ms / 1000).floor().clamp(0, 359999);
  final h = s ~/ 3600, m = (s % 3600) ~/ 60, ss = s % 60;
  final mm = m.toString().padLeft(2, '0'), sss = ss.toString().padLeft(2, '0');
  return h > 0 ? '$h:$mm:$sss' : '$mm:$sss';
}

class ChatLine {
  final String from;
  final String text;
  ChatLine(this.from, this.text);
}

class FlyMsg {
  final String text;
  final double lane;       // 0..1 vertical lane
  final int bornAt;
  FlyMsg(this.text) : lane = Random().nextDouble(), bornAt = DateTime.now().millisecondsSinceEpoch;
}

class ReactionBurst {
  final String emoji;
  final double x;
  final int bornAt;
  ReactionBurst(this.emoji) : x = .1 + Random().nextDouble() * .8, bornAt = DateTime.now().millisecondsSinceEpoch;
}

class DonationBanner {
  final String name;
  final int amount;
  DonationBanner(this.name, this.amount);
}

/// Scrolling chat overlay (bottom-left, fading top).
class ChatOverlay extends StatelessWidget {
  final List<ChatLine> lines;
  final void Function(String uid, String name)? onLongPress; // host moderation
  final List<({String uid, String name})> meta;
  const ChatOverlay({super.key, required this.lines, this.meta = const [], this.onLongPress});

  @override
  Widget build(BuildContext context) {
    return ShaderMask(
      shaderCallback: (r) => const LinearGradient(
        begin: Alignment.topCenter, end: Alignment.bottomCenter,
        colors: [Colors.transparent, Colors.black], stops: [0, .25],
      ).createShader(r),
      blendMode: BlendMode.dstIn,
      child: ListView.builder(
        reverse: true,
        padding: EdgeInsets.zero,
        itemCount: lines.length,
        itemBuilder: (_, i) {
          final l = lines[lines.length - 1 - i];
          final m = i < meta.length ? meta[meta.length - 1 - i] : null;
          return GestureDetector(
            onLongPress: m != null && onLongPress != null ? () => onLongPress!(m.uid, m.name) : null,
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 2),
              child: RichText(
                text: TextSpan(style: const TextStyle(fontSize: 13, shadows: [Shadow(blurRadius: 4)]), children: [
                  TextSpan(text: '${l.from}  ', style: const TextStyle(fontWeight: FontWeight.w800, color: Colors.white70)),
                  TextSpan(text: l.text, style: const TextStyle(color: Colors.white)),
                ]),
              ),
            ),
          );
        },
      ),
    );
  }
}

/// Bullet-style flying messages across the video.
class FlyLayer extends StatelessWidget {
  final List<FlyMsg> msgs;
  const FlyLayer({super.key, required this.msgs});

  @override
  Widget build(BuildContext context) {
    return IgnorePointer(
      child: LayoutBuilder(builder: (_, c) {
        return Stack(children: [
          for (final m in msgs)
            TweenAnimationBuilder<double>(
              key: ValueKey(m.bornAt ^ m.text.hashCode),
              tween: Tween(begin: 1.0, end: -0.6),
              duration: const Duration(seconds: 7),
              builder: (_, v, child) => Positioned(
                left: c.maxWidth * v,
                top: 60 + m.lane * (c.maxHeight * .35),
                child: child!,
              ),
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                decoration: BoxDecoration(color: Colors.black45, borderRadius: BorderRadius.circular(16)),
                child: Text(m.text, style: const TextStyle(color: Colors.white, fontSize: 13, fontWeight: FontWeight.w600)),
              ),
            ),
        ]);
      }),
    );
  }
}

/// Tap-burst hearts/emoji floating up from the bottom-right.
class ReactionLayer extends StatelessWidget {
  final List<ReactionBurst> bursts;
  const ReactionLayer({super.key, required this.bursts});

  @override
  Widget build(BuildContext context) {
    return IgnorePointer(
      child: LayoutBuilder(builder: (_, c) {
        return Stack(children: [
          for (final b in bursts)
            TweenAnimationBuilder<double>(
              key: ValueKey(b.bornAt ^ b.emoji.hashCode ^ b.x.hashCode),
              tween: Tween(begin: 0, end: 1),
              duration: const Duration(milliseconds: 1800),
              builder: (_, v, __) => Positioned(
                left: c.maxWidth * b.x + sin(v * 6) * 14,
                bottom: 90 + v * (c.maxHeight * .5),
                child: Opacity(opacity: (1 - v).clamp(0, 1), child: Text(b.emoji, style: TextStyle(fontSize: 22 + v * 8))),
              ),
            ),
        ]);
      }),
    );
  }
}

/// Donation banner that animates on-stream for everyone.
class DonationBannerWidget extends StatelessWidget {
  final DonationBanner banner;
  const DonationBannerWidget({super.key, required this.banner});

  @override
  Widget build(BuildContext context) {
    return TweenAnimationBuilder<double>(
      key: ValueKey('${banner.name}${banner.amount}${banner.hashCode}'),
      tween: Tween(begin: 0, end: 1),
      duration: const Duration(milliseconds: 400),
      builder: (_, v, child) => Transform.scale(scale: .8 + v * .2, child: Opacity(opacity: v, child: child)),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
        decoration: BoxDecoration(
          gradient: const LinearGradient(colors: [Color(0xFFFFB300), Color(0xFFFF6F00)]),
          borderRadius: BorderRadius.circular(14),
          boxShadow: const [BoxShadow(color: Colors.black38, blurRadius: 8)],
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          const Text('💰 ', style: TextStyle(fontSize: 18)),
          Text('${banner.name} donated \$${(banner.amount / 100).toStringAsFixed(2)}',
              style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w800)),
        ]),
      ),
    );
  }
}

/// Top bar: creator chip → channel, LIVE badge, viewer count, time remaining.
class LiveTopBar extends StatelessWidget {
  final String title;
  final bool live;
  final int watching;
  final int? remainingMs;
  final VoidCallback? onCreatorTap;
  final VoidCallback onClose;
  const LiveTopBar({super.key, required this.title, required this.live, required this.watching, this.remainingMs, this.onCreatorTap, required this.onClose});

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        child: Row(children: [
          Expanded(
            child: GestureDetector(
              onTap: onCreatorTap,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                decoration: BoxDecoration(color: Colors.black38, borderRadius: BorderRadius.circular(20)),
                child: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis,
                    style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700, fontSize: 13)),
              ),
            ),
          ),
          const SizedBox(width: 8),
          if (live)
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
              decoration: BoxDecoration(color: AvaColors.coral, borderRadius: BorderRadius.circular(6)),
              child: const Text('LIVE', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w900, fontSize: 11)),
            ),
          const SizedBox(width: 8),
          _pill(Icons.visibility, '$watching'),
          if (remainingMs != null) ...[const SizedBox(width: 6), _pill(Icons.timer_outlined, fmtClock(remainingMs!))],
          const SizedBox(width: 6),
          GestureDetector(
            onTap: onClose,
            child: Container(
              padding: const EdgeInsets.all(6),
              decoration: const BoxDecoration(color: Colors.black38, shape: BoxShape.circle),
              child: const Icon(Icons.close, color: Colors.white, size: 18),
            ),
          ),
        ]),
      ),
    );
  }

  Widget _pill(IconData ic, String t) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
        decoration: BoxDecoration(color: Colors.black38, borderRadius: BorderRadius.circular(12)),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Icon(ic, color: Colors.white, size: 13),
          const SizedBox(width: 4),
          Text(t, style: const TextStyle(color: Colors.white, fontSize: 12, fontWeight: FontWeight.w700)),
        ]),
      );
}

/// "Creator reconnecting…" overlay (A4) — auto-resumes when host-live returns.
class ReconnectingOverlay extends StatelessWidget {
  const ReconnectingOverlay({super.key});
  @override
  Widget build(BuildContext context) {
    return Container(
      color: Colors.black54,
      alignment: Alignment.center,
      child: Column(mainAxisSize: MainAxisSize.min, children: const [
        CircularProgressIndicator(color: Colors.white),
        SizedBox(height: 16),
        Text('Creator reconnecting…', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w700)),
        SizedBox(height: 4),
        Text('The stream resumes automatically.', style: TextStyle(color: Colors.white70, fontSize: 12)),
      ]),
    );
  }
}
