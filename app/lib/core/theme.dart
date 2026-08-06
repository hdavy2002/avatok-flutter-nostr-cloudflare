import 'package:flutter/material.dart';

import 'ui/avatok_dark.dart';
import 'ui/messenger_theme.dart';

// [UI-ZINE-KILL-1 2026-08-05] The light design system is GONE.
//
// This file used to `import 'ui/zine.dart'` and re-export `Zine` + `ZineText`,
// which silently put the whole LIGHT palette in scope for anything that
// imported theme.dart — a screen could keep using `Zine.paper` forever without
// ever importing the light system. That re-export was the single thing keeping
// `core/ui/zine.dart` alive; every one of its ~1,600 call sites has now been
// migrated to AD / ADText / Msg, so both the import and the export are gone and
// the file has been deleted. `AvaColors` went with it (nothing referenced it).
//
// `ZineWidthClass` / `ZineBreakpoints` were NOT part of the palette — they are
// pure layout utilities and now live in `core/ui/breakpoints.dart`.
//
// ⚠️ DO NOT RE-ADD a light palette here. The app renders dark on every surface
// regardless of the OS light/dark setting; a "light" fallback in the global
// ThemeData is what produced the cream flashes this theme now fixes.

/// [UI-NOMOTION-1 2026-08-06] A `PageTransitionsBuilder` that does nothing.
///
/// `buildTransitions` returns the child untouched, so a push/pop is an instant
/// cut with no scale, no fade and no slide. Used for Android in
/// [AvaTheme.light] — see the note there for why iOS keeps Cupertino.
class _NoPageTransition extends PageTransitionsBuilder {
  const _NoPageTransition();

  @override
  Widget buildTransitions<T>(
    PageRoute<T>? route,
    BuildContext? context,
    Animation<double> animation,
    Animation<double> secondaryAnimation,
    Widget child,
  ) =>
      child;
}

class AvaTheme {
  /// The app's ONLY theme. Still named `light` because `MaterialApp(theme:)`
  /// takes the light slot and ~every reference in the app says `AvaTheme.light`
  /// — renaming it buys nothing and touches every call site. The VALUES are
  /// dark; that is what matters.
  ///
  /// [UI-ZINE-KILL-1] Before this, `scaffoldBackgroundColor` was `Zine.paper`
  /// (#F9F7ED cream) and the whole Material widget set — AppBar, buttons,
  /// chips, switches, snackbars, dividers, card — was themed light while every
  /// actual screen painted itself `AD.bg` near-black. Any Scaffold that forgot
  /// an explicit `backgroundColor`, and every un-themed Material widget, came
  /// out light-on-dark. That mismatch was the root of the cream flash on
  /// startup and of the stray pale chrome scattered through the app.
  static ThemeData get light {
    final base = ThemeData(
      useMaterial3: true,
      brightness: Brightness.dark,
      colorScheme: const ColorScheme.dark(
        primary: AD.primaryBadge,
        onPrimary: AD.textOnInput,
        secondary: AD.newGroup,
        onSecondary: AD.textPrimary,
        error: AD.danger,
        onError: AD.textPrimary,
        surface: AD.card,
        onSurface: AD.textPrimary,
      ),
      scaffoldBackgroundColor: AD.bg,
      canvasColor: AD.bg,
      fontFamily: ADText.family,
      // [UI-NOMOTION-1 2026-08-06] Android pushes are a HARD CUT.
      //
      // Android was on `ZoomPageTransitionsBuilder` — Material 3's zoom, which
      // scales the incoming route up from ~0.85 with a cross-fade while scaling
      // the outgoing one. That is the "bouncy, jittery, then it settles" the
      // owner reported on opening a chat thread: the whole screen was literally
      // growing into place over ~300ms, and every staged data load landing
      // during that window (cached messages, receipts, wallpaper) repainted
      // mid-zoom. Owner decision: no animation, no effects.
      //
      // iOS/macOS KEEP `CupertinoPageTransitionsBuilder` on purpose. Its slide
      // is inseparable from the interactive back-swipe gesture — replacing it
      // with a no-op would silently remove edge-swipe-to-go-back, which is a
      // behaviour loss, not a visual one. AvaTOK ships Android today, so the
      // platform the owner sees is a hard cut either way.
      //
      // Supersedes [AVA-FLASH-1] (2026-07-17), which fixed a WHITE FLASH during
      // this same transition by pinning its fill to `AD.bg`. With no transition
      // there is no fill to pin, so that flash cannot return here — but do NOT
      // reintroduce a zoom without also reinstating `backgroundColor: AD.bg`.
      pageTransitionsTheme: const PageTransitionsTheme(builders: {
        TargetPlatform.android: _NoPageTransition(),
        TargetPlatform.iOS: CupertinoPageTransitionsBuilder(),
        TargetPlatform.macOS: CupertinoPageTransitionsBuilder(),
      }),
    );

    final textTheme = base.textTheme
        .apply(
          fontFamily: ADText.family,
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
      appBarTheme: AppBarTheme(
        backgroundColor: AD.bg,
        foregroundColor: AD.textPrimary,
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: false,
        titleTextStyle: ADText.appTitle(),
        shape: const Border(
            bottom: BorderSide(color: AD.borderHairline, width: 1)),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: AD.primaryBadge,
          // Dark ink on the accent, not white: white on #E8833A is ~2.5:1.
          foregroundColor: AD.textOnInput,
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
          side: const BorderSide(color: AD.borderControl, width: 1),
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
          side: const BorderSide(color: AD.borderHairline, width: 1),
        ),
      ),
      dividerTheme:
          const DividerThemeData(color: AD.borderHairline, thickness: 1),
      chipTheme: base.chipTheme.copyWith(
        backgroundColor: AD.card,
        selectedColor: AD.primaryBadge,
        labelStyle: ADText.statCaption(c: AD.textSecondary),
        side: const BorderSide(color: AD.borderControl, width: 1),
        shape: const StadiumBorder(),
      ),
      switchTheme: SwitchThemeData(
        thumbColor: WidgetStateProperty.resolveWith((s) =>
            s.contains(WidgetState.selected) ? AD.textOnInput : AD.textTertiary),
        trackColor: WidgetStateProperty.resolveWith((s) =>
            s.contains(WidgetState.selected) ? AD.primaryBadge : AD.cardHover),
        trackOutlineColor:
            const WidgetStatePropertyAll(AD.borderControl),
        trackOutlineWidth: const WidgetStatePropertyAll(1),
      ),
      snackBarTheme: SnackBarThemeData(
        // The snackbar sits ON the dark page, so it must be LIGHTER than the
        // canvas to read as a surface — the old theme used near-black ink,
        // which is now the page itself.
        backgroundColor: AD.cardHover,
        contentTextStyle: ADText.bubbleBody(),
        shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(Msg.rMd)),
        behavior: SnackBarBehavior.floating,
        // App-wide dismiss affordance. Snackbars carrying a SnackBarAction
        // (e.g. the "Can't reach the network — Retry" banner) otherwise give
        // the user no way to get rid of them; swipe-to-dismiss alone is not
        // discoverable.
        showCloseIcon: true,
        closeIconColor: AD.textSecondary,
      ),
      progressIndicatorTheme:
          const ProgressIndicatorThemeData(color: AD.primaryBadge),
      bottomSheetTheme: const BottomSheetThemeData(
        backgroundColor: AD.overlaySheet,
        surfaceTintColor: Colors.transparent,
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
        color: AD.card,
        surfaceTintColor: Colors.transparent,
        textStyle: ADText.bubbleBody(),
        shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(Msg.rMd)),
      ),
      listTileTheme: const ListTileThemeData(
        textColor: AD.textPrimary,
        iconColor: AD.iconNeutral,
      ),
      iconTheme: const IconThemeData(color: AD.iconNeutral),
    );
  }

  /// Brand wordmark — Nunito 700 (the only display weight in the system).
  static TextStyle wordmark(double size, {Color color = AD.textPrimary}) =>
      TextStyle(
          fontFamily: ADText.family,
          fontWeight: FontWeight.w700,
          fontSize: size,
          letterSpacing: -0.02 * size,
          color: color);
}
