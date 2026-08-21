import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

/// AvaTOK design tokens.
///
/// [RAJ-PHASE1-2] ⚠️ THIS FILE IS NO LONGER A DARK PALETTE. The class doc used
/// to describe "AvaTOK Dark v2 — near-black surfaces, hairline borders, soft
/// (blurred) elevation, pale accent cards, multicolor glyphs". Every one of
/// those clauses is now false, and leaving them here is how the wrong system
/// gets restored by the next agent to read the file. What it actually is:
///
///   * cream paper surfaces (#FBF3E2 page, #FFFAF0 raised)
///   * 2px INK outlines (`wBorder`) — not hairlines, not shadows
///   * HARD offset ink shadows, never blurs
///   * ONE neutral glyph colour plus one accent — not eight
///   * four band hues (turquoise / haldi / indigo / rani) with a documented
///     foreground rule, `onBand()`
///   * platform-native UI type; no bundled display family has landed
///
/// The CLASS NAME `AD` and every token name are unchanged on purpose: ~285
/// radius call sites and ~100 icon call sites, with no local compiler to catch
/// a rename typo. Some names therefore lie about their value (`borderHairline`
/// is full ink; `iconSearch` is neutral, not blue; `micIdleBg` is the haldi
/// accent). Each of those carries a comment saying so. Renames are a separate,
/// mechanical pass — do not mix them into a colour change.
///
/// Canonical source: the seam handoff (`design/seams/patches.md`) plus HANDOFF.md.
/// Do NOT hard-code hex in screens.
class AD {
  AD._();

  // ---------------------------------------------------------------- surfaces
  /// App / page background — the warm CREAM paper. (Was near-black.)
  static const bg = Color(0xFFFBF3E2);
  /// Header + footer bars.
  ///
  /// [RAJ-INDIGO-1 2026-08-21] ⚠️ THIS IS NO LONGER TURQUOISE. It was
  /// `#5CB8A6` — a bright sea-turquoise — which the owner rejected outright
  /// ("I don't like this turquoise, remove it from the app, wherever there
  /// is"). It is now **Jodhpur indigo `#2E4A8C`**, the blue-city wall colour,
  /// with marigold/haldi as its companion accent.
  ///
  /// THE FOREGROUND FLIPPED WITH IT. Turquoise was a LIGHT band, so
  /// `AD.onBand()` returned ink and every header in the app hardcoded
  /// `AD.textPrimary` to match. Indigo is a DARK band and takes CREAM. Any
  /// screen still hardcoding ink on `headerFooter` is ink-on-indigo, i.e.
  /// invisible. Route every header foreground through `AD.onBand(band)` —
  /// never re-hardcode a colour on a band.
  static const headerFooter = Color(0xFF2E4A8C);
  /// Card / list-row surface — raised paper.
  static const card = Color(0xFFFFFAF0);
  /// Card hover / pressed.
  static const cardHover = Color(0xFFF4E8D2);
  /// Bottom-sheet overlay surface.
  static const overlaySheet = Color(0xFFFFFAF0);
  /// Dropdown menu surface.
  static const menu = Color(0xFFFFFAF0);
  /// Popover surface.
  static const popover = Color(0xFFFFFAF0);
  /// Input field fill (search dock, composer, AdField). Raised paper — nothing
  /// in this palette is #FFFFFF.
  static const inputField = Color(0xFFFFFAF0);
  /// Modal scrim — ink @65%.
  static const scrim = Color(0xA616110D);

  // ------------------------------------------------------------------ border
  //
  // [RAJ-PHASE1-2] THREE DISTINCT JOBS, and conflating two of them was a real
  // app-wide regression. Read this before reusing one of these tokens.
  //
  //   OUTLINE  (`borderHairline` / `borderCard` / `borderControl` /
  //            `borderAvatar`) — full ink, 2px (`wBorder`). This is the edge
  //            that makes a shape read as a shape. HANDOFF rule 1.
  //   DIVIDER  (`borderDivider`) — ink at 14%, 1px. A rule BETWEEN rows.
  //   BEAD RULE (`borderBeadRule`) — the same faint value, used under a bead.
  //
  // `borderHairline` is named "hairline" but holds FULL INK: Phase 1 changed
  // values without renaming tokens, and this token's dominant job was card
  // outlines. The cost was that `DividerThemeData` pointed at it, so every
  // `Divider()` in the app — settings, lists, sheets, menus — painted solid
  // black where the design wants the faint rule. `borderDivider` exists so the
  // two jobs can never share a value again. The stray rule under the AvaDial
  // app bar was this token, not a one-off.
  static const borderHairline = Color(0xFF16110D);
  static const borderCard = Color(0xFF16110D);
  static const borderControl = Color(0xFF16110D);
  /// ⚠️ [AVATAR-NORING-1 2026-08-21] TRANSPARENT ON PURPOSE. NOT A MISTAKE.
  ///
  /// Owner request: "remove the black border on all profile icons, even the one
  /// on header besides the wallet info."
  ///
  /// The ring was drawn in ~36 places — every chat row, the header status
  /// button, contact info, group info, call screens, the dialer, the sidebar,
  /// profile, invite and add-contact sheets. Retiring the TOKEN removes all of
  /// them in one edit instead of 36 hand-edits across 23 files with no local
  /// compiler to catch a typo, and it means the next screen that copies the
  /// familiar `Border.all(color: AD.borderAvatar, width: 2)` idiom gets the new
  /// behaviour for free instead of re-introducing the ring.
  ///
  /// WHY TRANSPARENT RATHER THAN DELETING THE BORDERS: a 2px transparent border
  /// still insets its child by 2px, so every avatar keeps the exact size and
  /// position it has today. Deleting the `Border` outright would shrink each
  /// wrapper by 4px and nudge the adjacent text on every row in the app. This
  /// change is invisible except for the ring itself.
  ///
  /// This token is now AVATARS ONLY. Three former call sites that were not
  /// avatars — the accent swatch selection ring (home_appearance_screen), the
  /// circular call-action button outline (incoming_business_call_screen) and
  /// the sidebar badge outline (ava_sidebar) — were repointed to
  /// [borderControl] in the same change, because they still need a visible
  /// edge. If you need a black outline, use [borderControl]; do not "fix" this
  /// back to ink.
  static const borderAvatar = Colors.transparent;
  /// The faint rule BETWEEN rows — ink at 14%. Use for `Divider`, for a
  /// separator inside a card, for the cell rule in a bordered field. Never as
  /// the outline of a card.
  static const borderDivider = Color(0x2416110D);
  /// [RAJ-PHASE3-1] The bead-stud row rule (`BeadStudRule` in
  /// rajasthani_motifs.dart) — ink at 14%, deliberately fainter than an
  /// outline, because the bead carries the separation and a full-ink rule under
  /// it reads as two dividers stacked. Same value as [borderDivider]; kept as
  /// its own name because the motif and the plain rule are edited separately.
  static const borderBeadRule = Color(0x2416110D);

  // ----------------------------------------------------------- border widths
  /// [RAJ-PHASE1-2] HANDOFF rule 1: 2px ink on cards, rows, inputs, chips,
  /// buttons and avatars. The re-skinned widgets in this file already drew 2px
  /// by hand while everything inheriting from `ThemeData` drew 1px, so the two
  /// weights sat side by side on the same screen. Route both through here.
  static const double wBorder = 2;
  /// 3px on hero elements — FABs, call buttons, big tiles.
  static const double wHero = 3;

  // -------------------------------------------------------------- ink states
  /// [RAJ-PHASE4-1] Ripple / pressed / hover tints. Left unset these were
  /// derived from `ThemeData.brightness`, which was still `dark` after the
  /// recolour — so every ripple in the app was a pale wash that vanished on
  /// cream. Ink at low alpha reads correctly on paper.
  static const splashInk = Color(0x1416110D);
  static const highlightInk = Color(0x0D16110D);

  // ------------------------------------------------------------------ bands
  //
  // [RAJ-SEAMS-1] Header/footer band hues, named by ROLE so a screen's band can
  // be read at a glance. These are aliases of existing tokens, not new colours:
  // the seam handoff (design/seams/patches.md §6) assigns a band hue per screen
  // by mood, and `bandTurquoise` is no longer the only answer — which is why
  // `headerFooter` alone stopped being a useful name.
  /// [RAJ-INDIGO-1] The primary band — Jodhpur indigo. Use THIS name in new
  /// code.
  static const bandJodhpur = headerFooter;    // 0xFF2E4A8C — dark
  /// ⚠️ DEPRECATED NAME, NOT A TURQUOISE. Kept only because the seam call
  /// sites (`chat_list`, `chat_thread`, `groups_tab`) pass it by this name and
  /// there is no local compiler to catch a rename typo. It is `bandJodhpur`.
  /// New code uses [bandJodhpur]; a mechanical rename is a separate pass.
  static const bandTurquoise = bandJodhpur;   // 0xFF2E4A8C — dark
  static const bandHaldi = haldi;             // 0xFFE9A227 — light
  /// Still `= tabCalls` — see the warning on that token. The Calls TAB moved to
  /// terracotta (`tabCallsChip`) so it would not vanish into the indigo header
  /// band, but `tabCalls` itself had to stay indigo for its ~70 unrelated call
  /// sites, so this alias is still correct.
  static const bandIndigo = tabCalls;         // 0xFF2E4A8C — dark
  static const bandRani = primaryBadge;       // 0xFFC9316E — dark

  /// Cream for type/icons sitting ON a dark band.
  static const onBandCream = bg;              // 0xFFFBF3E2
  /// Ink for type/icons sitting ON a light band.
  static const onBandInk = textPrimary;       // 0xFF16110D

  /// The readable foreground for anything drawn ON a coloured band — the
  /// contrast rule in design/seams/patches.md §6, in one place.
  ///
  /// Turquoise and haldi are LIGHT bands and take ink; indigo and rani pink are
  /// DARK bands and take cream. This matters because every header in the app
  /// used to be turquoise, so titles and icons are hardcoded to ink all over —
  /// recolouring a band to indigo without routing its foreground through here
  /// leaves ink-on-indigo, which is very nearly invisible.
  ///
  /// [RAJ-PHASE4-1] This is also the rule the global `ColorScheme` was breaking:
  /// `onPrimary` was ink on rani pink (~3.5:1) on every FilledButton in the app,
  /// while this method says cream (~4.7:1). Anything choosing a foreground for a
  /// fill goes through here — including `AdButton`, `AdChip` and `AdSticker`
  /// below, which used to hardcode `Colors.white`.
  ///
  /// NOTE this deliberately does NOT reuse `_inkOn` in zine_widgets.dart, which
  /// patches.md §6 points at: that one is private to its file and returns
  /// `Colors.white`, not the cream the palette actually calls for.
  static Color onBand(Color fill) =>
      fill.computeLuminance() > 0.5 ? onBandInk : onBandCream;

  // ----------------------------------------------------------------- motifs
  /// [RAJ-PHASE3-1] Haldi (turmeric yellow) — the ornament accent. It already
  /// existed as `micIdleBg`, but that name means "the mic button is idle";
  /// the toran beads and rosette centre are not a mic, so they get the hue by
  /// its own name rather than borrowing an unrelated control token.
  static const haldi = Color(0xFFE9A227);

  /// [RAJ-INDIGO-1] Terracotta / lac — the mud-wall red-orange. Added so the
  /// Calls tab has a hue of its own: it used to be indigo `#2E4A8C`, which is
  /// now the HEADER BAND colour, so the chip would have disappeared into the
  /// strip behind it. Deliberately warmer and browner than `danger` `#D33A2C`
  /// (which stays reserved for destructive/missed states) — the two never
  /// appear on the same surface.
  static const terracotta = Color(0xFFC4562F);

  // -------------------------------------------------------------------- text
  static const textPrimary = Color(0xFF16110D);
  static const textSecondary = Color(0x9916110D); // ink 60%
  static const textTertiary = Color(0x7316110D); // ink 45%
  static const textFaint = Color(0x4D16110D); // ink 30%
  static const textOnInput = Color(0xFF16110D);
  static const placeholderOnWhite = Color(0x7316110D); // ink 45%

  // -------------------------------------------------------------------- tabs
  // [RAJ-INDIGO-1] All three chips sit ON the indigo header band, so all three
  // must be WARM and light-to-mid — a cool or dark chip vanishes into the
  // strip. Chats was turquoise (retired) and Calls was the very indigo the band
  // now uses. Marigold / rani / terracotta reads as a Rajasthani bandhani trio
  // and each one clears the band by a wide margin.
  static const tabChats = haldi;         // 0xFFE9A227 marigold — light, ink fg
  static const tabGroups = primaryBadge; // 0xFFC9316E rani — dark, cream fg
  /// ⚠️ NOT the colour of the Calls CHIP. `tabCalls` drifted into a
  /// general-purpose "indigo accent" with ~70 call sites well outside the tab
  /// strip (AvaVoice, AvaVision, GenUI, card manager, `kAvaVoicePurple`…), so
  /// retargeting it to terracotta would have silently repainted all of them.
  /// It stays indigo; the Calls chip reaches for [terracotta] directly.
  static const tabCalls = Color(0xFF2E4A8C);
  /// The Calls chip fill — see [terracotta] for why it left indigo.
  static const tabCallsChip = terracotta; // 0xFFC4562F lac — dark, cream fg
  /// [RAJ-INDIGO-1] Raised 0.22 → 0.34. 22% was tuned against the old LIGHT
  /// turquoise band, where a faint tint still read. Over the dark indigo band
  /// a 22% wash goes muddy and the unselected chips lose their identity, which
  /// is exactly the "elements blend into it" the owner flagged.
  static const double tabInactiveTintAlpha = 0.34;
  static const tabActiveLabel = Color(0xFFFBF3E2);

  /// Background fill for a colored tab pill given its accent + active state.
  /// Active = full accent; inactive = the accent at 22% over the header bar.
  static Color tabBg(Color accent, bool active) =>
      active ? accent : accent.withValues(alpha: tabInactiveTintAlpha);

  // ------------------------------------------------------------------- icons
  //
  // [UI-PALETTE-1 2026-08-05] COLLAPSED to one neutral + one accent.
  //
  // There used to be eight unrelated icon hues here — search-blue, bell-orange,
  // shield-green, phone-teal, video-purple, camera-pink, emoji-yellow,
  // mic-purple — each picked in isolation. On screen that reads as a toybox:
  // eight competing colours with no meaning attached to any of them, which was
  // one of the concrete findings in UI-AUDIT-2026-08-05.md. Colour should mean
  // something. Here it means exactly one thing: "this is the action".
  //
  // The eight names are KEPT AS ALIASES on purpose. They have ~100 call sites
  // across the app, and rewriting every one of them by hand — with no local
  // compiler to catch a typo — is a far bigger risk than pointing them at the
  // right value. Anything that was decorative becomes neutral; the two things
  // that genuinely are the primary action on their surface (search field
  // affordance, mic) keep the accent. New code should use `iconNeutral` /
  // `iconAccent` directly and NOT reach for the legacy names.
  static const iconNeutral = Color(0xFF16110D);
  /// The single accent — rani pink #C9316E. (The comment here used to say
  /// #E8833A, the pre-retheme orange; the value moved and the note didn't.)
  static const iconAccent = primaryBadge;

  // NOTE `iconSearch` is NEUTRAL, not accent, despite the name. It is reused as
  // the read/unheard tick colour in the AvaDialer inbox (inbox_list_screen /
  // inbox_thread_screen, where the comments still call it "blue"), so pointing
  // it at the accent turned those ticks pink on a pale card. Semantics beat the
  // token's name here.
  static const iconSearch = iconNeutral;
  static const iconBell = iconNeutral;
  static const iconShield = iconNeutral;
  static const iconPhone = iconNeutral;
  static const iconVideo = iconNeutral;
  static const iconCamera = iconNeutral;
  static const iconCameraOnWhite = iconNeutral;
  static const iconClipOnWhite = iconNeutral;
  static const iconEmoji = iconNeutral;
  static const iconMic = iconAccent;
  static const iconStar = iconNeutral;

  // ----------------------------------------------------------------- buttons
  static const primaryBadge = Color(0xFFC9316E);
  /// ⚠️ [RAJ-INDIGO-1] Was turquoise `#5CB8A6`; now marigold. This is the fill
  /// behind `AdButtonVariant.teal` (name kept — ~call sites, no local
  /// compiler), `ColorScheme.secondary`, and the `'coral'` personalisation
  /// accent. `AdButton._fg` already delegates to `AD.onBand`, so the
  /// foreground flipped from cream to ink on its own.
  static const newGroup = haldi;
  static const sendActiveBg = Color(0xFFC9316E);
  static const sendActiveInk = Color(0xFFFBF3E2);
  static const micIdleBg = Color(0xFFE9A227);
  static const micIdleInk = Color(0xFF16110D);
  static const destructiveBg = Color(0xFFD33A2C);
  static const destructiveBgHover = Color(0xFFD33A2C);
  static const destructiveInk = Color(0xFFFBF3E2);

  // ------------------------------------------------------------------ status
  static const online = Color(0xFF2E7D68);
  static const outgoingCall = Color(0xFF2E4A8C);
  /// [RAJ-INDIGO-1] Was turquoise `#5CB8A6`, which sat on the CREAM call-log
  /// card at only ~2.2:1. Now the deep sea-green already in the palette as
  /// `online` — the conventional "incoming" green, and legible on cream.
  static const incomingCall = online;
  static const missedCall = Color(0xFFD33A2C);
  static const danger = Color(0xFFD33A2C);
  static const unreadAccent = Color(0xFFC9316E);

  /// Money-in amounts. HANDOFF: `+` values need a green that stays legible on
  /// cream, and `online` is that green — kept as its own name because a wallet
  /// row is not a presence dot.
  static const moneyIn = online;

  /// Muted-thread bell-slash glyph. Deliberately a BRIGHT red — not the softer
  /// coral `danger` — so a muted thread is unmissable in the list
  /// (owner request 2026-07-14, [ISSUE-MUTE-ICON-RED-1]).
  static const iconMuted = Color(0xFFD33A2C);

  // ------------------------------------------------------------------ brand
  static const brandYoutube = Color(0xFFD33A2C);
  static const brandInstagram = Color(0xFFC9316E);
  static const brandFacebook = Color(0xFF2E4A8C);

  // ------------------------------------------------------------------ radii
  //
  // [UI-RADII-1 2026-08-05] SNAPPED ONTO THE 8 / 12 / 16 SCALE.
  //
  // These eleven values used to be eleven different numbers — 44, 22, 18, 16,
  // 14, 11, 11, 10, 10, 7, 9 — each eyeballed in isolation. Eleven corner radii
  // on one surface is not a scale, it is noise, and it is a large part of why
  // the product read as soft/toy in UI-AUDIT-2026-08-05.md.
  //
  // The names are KEPT (there are ~285 call sites and no local compiler to
  // catch a rename typo) and only the NUMBERS moved, so every existing
  // `AD.rListCard` etc. is snapped in one place with no call-site churn. They
  // now mirror `Msg.rSm` / `rMd` / `rLg` exactly — the literals are repeated
  // rather than imported because `messenger_theme.dart` imports THIS file, so
  // referencing `Msg` here would be a circular import.
  //
  // New code should prefer `Msg.rSm/rMd/rLg` directly.
  /// Device-frame mock only — not a UI surface, so it stays off the scale.
  static const double rPhone = 44;
  static const double rSheet = 16;      // was 22 — sheets are Msg.rLg
  static const double rMenu = 16;       // was 18 — menus are Msg.rLg
  static const double rDialog = 16;     // dialogs are Msg.rLg (unchanged)
  static const double rListCard = 12;   // was 14 — list rows are Msg.rMd
  static const double rStatCard = 12;   // was 11 — Msg.rMd
  static const double rInput = 12;      // was 11 — inputs are Msg.rMd
  static const double rIconButton = 8;  // was 10 — inline control, Msg.rSm
  static const double rTab = 8;         // was 10 — inline control, Msg.rSm
  static const double rChip = 8;        // was 7  — chips are Msg.rSm
  static const double rBadge = 8;       // was 9  — small badge, Msg.rSm

  // ---------------------------------------------------------------- spacing
  static const double screenPad = 20;
  static const double listGutter = 12;
  static const double rowGap = 6;
  static const EdgeInsets rowPadding =
      EdgeInsets.symmetric(horizontal: 12, vertical: 10);
  static const double bubbleGap = 10;
  static const double bubbleAvatarGap = 6;
  static const double footerHeight = 58;

  // --------------------------------------------------------------- elevation
  /// Soft phone-frame drop shadow.
  static const List<BoxShadow> phoneShadow = [
    BoxShadow(color: Color(0xB3000000), offset: Offset(0, 24), blurRadius: 60),
  ];
  // [RAJ-PHASE3-1] The three themed shadows below are HARD ink offsets, not
  // blurs (HANDOFF rule 4). `phoneShadow` above is deliberately left blurred —
  // it is the device bezel in the mock frame, not a themed UI surface.
  /// Bottom-sheet / overlay shadow.
  static const List<BoxShadow> overlayShadow = [
    BoxShadow(color: Color(0xFF16110D), offset: Offset(4, 5), blurRadius: 0),
  ];
  /// Dialog shadow.
  static const List<BoxShadow> dialogShadow = [
    BoxShadow(color: Color(0xFF16110D), offset: Offset(4, 5), blurRadius: 0),
  ];
  /// Toast / snackbar shadow.
  static const List<BoxShadow> toastShadow = [
    BoxShadow(color: Color(0xFF16110D), offset: Offset(3, 4), blurRadius: 0),
  ];

  /// [RAJ-INDIGO-1] Tab-chip lift — owner asked for "little shadow" under the
  /// tab buttons (pic 2 №2, pic 4). Hard ink offset, `blurRadius: 0`, per
  /// HANDOFF rule 4: nothing in this palette is allowed to blur. Smaller than
  /// [toastShadow] because a 36px chip carrying a 4px shadow reads as a card.
  static const List<BoxShadow> chipShadow = [
    BoxShadow(color: Color(0xFF16110D), offset: Offset(2, 3), blurRadius: 0),
  ];
  /// The pressed/unselected counterpart — the chip sits closer to the band.
  static const List<BoxShadow> chipShadowRest = [
    BoxShadow(color: Color(0xFF16110D), offset: Offset(1, 2), blurRadius: 0),
  ];

  // ---------------------------------------------------------- chat bubbles
  static const bubbleOutBg = Color(0xFF2E4A8C);
  static const bubbleOutInk = Color(0xFFFBF3E2);
  static const bubbleOutMeta = Color(0xFFFBF3E2);
  static const bubbleOutPlay = Color(0xFFE9A227);
  // [UI-RADII-1 2026-08-05] 14 → 12 (Msg.rMd) so these match the already-
  // migrated `bubble_theme.dart`, which draws the same shape with `Msg.rMd`
  // plus the 4px tail corner. The tail stays at 4 — that IS the tail.
  static const BorderRadius bubbleOutRadius = BorderRadius.only(
    topLeft: Radius.circular(12),
    topRight: Radius.circular(4),
    bottomLeft: Radius.circular(12),
    bottomRight: Radius.circular(12),
  );
  // [RAJ-PHASE2-1] The Ava lane needs a fill distinct from BOTH the outgoing
  // indigo and the incoming cream, so an Ava reply is never mistaken for
  // either party's message. Rani pink with cream type. Declared here rather
  // than as a new hex inside `bubble_theme.dart` — a second palette drifting
  // from this one is exactly how that file ended up still on WhatsApp greens.
  static const bubbleAvaBg = primaryBadge;
  static const bubbleAvaInk = bg;
  static const bubbleAvaMeta = bg;

  static const bubbleInBg = Color(0xFFFFFAF0);
  static const bubbleInInk = Color(0xFF16110D);
  static const bubbleInMeta = Color(0xFF5C5148);
  static const bubbleInPlay = Color(0xFFC9316E);
  static const BorderRadius bubbleInRadius = BorderRadius.only(
    topLeft: Radius.circular(4),
    topRight: Radius.circular(12),
    bottomLeft: Radius.circular(12),
    bottomRight: Radius.circular(12),
  );
  static const mediaPlaceholderBg = Color(0xFFF0E3CC);
  static const mediaPlaceholderLabel = Color(0xFF5C5148);
  /// [AVAGRP-CARDS-1] (owner decision 2026-07-17, pale-bubbles-on-white):
  /// checked, not replaced — these two were audited for use as a media
  /// LOADING-state fill (`ChatVideoCard`'s pre-thumbnail square) sitting
  /// INSIDE a pale bubble instead of directly on the old dark canvas. Ink-on-
  /// bg contrast is ~3.4:1 (icon/glyph-only content, not body text, so >=3:1
  /// is the relevant bar — WCAG large-text/graphical-object threshold) and
  /// the fill itself is neutral enough not to clash with any of the 12
  /// `kGroupSenderPalette` tints or `kBubbleMine`/`kBubbleTheirs`/`kBubbleAva`.
  /// No new token added.

  // ----------------------------------------------------------- avatar self
  static const selfAvatarBg = Color(0xFFC9316E);
  static const selfAvatarInk = Color(0xFFFBF3E2);

  // ---------------------------------------------------- avatar families ----
  /// Deterministic accent family for a seed (name/uid) — mirrors the mockup's
  /// 10-family rotation. Use [family] to fetch its colors.
  static const List<String> familyOrder = [
    'lilac', 'peach', 'mint', 'butter', 'rose',
    'sky', 'mustard', 'sage', 'aqua', 'terra',
  ];

  static AvatarFamily family(String seed) {
    final key = familyOrder[seed.hashCode.abs() % familyOrder.length];
    return _families[key]!;
  }

  static AvatarFamily familyByName(String name) =>
      _families[name] ?? _families['sky']!;

  // [RAJ-PHASE2-1] The ten families now draw from the six-colour palette only —
  // the pastel names (lilac/peach/butter…) are legacy KEYS, not descriptions of
  // the hue any more. Each family's `chipInk` follows `onBand()`: ink on the
  // light fills (turquoise, haldi), cream on the dark ones (indigo, rani, deep
  // green, red). Do not add a hue here that is not in the palette.
  static const Map<String, AvatarFamily> _families = {
    'lilac':   AvatarFamily(chipBg: Color(0xFF2E4A8C), chipInk: Color(0xFFFBF3E2), solid: Color(0xFF2E4A8C)),
    'peach':   AvatarFamily(chipBg: Color(0xFFC9316E), chipInk: Color(0xFFFBF3E2), solid: Color(0xFFC9316E)),
    // [RAJ-INDIGO-1] 'mint' and 'aqua' were the last two turquoise fills in the
    // app. Legacy KEYS, not hue descriptions — retargeted to terracotta and
    // deep green rather than renamed, because the key is derived from a seed
    // hash and renaming one reshuffles every existing user's avatar colour.
    'mint':    AvatarFamily(chipBg: Color(0xFFC4562F), chipInk: Color(0xFFFBF3E2), solid: Color(0xFFC4562F)),
    'butter':  AvatarFamily(chipBg: Color(0xFFE9A227), chipInk: Color(0xFF16110D), solid: Color(0xFFE9A227)),
    'rose':    AvatarFamily(chipBg: Color(0xFFC9316E), chipInk: Color(0xFFFBF3E2), solid: Color(0xFFC9316E)),
    'sky':     AvatarFamily(chipBg: Color(0xFF2E4A8C), chipInk: Color(0xFFFBF3E2), solid: Color(0xFF2E4A8C)),
    'mustard': AvatarFamily(chipBg: Color(0xFFE9A227), chipInk: Color(0xFF16110D), solid: Color(0xFFE9A227)),
    'sage':    AvatarFamily(chipBg: Color(0xFF2E7D68), chipInk: Color(0xFFFBF3E2), solid: Color(0xFF2E7D68)),
    'aqua':    AvatarFamily(chipBg: Color(0xFF2E7D68), chipInk: Color(0xFFFBF3E2), solid: Color(0xFF2E7D68)),
    'terra':   AvatarFamily(chipBg: Color(0xFFD33A2C), chipInk: Color(0xFFFBF3E2), solid: Color(0xFFD33A2C)),
  };
}

/// One avatar accent family: a palette fill plus the foreground ink that is
/// readable on it (per `AD.onBand`), and the saturated `solid` variant for
/// filled avatar circles.
class AvatarFamily {
  final Color chipBg;
  final Color chipInk;
  final Color solid;
  const AvatarFamily({required this.chipBg, required this.chipInk, required this.solid});
}

/// Native-platform type scale.
///
/// [UI-WHATSAPP-STABLE-1] The UI deliberately leaves [TextStyle.fontFamily]
/// unset so Flutter selects the system face (Roboto on Android, SF on Apple
/// platforms). This keeps dense chat text familiar and stable instead of using
/// a display face for every control.
///
/// ⚠️ [RAJ-PHASE5-RISK] HANDOFF Phase 5 proposes bundling a display family
/// (Archivo Black headings, Archivo w800 row titles, Space Mono meta). Three
/// things have to be decided BEFORE that branch exists, because they conflict
/// with what is written here:
///   1. This scale tops out at w700 and `Msg`'s contract says "never 800/900".
///      Phase 5 wants w800 row titles. Raise the ceiling deliberately or hold
///      it — do not let a font swap decide it silently.
///   2. `pubspec.yaml` already bundles Nunito at SIX weights (400–900) which
///      nothing but `AvaTheme.wordmark` uses. Two more families is five type
///      systems in one app and a real APK-size conversation.
///   3. The overflow risk is the fixed pixel boxes in `Msg` (rowHeight 72,
///      rowLeading 57, rowTrailing 64, composerMinHeight 44) plus AD's
///      footerHeight 58, multiplied by a user-controlled FontScale — not the
///      font file. Test those at max FontScale on a device, on auth,
///      onboarding and every app bar, per HANDOFF.
///
/// Hierarchy comes from contrast and a small Regular/Medium weight step, not
/// from bold text throughout the conversation:
///   body          → 400
///   secondary     → 400/500, muted colour
///   contact names → 500
///   screen titles → 700
///   timestamps    → 400, small and muted
///
/// Sizes are whole numbers only — the old half-pixel values were eyeball-
/// tuning, not a stable scale.
class ADText {
  ADText._();
  /// Null intentionally inherits Flutter's platform-native default font.
  static const String? family = null;

  static TextStyle _s(double size, FontWeight w, Color c,
          {double? spacing, double height = 1.2}) =>
      TextStyle(fontFamily: family, fontSize: size, fontWeight: w,
          color: c, letterSpacing: spacing, height: height);

  /// App wordmark / screen title — 22 / 700. The heaviest weight in the app.
  static TextStyle appTitle({Color c = AD.textPrimary}) =>
      _s(22, FontWeight.w700, c, spacing: -0.01 * 22, height: 1.05);
  /// Thread name in header — 16 / 500.
  static TextStyle threadName({Color c = AD.textPrimary}) =>
      _s(16, FontWeight.w500, c);
  /// Chat-row contact name — 15 / 500.
  static TextStyle rowName({Color c = AD.textPrimary}) =>
      _s(15, FontWeight.w500, c);
  /// Chat bubble body — 16 / 400. Slightly larger than the original stable-UI
  /// pass for comfortable reading without restoring global scale inflation.
  static TextStyle bubbleBody({Color c = AD.textPrimary}) =>
      _s(16, FontWeight.w400, c, height: 1.35);
  /// Message preview line — 14 / 400, muted. Sits UNDER rowName in weight,
  /// size and colour, which is what makes the name read as the heading.
  static TextStyle preview({Color c = AD.textSecondary}) =>
      _s(14, FontWeight.w400, c);
  /// Colored tab label — 13 / 500.
  static TextStyle tabLabel({Color c = AD.textPrimary}) =>
      _s(13, FontWeight.w500, c);
  /// Bottom-nav label (active) — 11 / 500.
  static TextStyle navLabelPrimary({Color c = AD.textPrimary}) =>
      _s(11, FontWeight.w500, c);
  /// Bottom-nav label (inactive) — 11 / 500.
  static TextStyle navLabel({Color c = AD.textTertiary}) =>
      _s(11, FontWeight.w500, c);
  /// Section header (Pinned / Messages) — 11 / 500, lightly tracked.
  /// Sentence case at the call site; the caps were part of the shouting.
  static TextStyle sectionLabel({Color c = AD.textTertiary}) =>
      _s(11, FontWeight.w500, c, spacing: 0.06 * 11);
  /// Timestamp — 12 / 400, muted.
  static TextStyle timestamp({Color c = AD.textTertiary}) =>
      _s(12, FontWeight.w400, c);
  /// Bubble meta (time/ticks) — 11 / 400.
  static TextStyle bubbleMeta({Color c = AD.bubbleOutMeta}) =>
      _s(11, FontWeight.w400, c);
  /// Stat caption — 11 / 400.
  static TextStyle statCaption({Color c = AD.textTertiary}) =>
      _s(11, FontWeight.w400, c);
}

// =============================================================================
// Component recipes — the shared Ad* widgets used across AvaTOK screens.
//
// [RAJ-PHASE1-2] This banner used to say "the dark counterparts of the shared
// Zine* widgets … soft/flat elevation and hairline borders". Both halves are
// obsolete: `Zine` is deleted, and these widgets draw 2px ink outlines with
// hard offset shadows. Foregrounds route through `AD.onBand(fill)` rather than
// hardcoding white — see the note on that method.
// =============================================================================

enum AdButtonVariant { primary, teal, danger, ghost }

/// Pill button. primary = rani pink, teal = group actions, danger = red,
/// ghost = outlined paper.
class AdButton extends StatelessWidget {
  final String label;
  final VoidCallback? onPressed;
  final AdButtonVariant variant;
  final IconData? icon;
  final bool trailingIcon;
  final bool loading;
  final bool fullWidth;
  final double fontSize;
  const AdButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.variant = AdButtonVariant.primary,
    this.icon,
    this.trailingIcon = true,
    this.loading = false,
    this.fullWidth = false,
    this.fontSize = 15,
  });

  Color get _fill => switch (variant) {
        AdButtonVariant.primary => AD.primaryBadge,
        AdButtonVariant.teal => AD.newGroup,
        AdButtonVariant.danger => AD.destructiveBg,
        AdButtonVariant.ghost => AD.card,
      };

  /// [UI-CONTRAST-1 2026-08-05, corrected RAJ-PHASE1-2] Foreground ink, chosen
  /// PER FILL rather than "white unless ghost".
  ///
  /// The original note here reasoned about the PRE-RETHEME fills — orange
  /// #E8833A, teal #2FA98C, coral #C0533F — and concluded dark ink was right for
  /// primary and teal. The fills changed under it and the conclusion inverted
  /// for primary:
  ///   rani pink #C9316E + ink  ≈ 3.5:1  ✗   + cream ≈ 4.7:1  ✓
  ///   marigold  #E9A227 + ink  ≈ 8.9:1  ✓   (was turquoise #5CB8A6, retired
  ///                                          in [RAJ-INDIGO-1])
  ///   red       #D33A2C + cream ≈ 4.4:1  ✓   (large/emphasis text only)
  ///
  /// So it is no longer written out per variant at all — it delegates to
  /// `AD.onBand(_fill)`, which is the palette's one documented rule for "what
  /// colour goes on this fill". Change a fill and the foreground follows.
  /// Do NOT "simplify" this back to a single white.
  Color get _fg => switch (variant) {
        AdButtonVariant.ghost => AD.textPrimary,
        _ => AD.onBand(_fill),
      };

  @override
  Widget build(BuildContext context) {
    final disabled = onPressed == null || loading;
    final fg = disabled ? AD.textTertiary : _fg;
    final bg = disabled ? AD.card : _fill;
    final content = Row(
      mainAxisSize: fullWidth ? MainAxisSize.max : MainAxisSize.min,
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        if (loading)
          SizedBox(
            width: fontSize + 2, height: fontSize + 2,
            child: CircularProgressIndicator(strokeWidth: 2.4, color: fg),
          )
        else ...[
          if (icon != null && !trailingIcon) ...[
            Icon(icon, size: fontSize + 2, color: fg),
            const SizedBox(width: 8),
          ],
          Flexible(
            child: Text(label,
                maxLines: 1, overflow: TextOverflow.ellipsis,
                style: TextStyle(fontFamily: ADText.family, fontWeight: FontWeight.w600,
                    fontSize: fontSize, color: fg)),
          ),
          if (icon != null && trailingIcon) ...[
            const SizedBox(width: 8),
            Icon(icon, size: fontSize + 2, color: fg),
          ],
        ],
      ],
    );
    return GestureDetector(
      onTap: disabled ? null : onPressed,
      child: Container(
        width: fullWidth ? double.infinity : null,
        // 4px grid (Msg.s1..s6): was 22 / 15|12.
        padding: EdgeInsets.symmetric(horizontal: 24, vertical: fontSize >= 17 ? 16 : 12),
        decoration: BoxDecoration(
          color: bg,
          borderRadius: BorderRadius.circular(100),
          border: variant == AdButtonVariant.ghost || disabled
              ? Border.all(color: AD.borderControl, width: AD.wBorder)
              : null,
        ),
        child: content,
      ),
    );
  }
}

/// Paper card surface — 2px ink outline, optional tap and hard offset shadow.
class AdCard extends StatelessWidget {
  final Widget child;
  final Color color;
  final EdgeInsetsGeometry padding;
  final double radius;
  final List<BoxShadow> boxShadow;
  final VoidCallback? onTap;
  const AdCard({
    super.key,
    required this.child,
    this.color = AD.card,
    this.padding = const EdgeInsets.all(16),
    this.radius = AD.rListCard,
    this.boxShadow = const [],
    this.onTap,
  });
  @override
  Widget build(BuildContext context) {
    final box = Container(
      padding: padding,
      decoration: BoxDecoration(
        color: color,
        borderRadius: BorderRadius.circular(radius),
        border: Border.all(color: AD.borderControl, width: AD.wBorder),
        boxShadow: boxShadow,
      ),
      child: child,
    );
    if (onTap == null) return box;
    return GestureDetector(onTap: onTap, behavior: HitTestBehavior.opaque, child: box);
  }
}

/// Filter / action chip. Active = accent fill + check.
class AdChip extends StatelessWidget {
  final String label;
  final bool active;
  final VoidCallback? onTap;
  final IconData? icon;
  const AdChip({super.key, required this.label, this.active = false, this.onTap, this.icon});
  @override
  Widget build(BuildContext context) {
    // [RAJ-PHASE1-2] Was `Colors.white` for both the check glyph and the active
    // label. White is not in this palette — the cream from `AD.onBand()` is, and
    // it is the value every other foreground-on-fill decision uses.
    final fill = active ? AD.primaryBadge : AD.card;
    final fg = active ? AD.onBand(fill) : AD.textSecondary;
    return GestureDetector(
      onTap: onTap,
      behavior: HitTestBehavior.opaque,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(
          color: fill,
          borderRadius: BorderRadius.circular(100),
          border: Border.all(
              color: active ? AD.primaryBadge : AD.borderControl,
              width: AD.wBorder),
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          if (active) ...[
            PhosphorIcon(PhosphorIcons.check(PhosphorIconsStyle.bold), size: 13, color: fg),
            const SizedBox(width: 8),
          ] else if (icon != null) ...[
            Icon(icon, size: 14, color: AD.textSecondary),
            const SizedBox(width: 8),
          ],
          Text(label, style: TextStyle(fontFamily: ADText.family, fontWeight: FontWeight.w600,
              fontSize: 13, color: fg)),
        ]),
      ),
    );
  }
}

enum AdStickerKind { ok, no, hint, plain }

/// Tag / status pill.
class AdSticker extends StatelessWidget {
  final String text;
  final AdStickerKind kind;
  final IconData? icon;
  final VoidCallback? onTap;
  const AdSticker(this.text, {super.key, this.kind = AdStickerKind.plain, this.icon, this.onTap});
  @override
  Widget build(BuildContext context) {
    // [RAJ-PHASE1-2] `ok` and `no` were `Colors.white`. Routed through
    // `AD.onBand()` so they use the palette's cream and stay correct if either
    // fill is ever retuned.
    final fill = switch (kind) {
      AdStickerKind.ok => AD.online,
      AdStickerKind.no => AD.destructiveBg,
      AdStickerKind.hint => AD.card,
      AdStickerKind.plain => AD.card,
    };
    final fg = switch (kind) {
      AdStickerKind.ok || AdStickerKind.no => AD.onBand(fill),
      AdStickerKind.hint => AD.textSecondary,
      AdStickerKind.plain => AD.textPrimary,
    };
    final core = Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      decoration: BoxDecoration(
        color: fill,
        borderRadius: BorderRadius.circular(100),
        border: Border.all(color: AD.borderControl, width: AD.wBorder),
      ),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        if (icon != null) ...[
          Icon(icon, size: 14, color: fg),
          const SizedBox(width: 8),
        ],
        Flexible(
          child: Text(text,
              maxLines: 1, overflow: TextOverflow.ellipsis,
              style: TextStyle(fontFamily: ADText.family, fontWeight: FontWeight.w600,
                  fontSize: 11, letterSpacing: 0.2, color: fg)),
        ),
      ]),
    );
    if (onTap == null) return core;
    return GestureDetector(onTap: onTap, child: core);
  }
}

/// Circular back / icon button — transparent on the header band.
class AdBackButton extends StatelessWidget {
  final VoidCallback? onTap;
  final IconData? icon;
  /// [RAJ-SEAMS-1] Foreground colour, for headers on a DARK band.
  ///
  /// Defaults to ink, which is right on turquoise and haldi and was the only
  /// case that existed while every header in the app was turquoise. Screens
  /// whose band moved to indigo or rani pink MUST pass `AD.onBand(band)` — an
  /// ink arrow on indigo is very nearly invisible. Optional and defaulted on
  /// purpose: this widget has call sites on many screens outside the retheme.
  final Color? color;
  const AdBackButton({super.key, this.onTap, this.icon, this.color});
  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap ?? () => Navigator.of(context).maybePop(),
      behavior: HitTestBehavior.opaque,
      child: SizedBox(
        width: 40, height: 40,
        child: Center(
          child: PhosphorIcon(
            icon ?? PhosphorIcons.arrowLeft(PhosphorIconsStyle.bold),
            size: 20, color: color ?? AD.textPrimary,
          ),
        ),
      ),
    );
  }
}

/// Error line under a field.
class AdErrorMsg extends StatelessWidget {
  final String text;
  const AdErrorMsg(this.text, {super.key});
  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Row(children: [
        PhosphorIcon(PhosphorIcons.warning(PhosphorIconsStyle.bold), size: 15, color: AD.danger),
        const SizedBox(width: 8),
        // [UI-MSG-TYPE-1] w700 is for titles; an inline error line is emphasis,
        // not a heading — w600 at 12px.
        Expanded(child: Text(text, style: TextStyle(fontFamily: ADText.family,
            fontWeight: FontWeight.w600, fontSize: 12, color: AD.danger))),
      ]),
    );
  }
}

/// Paper text field (ink on raised cream), with optional lead/trailing cells.
class AdField extends StatefulWidget {
  final TextEditingController? controller;
  final String? label;
  final IconData? labelIcon;
  final String? hint;
  final String? leadText;
  final IconData? leadIcon;
  final Widget? trailing;
  final bool obscureText;
  final bool error;
  final TextInputType? keyboardType;
  final ValueChanged<String>? onChanged;
  final ValueChanged<String>? onSubmitted;
  final bool autofocus;
  final int? maxLength;
  final int? maxLines;
  final int? minLines;
  final TextCapitalization textCapitalization;
  final bool autocorrect;
  final bool enabled;
  final bool readOnly;
  final List<TextInputFormatter>? inputFormatters;
  const AdField({
    super.key,
    this.controller,
    this.label,
    this.labelIcon,
    this.hint,
    this.leadText,
    this.leadIcon,
    this.trailing,
    this.obscureText = false,
    this.error = false,
    this.keyboardType,
    this.onChanged,
    this.onSubmitted,
    this.autofocus = false,
    this.maxLength,
    this.maxLines = 1,
    this.minLines,
    this.textCapitalization = TextCapitalization.none,
    this.autocorrect = false,
    this.enabled = true,
    this.readOnly = false,
    this.inputFormatters,
  });
  @override
  State<AdField> createState() => _AdFieldState();
}

class _AdFieldState extends State<AdField> {
  @override
  Widget build(BuildContext context) {
    final hasLead = widget.leadText != null || widget.leadIcon != null;
    final multiline = widget.maxLines == null || (widget.maxLines ?? 1) > 1;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      if (widget.label != null) ...[
        Row(children: [
          if (widget.labelIcon != null) ...[
            Icon(widget.labelIcon, size: 14, color: AD.textSecondary),
            const SizedBox(width: 8),
          ],
          Flexible(
            // [UI-CASE-1 2026-08-05] The forced `.toUpperCase()` is gone —
            // shouted field labels were part of the "amateur UI" finding.
            // Callers pass sentence case and it renders as written.
            child: Text(widget.label!,
                style: ADText.sectionLabel(c: AD.textSecondary), overflow: TextOverflow.ellipsis),
          ),
        ]),
        const SizedBox(height: 8),
      ],
      Container(
        decoration: BoxDecoration(
          color: widget.enabled ? AD.inputField : AD.card,
          borderRadius: BorderRadius.circular(AD.rInput),
          border: Border.all(
              color: widget.error ? AD.danger : AD.borderControl,
              width: AD.wBorder),
        ),
        clipBehavior: Clip.antiAlias,
        child: Row(
          crossAxisAlignment: multiline ? CrossAxisAlignment.start : CrossAxisAlignment.center,
          children: [
            if (hasLead)
              Container(
                width: 46,
                constraints: const BoxConstraints(minHeight: 50),
                alignment: Alignment.center,
                // [RAJ-PHASE1-2] Was a raw `Color(0x22000000)` — pure black at
                // 13%, the last stray hex in this widget. `borderDivider` is the
                // palette's warm ink at 14% and is the correct token for a rule
                // INSIDE a bordered container.
                decoration: const BoxDecoration(
                  border: Border(right: BorderSide(color: AD.borderDivider, width: 1)),
                ),
                child: widget.leadText != null
                    ? Text(widget.leadText!, style: TextStyle(fontFamily: ADText.family,
                        fontWeight: FontWeight.w600, fontSize: 20, color: AD.textOnInput))
                    : Icon(widget.leadIcon, size: 20, color: AD.textOnInput),
              ),
            Expanded(
              child: TextField(
                controller: widget.controller,
                enabled: widget.enabled,
                readOnly: widget.readOnly,
                obscureText: widget.obscureText,
                keyboardType: widget.keyboardType,
                onChanged: widget.onChanged,
                onSubmitted: widget.onSubmitted,
                autofocus: widget.autofocus,
                maxLength: widget.maxLength,
                maxLines: widget.maxLines,
                minLines: widget.minLines,
                textCapitalization: widget.textCapitalization,
                autocorrect: widget.autocorrect,
                inputFormatters: widget.inputFormatters,
                cursorColor: AD.textPrimary,
                // Locked identity fields must remain legible. Flutter applies
                // the disabled theme color when enabled=false. Use readOnly for
                // fields that are known but immutable so the normal ink style
                // remains.
                // [UI-MSG-TYPE-1] What the user types is BODY copy → w400.
                // It was w700, which made every input read like a headline.
                style: TextStyle(fontFamily: ADText.family, fontWeight: FontWeight.w400,
                    fontSize: 15, color: AD.textOnInput),
                decoration: InputDecoration(
                  isDense: true,
                  counterText: '',
                  hintText: widget.hint,
                  hintStyle: TextStyle(fontFamily: ADText.family, fontWeight: FontWeight.w400,
                      fontSize: 15, color: AD.placeholderOnWhite),
                  border: InputBorder.none,
                  enabledBorder: InputBorder.none,
                  focusedBorder: InputBorder.none,
                  disabledBorder: InputBorder.none,
                  filled: false,
                  contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 15),
                ),
              ),
            ),
            if (widget.trailing != null)
              Container(
                width: 50,
                constraints: const BoxConstraints(minHeight: 50),
                alignment: Alignment.center,
                child: widget.trailing,
              ),
          ],
        ),
      ),
    ]);
  }
}

/// Search dock — ink on raised paper, the app's one search idiom.
///
/// Modelled on `search_screen.dart`'s private `_searchDock`, so the inline
/// search bars on Chats / Groups / Calls all share ONE implementation
/// ([ISSUE-INLINE-SEARCH-1], owner request 2026-07-14). Use this rather than
/// hand-rolling another dock.
///
/// [RAJ-PHASE1-2] ⚠️ JUDGEMENT CALL — flag if you disagree. This was the one
/// input in the app with NO border at all, which was correct when it sat on a
/// near-black header and the fill alone separated it. On cream it is
/// paper-on-paper and has no edge, so it now takes the same 2px ink outline as
/// `AdField` per HANDOFF rule 1. This does NOT contradict the AvaDial note in
/// HANDOFF Phase 2 ("the search field becomes the one plain, ornament-free
/// element on the screen") — ornament-free means no toran, no beads, no
/// rosette; it still needs an edge. Set [outlined] false to opt out.
///
/// Filtering is expected to be INSTANT — wire [onChanged] straight to a
/// `setState` filter, no debounce. (Debounce belongs only on the full
/// `SearchScreen`, which hits the network.)
class AdSearchDock extends StatefulWidget {
  final TextEditingController controller;
  final String hint;
  final ValueChanged<String> onChanged;
  final bool autofocus;

  /// Extra trailing widget, shown left of the built-in clear button.
  final Widget? trailing;

  /// Show the built-in "x" clear button once there is text.
  final bool showClear;

  /// Draw the 2px ink outline. See the class note.
  final bool outlined;

  const AdSearchDock({
    super.key,
    required this.controller,
    required this.hint,
    required this.onChanged,
    this.autofocus = false,
    this.trailing,
    this.showClear = true,
    this.outlined = true,
  });

  @override
  State<AdSearchDock> createState() => _AdSearchDockState();
}

class _AdSearchDockState extends State<AdSearchDock> {
  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_onText);
  }

  @override
  void didUpdateWidget(covariant AdSearchDock old) {
    super.didUpdateWidget(old);
    if (old.controller != widget.controller) {
      old.controller.removeListener(_onText);
      widget.controller.addListener(_onText);
    }
  }

  @override
  void dispose() {
    widget.controller.removeListener(_onText);
    super.dispose();
  }

  // Rebuilds only this dock so the clear button appears/disappears; the host
  // screen's own filtering is driven by widget.onChanged, not by this.
  void _onText() {
    if (mounted) setState(() {});
  }

  void _clear() {
    widget.controller.clear();
    widget.onChanged('');
    FocusScope.of(context).unfocus();
  }

  @override
  Widget build(BuildContext context) {
    final hasText = widget.controller.text.isNotEmpty;
    return Container(
      // Search docks sit below the shared golden wave tip. This margin is
      // intentionally part of the shared component so chat, groups, calls,
      // and the AvaDial inbox cannot drift into the header seam independently.
      margin: const EdgeInsets.only(top: 12),
      decoration: BoxDecoration(
        color: AD.inputField,
        borderRadius: BorderRadius.circular(AD.rInput),
        border: widget.outlined
            ? Border.all(color: AD.borderControl, width: AD.wBorder)
            : null,
      ),
      padding: const EdgeInsets.symmetric(horizontal: 12),
      child: Row(children: [
        PhosphorIcon(PhosphorIcons.magnifyingGlass(PhosphorIconsStyle.bold),
            size: 18, color: AD.iconSearch),
        const SizedBox(width: 8),
        Expanded(
          child: TextField(
            controller: widget.controller,
            autofocus: widget.autofocus,
            onChanged: widget.onChanged,
            textInputAction: TextInputAction.search,
            cursorColor: AD.textPrimary,
            style: ADText.rowName(c: AD.textOnInput),
            decoration: InputDecoration(
              isDense: true,
              border: InputBorder.none,
              contentPadding: const EdgeInsets.symmetric(vertical: 13),
              hintText: widget.hint,
              hintStyle: ADText.preview(c: AD.placeholderOnWhite),
            ),
          ),
        ),
        if (widget.trailing != null) ...[
          const SizedBox(width: 8),
          widget.trailing!,
        ],
        if (widget.showClear && hasText) ...[
          const SizedBox(width: 8),
          InkWell(
            onTap: _clear,
            borderRadius: BorderRadius.circular(AD.rIconButton),
            child: Padding(
              padding: const EdgeInsets.all(3),
              child: PhosphorIcon(PhosphorIcons.x(PhosphorIconsStyle.bold),
                  size: 16, color: AD.placeholderOnWhite),
            ),
          ),
        ],
      ]),
    );
  }
}
