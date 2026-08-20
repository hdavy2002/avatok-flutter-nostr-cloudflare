import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'ui/avatok_dark.dart';
import 'ui/messenger_theme.dart';

// [UI-ZINE-KILL-1 2026-08-05] The old light design system (`Zine`) is GONE.
//
// This file used to `import 'ui/zine.dart'` and re-export `Zine` + `ZineText`,
// which silently put that palette in scope for anything importing theme.dart.
// All ~1,600 call sites are migrated to AD / ADText / Msg; both the import and
// the export are gone and the file is deleted. `AvaColors` went with it.
//
// `ZineWidthClass` / `ZineBreakpoints` were NOT part of the palette — they are
// pure layout utilities and live in `core/ui/breakpoints.dart`.
//
// [RAJ-PHASE4-1] ⚠️ READ THIS BEFORE CHANGING BRIGHTNESS OR SURFACE COLOURS.
//
// The retheme made the app LIGHT (cream paper, ink outlines). The guard that
// used to live here said "DO NOT RE-ADD a light palette" — that guard is
// obsolete and has been REPLACED, not deleted, because the failure it was
// protecting against is real and still possible:
//
//   The original bug was a cream *flash* on cold start, caused by the global
//   ThemeData being light while every screen painted itself near-black. The
//   mismatch was the bug — not the lightness.
//
// The rule now is the mirror image: THE GLOBAL THEME AND THE SCREENS MUST
// AGREE, and both are cream. So:
//   * `brightness` MUST stay `Brightness.light` and the scheme MUST stay
//     `ColorScheme.light`. It was `Brightness.dark` + `ColorScheme.dark` filled
//     with cream values after the recolour — see the note on [light] below for
//     what that actually broke.
//   * The native launch/splash background MUST be `AvaTheme.bootColor`
//     (#FBF3E2). Any other value reintroduces a flash, this time dark-on-cream.
//     Android: `android/app/src/main/res/values/styles.xml` windowBackground +
//     the launch drawable. iOS: LaunchScreen background.

/// A quiet Android route transition: a short fade without scale or overshoot.
///
/// The interval completes the visual phase in roughly 180ms of Material's
/// standard route timeline, while retaining the platform's normal back stack.
class _StableFadePageTransition extends PageTransitionsBuilder {
  const _StableFadePageTransition();

  @override
  Widget buildTransitions<T>(
    PageRoute<T>? route,
    BuildContext? context,
    Animation<double> animation,
    Animation<double> secondaryAnimation,
    Widget child,
  ) => FadeTransition(
        opacity: CurvedAnimation(
          parent: animation,
          curve: const Interval(0, 0.6, curve: Curves.easeOutCubic),
          reverseCurve: const Interval(0.4, 1, curve: Curves.easeInCubic),
        ),
        child: child,
      );
}

class AvaTheme {
  /// [RAJ-PHASE4-1] The cream the app boots on. Mirror this into the native
  /// launch screens (see the file header) or cold start flashes.
  static const Color bootColor = AD.bg;

  /// The app's ONLY theme. Still named `light` because `MaterialApp(theme:)`
  /// takes the light slot and ~every reference says `AvaTheme.light`; renaming
  /// it buys nothing and touches every call site. Now the name is also
  /// accurate.
  ///
  /// [RAJ-PHASE4-1] WHY THE BRIGHTNESS CHANGE MATTERS. After the recolour this
  /// declared `brightness: Brightness.dark` + `ColorScheme.dark(...)` while
  /// every value in it was cream. Flutter derives a large amount from
  /// brightness that nothing here sets explicitly — text-selection handles and
  /// the caret, splash/highlight ripples, the scrollbar thumb, `disabledColor`,
  /// `unselectedWidgetColor`, `hintColor`, the iOS keyboard appearance, and the
  /// defaults for every widget NOT themed below (Radio, Checkbox, Slider, the
  /// date/time pickers, DropdownMenu, ExpansionTile, Tooltip, MaterialBanner).
  /// All of those were drawing dark-mode defaults onto cream: invisible
  /// selection handles, invisible ripples, an invisible scroll thumb, a black
  /// tooltip, a dark keyboard under a cream composer. None of it is visible in
  /// a screenshot of a themed screen — it only shows on a device, on the
  /// surfaces nobody re-skinned by hand.
  ///
  /// The widgets that used to be left to Material's defaults are now themed
  /// explicitly below, so a future brightness edit can't silently take them
  /// with it.
  static ThemeData get light {
    final base = ThemeData(
      useMaterial3: true,
      brightness: Brightness.light,
      colorScheme: const ColorScheme.light(
        primary: AD.primaryBadge,
        // [RAJ-PHASE4-1] CREAM, not ink. This was `AD.textOnInput` (ink
        // #16110D) on rani pink #C9316E — about 3.5:1, under the 4.5:1 body
        // minimum, on every FilledButton in the app. It also contradicted the
        // app's own rule: `AD.onBand()` classifies rani as a DARK band and
        // returns cream (~4.7:1). The old comment here reasoned about
        // white-on-#E8833A, the pre-retheme orange, where ink genuinely was
        // the right answer. The rule was fine; the fill changed under it.
        onPrimary: AD.onBandCream,
        secondary: AD.newGroup,
        // Turquoise is a LIGHT band — ink, per AD.onBand().
        onSecondary: AD.onBandInk,
        tertiary: AD.haldi,
        onTertiary: AD.onBandInk,
        error: AD.danger,
        // Red #D33A2C is a dark fill and takes cream, not ink.
        onError: AD.onBandCream,
        surface: AD.card,
        onSurface: AD.textPrimary,
        surfaceContainerHighest: AD.cardHover,
        onSurfaceVariant: AD.textSecondary,
        outline: AD.borderControl,
        outlineVariant: AD.borderDivider,
        inverseSurface: AD.textPrimary,
        onInverseSurface: AD.bg,
        scrim: AD.scrim,
        shadow: AD.textPrimary,
      ),
      scaffoldBackgroundColor: AD.bg,
      canvasColor: AD.bg,
      // Leave the family unset so Flutter uses the platform's native UI face:
      // Roboto on Android, SF on Apple platforms. See ADText — a bundled
      // display family is Phase 5 and is NOT decided here.
      //
      // Android uses a brief, non-scaling fade; iOS/macOS retain Cupertino so
      // the interactive edge-swipe back still works.
      pageTransitionsTheme: const PageTransitionsTheme(builders: {
        TargetPlatform.android: _StableFadePageTransition(),
        TargetPlatform.iOS: CupertinoPageTransitionsBuilder(),
        TargetPlatform.macOS: CupertinoPageTransitionsBuilder(),
      }),
      // [RAJ-PHASE4-1] The iOS keyboard and the Cupertino widgets read their
      // own brightness. Left implicit they followed the (wrong) dark
      // ThemeData.brightness and came up dark against the cream composer.
      cupertinoOverrideTheme: const NoDefaultCupertinoThemeData(
        brightness: Brightness.light,
      ),
    );

    final textTheme = base.textTheme
        .apply(
          bodyColor: AD.textPrimary,
          displayColor: AD.textPrimary,
        )
        .copyWith(
          displayLarge: ADText.appTitle().copyWith(fontSize: 34),
          displayMedium: ADText.appTitle().copyWith(fontSize: 28),
          headlineMedium: ADText.appTitle().copyWith(fontSize: 22),
          headlineSmall: ADText.appTitle(),
          titleLarge: ADText.threadName().copyWith(fontSize: 18),
          titleMedium: ADText.rowName(),
          bodyLarge: ADText.bubbleBody().copyWith(fontSize: 16),
          bodyMedium: ADText.bubbleBody(),
          labelLarge: ADText.rowName().copyWith(fontSize: 15),
          labelSmall: ADText.sectionLabel(),
        );

    return base.copyWith(
      textTheme: textTheme,

      // [RAJ-PHASE4-1] These six used to be inherited from
      // `brightness: Brightness.dark` and were all wrong on cream. Set
      // explicitly so they survive any future brightness edit.
      dividerColor: AD.borderDivider,
      hintColor: AD.textTertiary,
      disabledColor: AD.textFaint,
      unselectedWidgetColor: AD.textSecondary,
      splashColor: AD.splashInk,
      highlightColor: AD.highlightInk,
      hoverColor: AD.highlightInk,
      focusColor: AD.highlightInk,

      // [RAJ-PHASE4-1] Selection handles and the caret are drawn from
      // brightness when this is unset — light-on-light, i.e. invisible, and
      // the most-reported "I can't tell what I selected" class of bug.
      textSelectionTheme: TextSelectionThemeData(
        cursorColor: AD.textPrimary,
        selectionColor: AD.primaryBadge.withValues(alpha: 0.24),
        selectionHandleColor: AD.primaryBadge,
      ),

      // [RAJ-PHASE4-1] The thumb defaulted to a pale dark-mode grey on cream.
      scrollbarTheme: ScrollbarThemeData(
        thumbColor: WidgetStatePropertyAll(AD.textPrimary.withValues(alpha: 0.28)),
        radius: const Radius.circular(Msg.rSm),
        thickness: const WidgetStatePropertyAll(4),
      ),

      // [RAJ-SEAMS-1] Default app bar: cream paper with the FAINT rule, not a
      // full-ink 1px line. The retheme assigns a band hue per area — use
      // `AvaTheme.bandAppBar(...)` on those screens rather than recolouring
      // this. A screen that reaches neither is plain cream, which is a correct
      // fallback rather than a half-themed one.
      appBarTheme: AppBarTheme(
        backgroundColor: AD.bg,
        foregroundColor: AD.textPrimary,
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: false,
        titleTextStyle: ADText.appTitle(),
        iconTheme: const IconThemeData(color: AD.iconNeutral),
        actionsIconTheme: const IconThemeData(color: AD.iconNeutral),
        systemOverlayStyle: _overlayFor(AD.bg),
        shape: const Border(
            bottom: BorderSide(color: AD.borderDivider, width: 1)),
      ),

      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: AD.primaryBadge,
          // Cream on rani pink ≈ 4.7:1. See the ColorScheme note above — ink
          // on this fill is ~3.5:1 and fails.
          foregroundColor: AD.onBandCream,
          disabledBackgroundColor: AD.cardHover,
          disabledForegroundColor: AD.textTertiary,
          padding: const EdgeInsets.symmetric(
              horizontal: Msg.s5, vertical: Msg.s3 + 2),
          shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(Msg.rMd)),
          textStyle: ADText.rowName().copyWith(fontSize: 15),
          elevation: 0,
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: AD.textPrimary,
          // [RAJ-PHASE1-2] 1 → AD.wBorder. HANDOFF rule 1 is 2px ink on cards,
          // rows, inputs, chips and buttons. The re-skinned screens draw 2px by
          // hand (AdButton, AdCard, AdField all do); anything inheriting from
          // ThemeData was drawing 1px right next to them.
          side: const BorderSide(color: AD.borderControl, width: AD.wBorder),
          shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(Msg.rMd)),
          textStyle: ADText.rowName().copyWith(fontSize: 15),
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          foregroundColor: AD.primaryBadge,
          textStyle: ADText.preview().copyWith(color: AD.primaryBadge),
        ),
      ),

      // NO default box. The design wraps every input in its own bordered
      // container (AdField, the chat composer, search bars), so a themed
      // filled+outlined box here drew a SECOND bar inside that container (the
      // "double bar" bug). Keep the theme borderless/unfilled; containers
      // supply the visual. (2026-06-18)
      inputDecorationTheme: InputDecorationTheme(
        filled: false,
        isDense: true,
        hintStyle: ADText.bubbleBody(c: AD.textTertiary).copyWith(fontSize: 16),
        labelStyle: ADText.sectionLabel(),
        border: InputBorder.none,
        enabledBorder: InputBorder.none,
        focusedBorder: InputBorder.none,
        disabledBorder: InputBorder.none,
        errorBorder: InputBorder.none,
        focusedErrorBorder: InputBorder.none,
      ),

      cardTheme: CardThemeData(
        color: AD.card,
        elevation: 0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(Msg.rLg),
          // 1 → AD.wBorder, matching AdCard.
          side: const BorderSide(color: AD.borderCard, width: AD.wBorder),
        ),
      ),

      // [RAJ-PHASE1-2] THE DIVIDER FIX. This pointed at `AD.borderHairline`,
      // which Phase 1 refilled with FULL INK (#16110D) because its other job
      // is card and row outlines. A token named "hairline" holding solid black
      // meant every `Divider()` in the app — settings, lists, sheets, menus —
      // painted a hard black rule where the design wants the faint one. That
      // is also what the stray rule under the AvaDial app bar was; it was not a
      // one-off.
      //
      // `AD.borderDivider` is ink at 14%, the same value the bead-stud rule
      // uses. Outlines stay on `borderHairline`/`borderCard`.
      // `space` is deliberately NOT set — it controls a Divider's total height
      // and changing it would silently re-space every list in the app. Colour
      // and thickness only.
      dividerTheme: const DividerThemeData(
          color: AD.borderDivider, thickness: 1),

      chipTheme: base.chipTheme.copyWith(
        backgroundColor: AD.card,
        selectedColor: AD.primaryBadge,
        labelStyle: ADText.statCaption(c: AD.textSecondary),
        secondaryLabelStyle: ADText.statCaption(c: AD.onBandCream),
        side: const BorderSide(color: AD.borderControl, width: AD.wBorder),
        shape: const StadiumBorder(),
        showCheckmark: false,
      ),

      switchTheme: SwitchThemeData(
        thumbColor: WidgetStateProperty.resolveWith((s) =>
            s.contains(WidgetState.selected) ? AD.onBandCream : AD.card),
        trackColor: WidgetStateProperty.resolveWith((s) =>
            s.contains(WidgetState.selected) ? AD.primaryBadge : AD.cardHover),
        trackOutlineColor: const WidgetStatePropertyAll(AD.borderControl),
        trackOutlineWidth: const WidgetStatePropertyAll(AD.wBorder),
      ),

      // [RAJ-PHASE4-1] Checkbox / Radio / Slider were entirely un-themed and
      // took Material's dark-mode defaults on cream.
      checkboxTheme: CheckboxThemeData(
        fillColor: WidgetStateProperty.resolveWith((s) =>
            s.contains(WidgetState.selected) ? AD.primaryBadge : AD.card),
        checkColor: const WidgetStatePropertyAll(AD.onBandCream),
        side: const BorderSide(color: AD.borderControl, width: AD.wBorder),
        shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(Msg.rSm - 4)),
      ),
      radioTheme: RadioThemeData(
        fillColor: WidgetStateProperty.resolveWith((s) =>
            s.contains(WidgetState.selected)
                ? AD.primaryBadge
                : AD.textSecondary),
      ),
      sliderTheme: SliderThemeData(
        activeTrackColor: AD.primaryBadge,
        inactiveTrackColor: AD.cardHover,
        thumbColor: AD.primaryBadge,
        overlayColor: AD.primaryBadge.withValues(alpha: 0.14),
        valueIndicatorColor: AD.textPrimary,
        valueIndicatorTextStyle: ADText.statCaption(c: AD.bg),
      ),

      snackBarTheme: SnackBarThemeData(
        // [RAJ-PHASE4-1] The page is now CREAM, so a cream snackbar is
        // invisible. It must read as a surface against paper: ink fill, cream
        // type — the one intentionally inverted surface in the app.
        backgroundColor: AD.textPrimary,
        contentTextStyle: ADText.bubbleBody(c: AD.bg),
        actionTextColor: AD.haldi,
        shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(Msg.rMd)),
        behavior: SnackBarBehavior.floating,
        // App-wide dismiss affordance. Snackbars carrying a SnackBarAction
        // (e.g. "Can't reach the network — Retry") otherwise give the user no
        // way to get rid of them; swipe-to-dismiss alone is not discoverable.
        showCloseIcon: true,
        closeIconColor: AD.bg,
      ),

      // [RAJ-PHASE4-1] Was un-themed: Material's default tooltip is a dark
      // slab, which is now neither the page nor a surface in this palette.
      tooltipTheme: TooltipThemeData(
        decoration: BoxDecoration(
          color: AD.textPrimary,
          borderRadius: BorderRadius.circular(Msg.rSm),
        ),
        textStyle: ADText.statCaption(c: AD.bg),
        padding: const EdgeInsets.symmetric(horizontal: Msg.s2, vertical: Msg.s1),
      ),
      bannerTheme: MaterialBannerThemeData(
        backgroundColor: AD.card,
        contentTextStyle: ADText.bubbleBody(),
        dividerColor: AD.borderDivider,
      ),
      drawerTheme: const DrawerThemeData(
        backgroundColor: AD.bg,
        surfaceTintColor: Colors.transparent,
        scrimColor: AD.scrim,
      ),

      progressIndicatorTheme:
          const ProgressIndicatorThemeData(color: AD.primaryBadge),
      bottomSheetTheme: const BottomSheetThemeData(
        backgroundColor: AD.overlaySheet,
        surfaceTintColor: Colors.transparent,
        modalBarrierColor: AD.scrim,
        shape: RoundedRectangleBorder(borderRadius: Msg.brSheetTop),
      ),
      dialogTheme: DialogThemeData(
        backgroundColor: AD.card,
        surfaceTintColor: Colors.transparent,
        titleTextStyle: ADText.threadName(),
        contentTextStyle: ADText.bubbleBody(c: AD.textSecondary),
        shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(Msg.rLg)),
      ),
      popupMenuTheme: PopupMenuThemeData(
        color: AD.menu,
        surfaceTintColor: Colors.transparent,
        textStyle: ADText.bubbleBody(),
        shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(Msg.rMd)),
      ),
      listTileTheme: const ListTileThemeData(
        textColor: AD.textPrimary,
        iconColor: AD.iconNeutral,
        subtitleTextStyle: null,
      ),
      iconTheme: const IconThemeData(color: AD.iconNeutral),
      primaryIconTheme: const IconThemeData(color: AD.iconNeutral),
    );
  }

  /// [RAJ-SEAMS-1] An app bar sitting ON one of the four band hues.
  ///
  /// The retheme assigns a band hue per area (turquoise for AvaTalk, indigo for
  /// Calls and Wallet, rani for Ava and Profile, haldi for Settings and
  /// Updates). Wrap the screen's `Scaffold` in
  /// `Theme(data: Theme.of(context).copyWith(appBarTheme: AvaTheme.bandAppBar(AD.bandIndigo)), …)`
  /// — or pass the pieces to your own header widget — instead of setting
  /// `backgroundColor` and then discovering the title, the icons and the status
  /// bar are still ink.
  ///
  /// Three things move together and this is why the helper exists: the fill,
  /// the foreground (via [AD.onBand]) and the STATUS BAR icon brightness. Set
  /// the fill alone on a dark band and the system clock disappears.
  ///
  /// [seam] true (default) omits the bottom rule entirely — where a band meets
  /// paper the seam widget draws the edge, and a hairline under it reads as a
  /// stray rule across one continuous band. That is the AvaDial hairline, fixed
  /// at the source rather than deleted per screen.
  static AppBarTheme bandAppBar(Color band, {bool seam = true}) {
    final fg = AD.onBand(band);
    return AppBarTheme(
      backgroundColor: band,
      foregroundColor: fg,
      elevation: 0,
      scrolledUnderElevation: 0,
      centerTitle: false,
      titleTextStyle: ADText.appTitle(c: fg),
      iconTheme: IconThemeData(color: fg),
      actionsIconTheme: IconThemeData(color: fg),
      systemOverlayStyle: _overlayFor(band),
      shape: seam
          ? null
          : Border(bottom: BorderSide(color: AD.borderDivider, width: 1)),
    );
  }

  /// Status-bar icon brightness for content sitting on [fill]. Light bands
  /// (turquoise, haldi, cream) take dark icons; dark bands (indigo, rani) take
  /// light ones. Same threshold as [AD.onBand] so the two can never disagree.
  static SystemUiOverlayStyle _overlayFor(Color fill) {
    final lightBand = fill.computeLuminance() > 0.5;
    return SystemUiOverlayStyle(
      statusBarColor: Colors.transparent,
      statusBarIconBrightness:
          lightBand ? Brightness.dark : Brightness.light,
      statusBarBrightness: lightBand ? Brightness.light : Brightness.dark,
      systemNavigationBarColor: fill,
      systemNavigationBarIconBrightness:
          lightBand ? Brightness.dark : Brightness.light,
    );
  }

  /// The AvaTOK wordmark is the one branded exception to native UI type.
  static TextStyle wordmark(double size, {Color color = AD.textPrimary}) =>
      TextStyle(
          fontFamily: 'Nunito',
          fontWeight: FontWeight.w700,
          fontSize: size,
          letterSpacing: -0.02 * size,
          color: color);
}
