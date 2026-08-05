import 'package:flutter/material.dart';

import 'avatok_dark.dart' show AD;

/// [UI-MSG-THEME-1] 2026-08-05 — the ONE rulebook for the messenger surface.
///
/// ## Why this exists
///
/// The 2026-08-05 UI audit found eight parallel design systems live at once
/// (Zine, AD, AW, BubbleTheme, AvaDialTheme, PhoneTheme, IntentTheme,
/// LiveTheme), with 9 files mixing two of them inside a single widget tree.
/// The chat surface was the worst offender: the new-chat sheet in
/// `chat_list.dart` drew cream-paper `Zine` icon badges on a near-black `AD`
/// sheet, and the tab strip below it used Material icons while everything
/// around it used Phosphor.
///
/// `Msg` is the fix. It is a thin, opinionated layer **on top of AD tokens** —
/// it does not introduce a new palette, it constrains the existing one.
///
/// ## The contract for chat screens
///
/// * **Never** import `zine.dart`, `wallet_theme.dart`, or any feature palette
///   into a chat file. If you need a value, add it here.
/// * Radii are **8 / 12 / 16 only**. Pills (`rPill`) are reserved for unread
///   badges, tags, status indicators and avatars — nothing else. The audit
///   counted 233 pill shapes app-wide; that single fact is most of why the
///   product read as a kids' app.
/// * Spacing comes off a 4px grid. No 3s, 7s, 9s, 11s.
/// * Motion is `fast` / `base` / `slow` and nothing else. No bounce, no
///   elastic, no overshoot, no glowing halos, no infinite decorative loops.
/// * Colour is near-black + white + grey + ONE accent + red for errors.
///   Colour must MEAN something (unread, error, live). It is not decoration.
/// * Type comes from `ADText`, which is already reweighted (400 body,
///   500/600 emphasis, 700 titles, never 800/900).
class Msg {
  Msg._();

  // ------------------------------------------------------------------ radii
  // Three values. That is the whole scale.
  /// Chips, small badges, inline controls.
  static const double rSm = 8;
  /// Buttons, inputs, list rows, bubbles.
  static const double rMd = 12;
  /// Cards, sheets, dialogs, menus.
  static const double rLg = 16;
  /// Fully round. ONLY for: unread badges, status dots, tags, avatars,
  /// and the drag handle on a bottom sheet. Not for buttons. Not for cards.
  static const double rPill = 999;

  static final BorderRadius brSm = BorderRadius.circular(rSm);
  static final BorderRadius brMd = BorderRadius.circular(rMd);
  static final BorderRadius brLg = BorderRadius.circular(rLg);
  static final BorderRadius brPill = BorderRadius.circular(rPill);

  /// Bottom sheets — rounded top corners only.
  static const BorderRadius brSheetTop =
      BorderRadius.vertical(top: Radius.circular(rLg));

  // ---------------------------------------------------------------- spacing
  // 4px grid. Use these names, not raw numbers.
  static const double s1 = 4;
  static const double s2 = 8;
  static const double s3 = 12;
  static const double s4 = 16;
  static const double s5 = 24;
  static const double s6 = 32;

  /// Horizontal page gutter for chat screens.
  static const double gutter = s4;

  // ------------------------------------------------------------------- rows
  /// Chat-list row height. Fixed so the list is uniform AND so the list view
  /// can use a cheap extent-based layout instead of measuring every child.
  static const double rowHeight = 72;
  /// Avatar diameter in a chat-list row.
  static const double rowAvatar = 48;
  /// Avatar diameter in a thread header / bubble gutter.
  static const double smallAvatar = 32;
  /// Row padding — 16 horizontal keeps the avatar aligned with the header.
  static const EdgeInsets rowPadding =
      EdgeInsets.symmetric(horizontal: gutter, vertical: s3);
  /// Gap between the avatar and the name/preview column.
  static const double rowAvatarGap = s3;
  /// Gap between the name line and the preview line.
  static const double rowTextGap = 3;

  // ---------------------------------------------------------------- bubbles
  /// Padding inside a message bubble.
  static const EdgeInsets bubblePadding =
      EdgeInsets.symmetric(horizontal: s3, vertical: s2);
  /// Vertical gap between consecutive bubbles from different senders.
  static const double bubbleGap = s2;
  /// Vertical gap between consecutive bubbles from the SAME sender.
  static const double bubbleGapTight = 2;
  /// Max bubble width as a fraction of screen width.
  static const double bubbleMaxWidthFactor = 0.78;

  // --------------------------------------------------------------- composer
  static const EdgeInsets composerPadding =
      EdgeInsets.symmetric(horizontal: s3, vertical: s2);
  static const double composerMinHeight = 44;
  static const double composerButton = 40;

  // ----------------------------------------------------------------- motion
  // Three durations. Replaces the 25+ ad-hoc values the audit found.
  static const Duration fast = Duration(milliseconds: 120);
  static const Duration base = Duration(milliseconds: 200);
  static const Duration slow = Duration(milliseconds: 320);

  /// The ONLY easing curve for the messenger surface.
  ///
  /// `elasticOut`, `bounceOut` and `easeOutBack` are banned here — they
  /// overshoot, and overshoot is what reads as "toy". If a transition needs
  /// personality, give it the right duration, not a springy curve.
  static const Curve curve = Curves.easeOutCubic;

  // ---------------------------------------------------------------- colours
  // Restrained palette. Everything else on a chat screen is near-black,
  // white, or grey — and comes from AD.
  /// The single brand accent. Unread, active tab, send button, FAB.
  static const Color accent = AD.primaryBadge;
  /// Errors and destructive actions ONLY.
  static const Color error = AD.danger;
  /// Live/online presence.
  static const Color online = AD.online;

  /// Neutral icon colour for the chat surface.
  ///
  /// The dark system defines a different colour per glyph — search blue, bell
  /// orange, shield green, phone teal, video purple, camera pink, emoji
  /// yellow, mic deep-purple. Eight colours in one toolbar means colour can no
  /// longer signal anything. On chat screens, icons are neutral; colour is
  /// spent only on `accent`, `error` and `online`.
  static const Color icon = AD.textSecondary;
  static const Color iconActive = AD.textPrimary;

  // -------------------------------------------------------------- elevation
  /// Chat surfaces are flat. Separation comes from hairline borders and
  /// surface colour, not from drop shadows or glows.
  ///
  /// Coloured glows (the orange halo under the FAB, the green ring around the
  /// status avatar) are removed on purpose — a coloured blur behind a control
  /// is a mobile-game signal.
  static const List<BoxShadow> none = <BoxShadow>[];

  /// The only permitted shadow: a soft lift for floating elements (FAB,
  /// bottom sheets). Neutral black, never tinted with the accent.
  static const List<BoxShadow> lift = [
    BoxShadow(color: Color(0x59000000), offset: Offset(0, 4), blurRadius: 12),
  ];

  /// Hairline divider between rows.
  static const BorderSide hairline =
      BorderSide(color: AD.borderHairline, width: 1);
}
