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
/// [RAJ-PHASE2-2] That claim was ALMOST true and is now actually true. This file
/// held one hardcoded hex — `input = Color(0xFF202C33)`, the WhatsApp dark slate
/// — described as "aligned with the incoming-bubble family" long after the
/// incoming bubble family became cream. It painted the chat composer, the
/// single most-used control in the product, as a dark bar on a cream thread.
///
/// Phase 2's list was six feature palettes plus `bubble_theme.dart`; this file
/// was never on it, because it presents itself as a layer over AD rather than a
/// palette. That is precisely why it got missed. There is now ZERO hex below
/// this line — every colour is an AD alias. Keep it that way.
///
/// ## The contract for chat screens
///
/// * **Never** import a feature palette (`wallet_theme.dart`, `phone_theme.dart`,
///   …) into a chat file. If you need a value, add it here as an AD alias.
/// * Radii are **8 / 12 / 16 only**. Pills (`rPill`) are reserved for unread
///   badges, tags, status indicators and avatars — nothing else. The audit
///   counted 233 pill shapes app-wide; that single fact is most of why the
///   product read as a kids' app.
/// * Spacing comes off a 4px grid. No 3s, 7s, 9s, 11s.
/// * Motion is `fast` / `base` / `slow` and nothing else. No bounce, no
///   elastic, no overshoot, no glowing halos, no infinite decorative loops.
/// * Colour is paper + ink + ONE accent + red for errors. Colour must MEAN
///   something (unread, error, live). It is not decoration.
/// * Type comes from `ADText`: platform-native face, 400 body, 500 emphasis,
///   700 titles, never 800/900. **Phase 5 has not landed** — if a bundled
///   display family arrives, this ceiling is the thing it has to renegotiate,
///   not quietly exceed.
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
  ///
  /// ⚠️ [RAJ-PHASE5-RISK] This and the four constants below are FIXED PIXEL
  /// boxes, and a user-controlled FontScale multiplies the type inside them.
  /// They are the RenderFlex overflow surface for any type change — not the
  /// font file itself. Anything that raises line height (a bundled display
  /// face, a weight above 700, looser tracking) has to be tested against these
  /// five numbers at the largest FontScale the app offers, on a device.
  static const double rowHeight = 72;
  /// Avatar diameter in a chat-list row.
  static const double rowAvatar = 48;

  /// [UI-COLDSTART-1 2026-08-05] Width of the whole leading slot in a chat-list
  /// row — the avatar PLUS whatever decoration surrounds it.
  ///
  /// WHY THIS EXISTS: the leading widget has two forms. With an unseen status
  /// it is a `StatusRing`, which measures `rowAvatar + 2*(stroke + 2)` = 57.
  /// Without one it is a bordered circle, which measures `rowAvatar + 2*2` = 52.
  /// Statuses resolve asynchronously AFTER the first frame, so every row with a
  /// status silently grew 5px wider the moment they landed — nudging that row's
  /// name and preview sideways. That is part of the "rows adjust themselves"
  /// the owner reported on launch. Both forms are now centred inside a slot of
  /// this fixed width, so the text column starts at the same x on every row
  /// whether or not a status ever arrives.
  static const double rowLeading = 57;

  /// [UI-COLDSTART-1 2026-08-05] Width of the trailing slot in a chat-list row
  /// (timestamp above, unread badge below).
  ///
  /// This is a MINIMUM, not a fixed width, and that is deliberate. The longest
  /// string the list renders is 'Yesterday' — 9 glyphs of 12px 400, about 56px
  /// — and the app applies a user-controlled FontScale on top, so a hard width
  /// would clip or overflow for anyone running large text. Reserving a floor is
  /// enough to stop the cold-start reflow (the real problem is '' at 0px
  /// becoming '14:32' at ~40px) while still letting the column grow.
  static const double rowTrailing = 64;
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
  // Restrained palette. Everything else on a chat screen is paper, ink or a
  // muted ink tint — and comes from AD.
  /// The single brand accent. Unread, active tab, send button, FAB.
  static const Color accent = AD.primaryBadge;

  /// The chat composer / input surface — RAISED PAPER, the same tone as an
  /// incoming bubble.
  ///
  /// [RAJ-PHASE2-2] Was `Color(0xFF202C33)`: WhatsApp's dark slate, hardcoded
  /// here, with a comment claiming it was "aligned with the incoming-bubble
  /// family" — which by then meant cream `AD.bubbleInBg`. The composer was a
  /// dark bar under a cream thread on the app's most-used screen. It now
  /// aliases `AD.inputField`, which IS that family, so the two cannot drift
  /// apart again.
  static const Color input = AD.inputField;

  /// Errors and destructive actions ONLY.
  static const Color error = AD.danger;
  /// Live/online presence.
  static const Color online = AD.online;

  /// Neutral icon colour for the chat surface.
  ///
  /// The old system defined a different colour per glyph — search blue, bell
  /// orange, shield green, phone teal, video purple, camera pink, emoji
  /// yellow, mic deep-purple. Eight colours in one toolbar means colour can no
  /// longer signal anything. On chat screens, icons are neutral; colour is
  /// spent only on `accent`, `error` and `online`.
  static const Color icon = AD.textSecondary;
  static const Color iconActive = AD.textPrimary;

  // -------------------------------------------------------------- elevation
  /// Chat surfaces are flat. Separation comes from ink outlines and surface
  /// colour, not from drop shadows or glows.
  ///
  /// Coloured glows (the orange halo under the FAB, the green ring around the
  /// status avatar) are removed on purpose — a coloured blur behind a control
  /// is a mobile-game signal.
  static const List<BoxShadow> none = <BoxShadow>[];

  /// The only permitted shadow: a HARD ink offset for floating elements (FAB,
  /// bottom sheets). Never tinted with the accent, and never blurred.
  ///
  /// [RAJ-PHASE3-1] Was a soft blur (0x59000000, 0/4, blur 12). HANDOFF rule 4
  /// is hard offset shadows only — a blur is a screen-glow signal and reads
  /// wrong against block-printed ink outlines.
  static const List<BoxShadow> lift = [
    BoxShadow(color: AD.textPrimary, offset: Offset(3, 4), blurRadius: 0),
  ];

  /// The 2px ink OUTLINE that HANDOFF rule 1 puts on cards, rows, inputs,
  /// chips and buttons.
  ///
  /// [RAJ-PHASE1-2] Use this for an edge that defines a shape. Use [hairline]
  /// only for a rule BETWEEN rows. Those were the same value for a while — full
  /// ink at 1px — which is why some screens outline at 2px and others at 1px.
  static const BorderSide border =
      BorderSide(color: AD.borderCard, width: AD.wBorder);

  /// Faint rule between rows. NOT an outline.
  ///
  /// [RAJ-PHASE1-2] Was `AD.borderHairline` at 1px, which Phase 1 refilled with
  /// FULL INK because that token's other job is card outlines. A list of rows
  /// separated by solid black 1px rules reads as a table grid. `borderDivider`
  /// is ink at 14% — the same value the bead-stud rule uses.
  static const BorderSide hairline =
      BorderSide(color: AD.borderDivider, width: 1);
}
