// Phase 7 — shared AvaLive overlay layer (TikTok/YouTube-Live conventions):
// scrolling chat, flying (bullet) messages, tap-burst emoji reactions, sticker
// sends, donation banners, viewer count, countdowns. Pure presentation — the
// screens own the RoomChannel and feed events in.
//
// Zine treatment: the video is content and stays full-bleed; ALL chrome here is
// zine — flat ink-alpha bands/pills over the video (white text allowed only
// inside those), ink-bordered circle buttons, coral LIVE sticker, mint money.
import 'dart:math';

import 'package:flutter/material.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../core/ui/zine.dart';

const kStickerCatalog = ['🔥', '💎', '🎉', '👏', '😂', '😍', '🚀', '👑']; // tiny static set, tree-shaken
const kReactionEmojis = ['❤️', '🔥', '😂', '👏', '😮', '💯'];

String fmtClock(int ms) {
  final s = (ms / 1000).floor().clamp(0, 359999);
  final h = s ~/ 3600, m = (s % 3600) ~/ 60, ss = s % 60;
  final mm = m.toString().padLeft(2, '0'), sss = ss.toString().padLeft(2, '0');
  return h > 0 ? '$h:$mm:$sss' : '$mm:$sss';
}

/// Flat ink-alpha overlay tint — the ONLY dim allowed over video (no gradients).
final Color kInkScrim = Zine.ink.withValues(alpha: 0.55);
final Color kInkScrimHeavy = Zine.ink.withValues(alpha: 0.72);

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

/// Ink-bordered circle control (§7.7) for live chrome — card fill by default,
/// lime when active, coral for danger/end (white icon allowed on coral only).
class LiveCircleButton extends StatelessWidget {
  final IconData icon;
  final VoidCallback? onTap;
  final Color fill;
  final double size;
  final String? tooltip;
  const LiveCircleButton({super.key, required this.icon, this.onTap, this.fill = Zine.card, this.size = 46, this.tooltip});
  @override
  Widget build(BuildContext context) {
    final fg = fill == Zine.coral ? Colors.white : Zine.ink;
    final core = GestureDetector(
      onTap: onTap,
      child: Container(
        width: size, height: size,
        decoration: BoxDecoration(
          color: fill,
          shape: BoxShape.circle,
          border: Border.all(color: Zine.ink, width: Zine.bw),
          boxShadow: Zine.shadowXs,
        ),
        child: Icon(icon, size: size * 0.46, color: fg),
      ),
    );
    if (tooltip == null) return core;
    return Tooltip(message: tooltip!, child: core);
  }
}

/// Mono info pill on a flat ink-alpha band (over video — white text allowed).
class LiveInkPill extends StatelessWidget {
  final String text;
  final IconData? icon;
  const LiveInkPill(this.text, {super.key, this.icon});
  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(color: kInkScrim, borderRadius: BorderRadius.circular(100)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        if (icon != null) ...[
          Icon(icon, color: Colors.white, size: 13),
          const SizedBox(width: 5),
        ],
        Text(text.toUpperCase(), style: ZineText.tag(size: 11, color: Colors.white)),
      ]),
    );
  }
}

/// Scrolling chat overlay (bottom-left) — §7.14 mini bubbles on ink-alpha.
class ChatOverlay extends StatelessWidget {
  final List<ChatLine> lines;
  final void Function(String uid, String name)? onLongPress; // host moderation
  final List<({String uid, String name})> meta;
  const ChatOverlay({super.key, required this.lines, this.meta = const [], this.onLongPress});

  @override
  Widget build(BuildContext context) {
    return ListView.builder(
      reverse: true,
      padding: EdgeInsets.zero,
      itemCount: lines.length,
      itemBuilder: (_, i) {
        final l = lines[lines.length - 1 - i];
        final m = i < meta.length ? meta[meta.length - 1 - i] : null;
        return GestureDetector(
          onLongPress: m != null && onLongPress != null ? () => onLongPress!(m.uid, m.name) : null,
          child: Align(
            alignment: Alignment.centerLeft,
            child: Container(
              margin: const EdgeInsets.symmetric(vertical: 2),
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
              decoration: BoxDecoration(
                color: kInkScrim,
                borderRadius: const BorderRadius.only(
                  topLeft: Radius.circular(4), // squared corner toward the sender (§7.14)
                  topRight: Radius.circular(14),
                  bottomLeft: Radius.circular(14),
                  bottomRight: Radius.circular(14),
                ),
              ),
              child: RichText(
                text: TextSpan(
                  style: ZineText.value(size: 13, color: Colors.white, weight: FontWeight.w700),
                  children: [
                    TextSpan(text: '${l.from}  ',
                        style: ZineText.tag(size: 11, color: Zine.lime)),
                    TextSpan(text: l.text),
                  ],
                ),
              ),
            ),
          ),
        );
      },
    );
  }
}

/// Bullet-style flying messages across the video — ink-alpha pills.
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
                decoration: BoxDecoration(color: kInkScrim, borderRadius: BorderRadius.circular(100)),
                child: Text(m.text, style: ZineText.value(size: 13, color: Colors.white, weight: FontWeight.w700)),
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

/// Donation banner that animates on-stream for everyone — mint = money.
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
          color: Zine.mint,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: Zine.ink, width: Zine.bw),
          boxShadow: Zine.shadowSm,
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          PhosphorIcon(PhosphorIcons.coins(PhosphorIconsStyle.fill), size: 17, color: Zine.ink),
          const SizedBox(width: 7),
          Text('${banner.name} donated \$${(banner.amount / 100).toStringAsFixed(2)}',
              style: ZineText.value(size: 14, color: Zine.ink)),
        ]),
      ),
    );
  }
}

/// Top bar: creator chip → channel, LIVE badge, viewer count, time remaining.
/// One flat ink-alpha band; LIVE = coral sticker; exit = bordered circle.
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
    return Container(
      color: kInkScrim, // flat ink-alpha band (no gradient scrims)
      child: SafeArea(
        bottom: false,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          child: Row(children: [
            Expanded(
              child: GestureDetector(
                onTap: onCreatorTap,
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 6),
                  decoration: BoxDecoration(color: kInkScrim, borderRadius: BorderRadius.circular(100)),
                  child: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis,
                      style: ZineText.value(size: 13, color: Colors.white, weight: FontWeight.w700)),
                ),
              ),
            ),
            const SizedBox(width: 8),
            if (live)
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
                decoration: BoxDecoration(
                  color: Zine.coral,
                  borderRadius: BorderRadius.circular(100),
                  border: Border.all(color: Zine.ink, width: 2),
                ),
                child: Text('LIVE', style: ZineText.tag(size: 11, color: Colors.white)),
              ),
            const SizedBox(width: 8),
            LiveInkPill('$watching', icon: PhosphorIcons.eye(PhosphorIconsStyle.bold)),
            if (remainingMs != null) ...[const SizedBox(width: 6), LiveInkPill(fmtClock(remainingMs!), icon: PhosphorIcons.timer(PhosphorIconsStyle.bold))],
            const SizedBox(width: 8),
            LiveCircleButton(icon: PhosphorIcons.x(PhosphorIconsStyle.bold), size: 36, onTap: onClose),
          ]),
        ),
      ),
    );
  }
}

/// "Creator reconnecting…" overlay (A4) — auto-resumes when host-live returns.
/// Flat ink-alpha scrim over the video.
class ReconnectingOverlay extends StatelessWidget {
  const ReconnectingOverlay({super.key});
  @override
  Widget build(BuildContext context) {
    return Container(
      color: kInkScrimHeavy,
      alignment: Alignment.center,
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        const CircularProgressIndicator(color: Zine.lime),
        const SizedBox(height: 16),
        Text('Creator reconnecting…', style: ZineText.value(size: 15, color: Colors.white)),
        const SizedBox(height: 4),
        Text('THE STREAM RESUMES AUTOMATICALLY', style: ZineText.tag(size: 10.5, color: Colors.white)),
      ]),
    );
  }
}
