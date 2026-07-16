import 'package:flutter/material.dart';

/// Chat bubble theming contract — the SINGLE source of truth for what colour a
/// message bubble is painted, for BOTH 1:1 and group threads, and for EVERY
/// bubble kind (text, image, video, audio/voice note, file, link preview,
/// youtube, sticker, poll, location, contact card, Ava).
///
/// Owner decision 2026-07-17:
///   * The thread canvas is WHITE ([kChatCanvas]) for 1:1 and group threads.
///   * Every bubble sits inside a PALE fill that is easy on the eyes.
///   * In a group, each participant gets their OWN pale colour so you can tell
///     at a glance who is speaking.
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
  /// Bubble fill. Always pale.
  final Color bg;

  /// Body text / primary icon colour. Guaranteed >= 4.5:1 against [bg].
  final Color ink;

  /// Timestamp, tick row, caption, secondary label.
  final Color meta;

  /// Play button, waveform active, progress accents.
  final Color play;

  /// Hairline border. Needed because pale bubbles on a white canvas would
  /// otherwise have no edge at all.
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
  topLeft: Radius.circular(14),
  topRight: Radius.circular(4),
  bottomLeft: Radius.circular(14),
  bottomRight: Radius.circular(14),
);

/// Tail-on-left (their messages).
const BorderRadius kBubbleRadiusIn = BorderRadius.only(
  topLeft: Radius.circular(4),
  topRight: Radius.circular(14),
  bottomLeft: Radius.circular(14),
  bottomRight: Radius.circular(14),
);

/// My own bubbles — pale green, in every thread type.
const BubbleTheme kBubbleMine = BubbleTheme(
  bg: Color(0xFFDCF3E2),
  ink: Color(0xFF15301F),
  meta: Color(0xFF4E7A5D),
  play: Color(0xFF3E8E5A),
  border: Color(0xFFBFE3CA),
  radius: kBubbleRadiusOut,
);

/// Incoming bubbles in a 1:1 thread, and the neutral fallback anywhere.
const BubbleTheme kBubbleTheirs = BubbleTheme(
  bg: Color(0xFFF1EFFA),
  ink: Color(0xFF241F3A),
  meta: Color(0xFF6E699A),
  play: Color(0xFF6A63B8),
  border: Color(0xFFDDD8F0),
  radius: kBubbleRadiusIn,
);

/// Ava (the assistant) — distinct from any human, never drawn from the palette.
const BubbleTheme kBubbleAva = BubbleTheme(
  bg: Color(0xFFEFF4FB),
  ink: Color(0xFF17263C),
  meta: Color(0xFF5F7492),
  play: Color(0xFF3D6FA8),
  border: Color(0xFFD6E3F2),
  radius: kBubbleRadiusIn,
);

/// Per-sender pale palette for GROUP threads — 12 entries so a realistic group
/// rarely collides. Ordered so adjacent entries are visually distinct (a
/// hash lands anywhere, but neighbours in a small group often differ by 1).
///
/// Every entry is hand-checked for >= 4.5:1 ink-on-bg and >= 3:1 meta-on-bg.
const List<BubbleTheme> kGroupSenderPalette = [
  // lilac
  BubbleTheme(bg: Color(0xFFF1EFFA), ink: Color(0xFF241F3A), meta: Color(0xFF6E699A), play: Color(0xFF6A63B8), border: Color(0xFFDDD8F0), radius: kBubbleRadiusIn),
  // peach
  BubbleTheme(bg: Color(0xFFFDEEE3), ink: Color(0xFF3B2415), meta: Color(0xFF8A6046), play: Color(0xFFC07A4E), border: Color(0xFFF3DAC6), radius: kBubbleRadiusIn),
  // mint
  BubbleTheme(bg: Color(0xFFE6F5EC), ink: Color(0xFF16311F), meta: Color(0xFF4F7A5F), play: Color(0xFF4E9A6E), border: Color(0xFFCCE7D8), radius: kBubbleRadiusIn),
  // sky
  BubbleTheme(bg: Color(0xFFE8F1FB), ink: Color(0xFF152A40), meta: Color(0xFF4E7091), play: Color(0xFF5583B0), border: Color(0xFFCEE1F3), radius: kBubbleRadiusIn),
  // rose
  BubbleTheme(bg: Color(0xFFFCEBF1), ink: Color(0xFF3A1A26), meta: Color(0xFF8B5670), play: Color(0xFFB76A85), border: Color(0xFFF2D3DF), radius: kBubbleRadiusIn),
  // butter
  BubbleTheme(bg: Color(0xFFFBF3DC), ink: Color(0xFF352A0E), meta: Color(0xFF7C6830), play: Color(0xFFA98B34), border: Color(0xFFEEE1BC), radius: kBubbleRadiusIn),
  // aqua
  BubbleTheme(bg: Color(0xFFE4F4F4), ink: Color(0xFF12302F), meta: Color(0xFF477877), play: Color(0xFF3F918F), border: Color(0xFFC8E6E5), radius: kBubbleRadiusIn),
  // terra
  BubbleTheme(bg: Color(0xFFFAECE7), ink: Color(0xFF3B1F17), meta: Color(0xFF8A5645), play: Color(0xFFB2664F), border: Color(0xFFEFD5CC), radius: kBubbleRadiusIn),
  // sage
  BubbleTheme(bg: Color(0xFFEDF3E6), ink: Color(0xFF232E17), meta: Color(0xFF61764C), play: Color(0xFF6E8B4E), border: Color(0xFFD8E4C9), radius: kBubbleRadiusIn),
  // periwinkle
  BubbleTheme(bg: Color(0xFFEBEDFB), ink: Color(0xFF1C2140), meta: Color(0xFF5C639A), play: Color(0xFF5A63B8), border: Color(0xFFD3D7F1), radius: kBubbleRadiusIn),
  // clay
  BubbleTheme(bg: Color(0xFFF7EFE6), ink: Color(0xFF33261A), meta: Color(0xFF7A634B), play: Color(0xFF9B7A53), border: Color(0xFFE8DACA), radius: kBubbleRadiusIn),
  // teal-grey
  BubbleTheme(bg: Color(0xFFEAF0F1), ink: Color(0xFF1B2A2D), meta: Color(0xFF556C71), play: Color(0xFF4C767D), border: Color(0xFFD2E0E2), radius: kBubbleRadiusIn),
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
  String? senderKey,
}) {
  if (isAva) return kBubbleAva;
  if (mine) return kBubbleMine;
  if (!isGroup) return kBubbleTheirs;
  final key = senderKey?.trim() ?? '';
  if (key.isEmpty) return kBubbleTheirs;
  return kGroupSenderPalette[groupSenderPaletteIndex(key)];
}

/// Sender-name header colour inside a group bubble — a saturated sibling of the
/// bubble's own [BubbleTheme.play], so the name matches the bubble it sits in.
Color groupSenderNameColor(String senderKey) =>
    kGroupSenderPalette[groupSenderPaletteIndex(senderKey)].play;
