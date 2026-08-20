import 'package:flutter/material.dart';

import 'avatok_dark.dart';
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

// [RAJ-PHASE2-1] This whole file was a SECOND palette. It still held
// WhatsApp-derived hex (green #005C4B, slate #202C33, ink #E9EDEF, pure-white
// canvas) long after Phase 1 put the correct bubble values in `AD` — so the two
// had silently drifted, and the most-looked-at surface in the app was the one
// still off-palette. Every colour below is now an ALIAS of an `AD` token. Keep
// it that way: a colour defined here rather than in avatok_dark.dart is a
// colour that will drift again.
//
// Shape is untouched — the 4px tail corner and the radii were already correct.

/// The thread canvas — the warm cream, NOT paper-white. Nothing in this
/// palette is #FFFFFF; `AD.card` (#FFFAF0) is the raised-paper tone and the
/// canvas is the warmer `AD.bg`.
const Color kChatCanvas = AD.bg;

/// Faint separator / day-pill colours that read correctly on [kChatCanvas].
const Color kChatCanvasInk = AD.textPrimary;
const Color kChatCanvasMeta = AD.textSecondary;
const Color kChatSysPillBg = AD.card;

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

/// My own bubbles — indigo with cream type.
const BubbleTheme kBubbleMine = BubbleTheme(
  bg: AD.bubbleOutBg,
  ink: AD.bubbleOutInk,
  meta: AD.bubbleOutMeta,
  play: AD.bubbleOutPlay,
  border: AD.borderCard,
  radius: kBubbleRadiusOut,
);

/// Incoming bubbles in every human thread, including groups. Sender labels and
/// avatars carry identity instead of colourful fills.
///
/// The ink border is load-bearing here, not decoration: paper-cream on cream
/// canvas has almost no edge of its own, so the outline is what makes the
/// bubble read as a shape at all.
const BubbleTheme kBubbleTheirs = BubbleTheme(
  bg: AD.bubbleInBg,
  ink: AD.bubbleInInk,
  meta: AD.bubbleInMeta,
  play: AD.bubbleInPlay,
  border: AD.borderCard,
  radius: kBubbleRadiusIn,
);

/// The Ava lane — rani pink with cream type, deliberately distinct from BOTH
/// the outgoing indigo and the incoming cream so an Ava reply is never mistaken
/// for either party's message.
const BubbleTheme kBubbleAva = BubbleTheme(
  bg: AD.bubbleAvaBg,
  ink: AD.bubbleAvaInk,
  meta: AD.bubbleAvaMeta,
  play: AD.haldi,
  border: AD.borderCard,
  radius: kBubbleRadiusIn,
);

/// Private Ava turns — both the user's question and Ava's reply. Kept visibly
/// unlike public Ava and ordinary human chat so private content is recognisable
/// at a glance: the haldi fill is the one bubble in the set that is neither
/// indigo, cream nor rani.
const BubbleTheme kBubbleAvaPrivate = BubbleTheme(
  bg: AD.haldi,
  ink: AD.onBandInk,
  meta: AD.textSecondary,
  play: AD.primaryBadge,
  border: AD.borderCard,
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
