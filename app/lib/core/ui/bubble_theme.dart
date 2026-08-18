import 'package:flutter/material.dart';

import 'messenger_theme.dart';

/// Chat bubble theming contract — the SINGLE source of truth for what colour a
/// message bubble is painted, for BOTH 1:1 and group threads, and for EVERY
/// bubble kind (text, image, video, audio/voice note, file, link preview,
/// youtube, sticker, poll, location, contact card, Ava).
///
/// Stable chat visual direction (UI-WHATSAPP-STABLE-1):
///   * Threads use a dark canvas with compact, low-noise bubbles.
///   * Incoming messages use one neutral slate; outgoing messages use muted
///     WhatsApp green.
///   * Group identity comes from the sender label/avatar, never rainbow bubble
///     fills. This makes a busy conversation calmer and easier to scan.
///
/// Why this file exists: before it, `AD.bubbleInBg` / `AD.bubbleInInk` /
/// `AD.bubbleInMeta` were referenced *literally* at ~10 sites inside
/// `chat_thread._bubble` and every card in `chat_media_cards.dart` decided its
/// own colours from a bare `onRight` bool. That made per-sender tinting
/// impossible to do correctly — the fill changed but the ink did not, so
/// contrast was undefined. Resolve ONE [BubbleTheme] per message and thread it
/// down; never re-derive colours from `onRight` inside a card.
@immutable
class BubbleTheme {
  /// Bubble fill.
  final Color bg;

  /// Body text / primary icon colour. Guaranteed >= 4.5:1 against [bg].
  final Color ink;

  /// Timestamp, tick row, caption, secondary label.
  final Color meta;

  /// Play button, waveform active, progress accents.
  final Color play;

  /// Internal separator and small-control border colour. Normal text bubbles
  /// deliberately do not draw an outer border.
  final Color border;

  /// Corner rounding — tail on the correct side.
  final BorderRadius radius;

  const BubbleTheme({
    required this.bg,
    required this.ink,
    required this.meta,
    required this.play,
    required this.border,
    required this.radius,
  });

  BubbleTheme copyWith({
    Color? bg,
    Color? ink,
    Color? meta,
    Color? play,
    Color? border,
    BorderRadius? radius,
  }) =>
      BubbleTheme(
        bg: bg ?? this.bg,
        ink: ink ?? this.ink,
        meta: meta ?? this.meta,
        play: play ?? this.play,
        border: border ?? this.border,
        radius: radius ?? this.radius,
      );
}

/// The thread canvas. White, per owner decision 2026-07-17.
const Color kChatCanvas = Color(0xFFFFFFFF);

/// Faint separator / day-pill colours that read correctly on [kChatCanvas].
const Color kChatCanvasInk = Color(0xFF1F2430);
const Color kChatCanvasMeta = Color(0xFF6B7280);
const Color kChatSysPillBg = Color(0xFFF1F2F5);

/// Tail-on-right (my messages).
const BorderRadius kBubbleRadiusOut = BorderRadius.only(
  topLeft: Radius.circular(Msg.rMd),
  topRight: Radius.circular(4),
  bottomLeft: Radius.circular(Msg.rMd),
  bottomRight: Radius.circular(Msg.rMd),
);

/// Tail-on-left (their messages).
const BorderRadius kBubbleRadiusIn = BorderRadius.only(
  topLeft: Radius.circular(4),
  topRight: Radius.circular(Msg.rMd),
  bottomLeft: Radius.circular(Msg.rMd),
  bottomRight: Radius.circular(Msg.rMd),
);

/// My own bubbles — WhatsApp dark-mode inspired muted green.
const BubbleTheme kBubbleMine = BubbleTheme(
  bg: Color(0xFF005C4B),
  ink: Color(0xFFE9EDEF),
  meta: Color(0xFFA6D6C9),
  play: Color(0xFFD9FDD3),
  border: Color(0xFF1A7462),
  radius: kBubbleRadiusOut,
);

/// Incoming bubbles in every human thread: a single quiet slate, including
/// groups. Sender labels and avatars carry identity instead of colourful fills.
const BubbleTheme kBubbleTheirs = BubbleTheme(
  bg: Color(0xFF202C33),
  ink: Color(0xFFE9EDEF),
  meta: Color(0xFFAEBAC1),
  play: Color(0xFF53BDEB),
  border: Color(0xFF3B4A54),
  radius: kBubbleRadiusIn,
);

/// Ava remains identifiable, but uses a restrained blue-slate rather than a
/// pastel card so it belongs to the same stable chat system.
const BubbleTheme kBubbleAva = BubbleTheme(
  bg: Color(0xFF243542),
  ink: Color(0xFFE9EDEF),
  meta: Color(0xFFB6C7D5),
  play: Color(0xFF7CC4FF),
  border: Color(0xFF405767),
  radius: kBubbleRadiusIn,
);

/// Private Ava turns — both the user's question and Ava's reply use the same
/// soft lavender fill. The light treatment is intentionally unlike public Ava
/// and ordinary human chat, so private content is recognizable at a glance.
const BubbleTheme kBubbleAvaPrivate = BubbleTheme(
  bg: Color(0xFFEDE7FF),
  ink: Color(0xFF211A35),
  meta: Color(0xFF665C7A),
  play: Color(0xFF6D4BD2),
  border: Color(0xFFC6B8EE),
  radius: kBubbleRadiusIn,
);

/// Compatibility palette for group sender resolution. All entries intentionally
/// resolve to the same neutral incoming treatment; identity is provided by the
/// sender header and avatar, not a rainbow of card backgrounds.
const List<BubbleTheme> kGroupSenderPalette = [
  kBubbleTheirs, kBubbleTheirs, kBubbleTheirs, kBubbleTheirs,
  kBubbleTheirs, kBubbleTheirs, kBubbleTheirs, kBubbleTheirs,
  kBubbleTheirs, kBubbleTheirs, kBubbleTheirs, kBubbleTheirs,
];

/// Stable index for [senderKey] into [kGroupSenderPalette].
///
/// IMPORTANT: [senderKey] MUST be a stable identity — a `senderPub`/uid — and
/// NEVER a display name. The old `_groupSenderTint` hashed the display name, so
/// a member renaming themselves silently reshuffled their colour mid-thread.
///
/// Uses an FNV-1a hash rather than `String.hashCode` because Dart's hashCode is
/// not guaranteed stable across runs/platforms, which would let a sender's
/// colour change between app launches.
int groupSenderPaletteIndex(String senderKey) {
  var h = 0x811c9dc5;
  for (var i = 0; i < senderKey.length; i++) {
    h ^= senderKey.codeUnitAt(i);
    h = (h * 0x01000193) & 0xFFFFFFFF;
  }
  return h % kGroupSenderPalette.length;
}

/// Resolve the one [BubbleTheme] for a message. Call this ONCE per bubble and
/// pass the result down; do not re-derive colours further down the tree.
///
/// * [mine] — the message is from the local user.
/// * [isAva] — the message is from/to Ava.
/// * [isGroup] — the thread is a group thread.
/// * [senderKey] — the sender's STABLE uid (`senderPub`). Only consulted for
///   incoming group messages. Null/empty falls back to [kBubbleTheirs].
BubbleTheme resolveBubbleTheme({
  required bool mine,
  required bool isGroup,
  bool isAva = false,
  bool isPrivateAva = false,
  bool privateOnRight = false,
  String? senderKey,
}) {
  if (isPrivateAva) {
    return kBubbleAvaPrivate.copyWith(
      radius: privateOnRight ? kBubbleRadiusOut : kBubbleRadiusIn,
    );
  }
  if (isAva) return kBubbleAva;
  if (mine) return kBubbleMine;
  if (!isGroup) return kBubbleTheirs;
  final key = senderKey?.trim() ?? '';
  if (key.isEmpty) return kBubbleTheirs;
  return kGroupSenderPalette[groupSenderPaletteIndex(key)];
}

/// Sender-name header colour inside a group bubble. The uniform accent prevents
/// the old rainbow-card effect while keeping names easy to spot.
Color groupSenderNameColor(String _) => kBubbleTheirs.play;
