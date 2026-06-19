import 'package:flutter/material.dart';

/// AvaTOK design system — tokens (AVATOK-DESIGN-SYSTEM.md §2–§4).
///
/// Editorial / zine / collage language: warm paper surfaces, thick warm-black
/// ink borders, HARD offset shadows (never blurred), flat poster-color fills
/// (no gradients, ever), Nunito everywhere.
///
/// All hex values are the sRGB equivalents of the canonical oklch tokens.
class Zine {
  Zine._();

  // ---- surfaces ----
  /// Page background — warm off-white. oklch(0.975 0.013 95)
  static const paper = Color(0xFFF9F7ED);
  /// Tinted band / secondary surface. oklch(0.955 0.018 92)
  static const paper2 = Color(0xFFF4F0E3);
  /// Card & component surface (near-white). oklch(0.995 0.004 95)
  static const card = Color(0xFFFEFDFA);

  // ---- ink (text + borders + shadows) ----
  /// Primary text, ALL borders, ALL shadows. oklch(0.23 0.018 60)
  static const ink = Color(0xFF231B14);
  /// Secondary text. oklch(0.42 0.02 62)
  static const inkSoft = Color(0xFF554B42);
  /// Tertiary text, disabled, captions. oklch(0.60 0.02 62)
  static const inkMute = Color(0xFF897E74);
  /// Input placeholder. oklch(0.62 0.02 62)
  static const placeholder = Color(0xFF8F847A);

  // ---- poster accents (flat fills only) ----
  /// Pale aqua-blue — brand fill. oklch(0.92 0.085 190)
  static const blue = Color(0xFFA0F7F1);
  /// Deep teal-blue — accent TEXT color ("TOK"), links. oklch(0.52 0.12 196)
  static const blueInk = Color(0xFF007D7F);
  /// Acid lime — THE primary action color. oklch(0.88 0.18 124)
  static const lime = Color(0xFFBFEB56);
  /// Coral — destructive/error (the ONLY fill that takes white text). oklch(0.70 0.19 32)
  static const coral = Color(0xFFFE674C);
  /// Lilac — AI/magic features. oklch(0.80 0.10 305)
  static const lilac = Color(0xFFCDAEF2);
  /// Mint — money/success. oklch(0.86 0.14 158)
  static const mint = Color(0xFF77EDAE);
  /// Mint accent-text variant. oklch(0.55 0.13 158)
  static const mintInk = Color(0xFF008853);

  // ---- derived tints ----
  /// Tape strip fill: lime @62%.
  static const tape = Color(0x9EBFEB56);
  /// Coral marker-highlight variant @34%.
  static const coralMark = Color(0x57FE674C);
  /// Blue marker-highlight variant @50%.
  static const blueMark = Color(0x80A0F7F1);

  // ---- geometry ----
  /// Default card radius.
  static const double r = 22;
  /// Small card / tile radius.
  static const double rSm = 16;
  /// Field radius.
  static const double rField = 18;
  /// Icon badge radius.
  static const double rBadge = 11;
  /// Standard border width on every contained element.
  static const double bw = 2.5;
  /// Heavy border (hero crest, extra-large containers).
  static const double bwLg = 3;

  // ---- hard offset shadows (NEVER blurred) ----
  /// Large offset shadow — hero cards/badges. 6px 7px 0 ink.
  static const shadow = [BoxShadow(color: ink, offset: Offset(6, 7))];
  /// Small offset shadow — buttons/chips/cards. 3px 3px 0 ink.
  static const shadowSm = [BoxShadow(color: ink, offset: Offset(3, 3))];
  /// Tiny offset — sticker pills. 2px 2px 0 ink.
  static const shadowXs = [BoxShadow(color: ink, offset: Offset(2, 2))];
  /// Pressed-in shadow. 1px 1px 0 ink.
  static const shadowPressed = [BoxShadow(color: ink, offset: Offset(1, 1))];
  /// Focused-field shadow (blue-ink). 5px 6px 0 blueInk.
  static const shadowFocus = [BoxShadow(color: blueInk, offset: Offset(5, 6))];
  /// Error-field shadow (coral). 5px 6px 0 coral.
  static const shadowError = [BoxShadow(color: coral, offset: Offset(5, 6))];

  /// Standard ink border.
  static Border get border => Border.all(color: ink, width: bw);
  static Border get borderLg => Border.all(color: ink, width: bwLg);

  /// Snappy motion (§5).
  static const dur = Duration(milliseconds: 120);
  static const durSlow = Duration(milliseconds: 250);

  /// Accent rotation for adjacent icon badges (§6).
  static const accents = [blue, lime, coral, lilac, mint];
}

/// Typography (§3). Single bundled font — Nunito.
class ZineText {
  ZineText._();

  // All text uses Nunito (owner request 2026-06-19). The display/mono aliases
  // are kept so per-role call sites and letter-spacing tuning still work.
  static const display = 'Nunito';
  static const body = 'Nunito';
  static const mono = 'Nunito';

  /// Screen hero title — Nunito 600, 34–38px, tight.
  static TextStyle hero({double size = 36, Color color = Zine.ink}) => TextStyle(
        fontFamily: display, fontWeight: FontWeight.w600, fontSize: size,
        height: 1.08, letterSpacing: -0.02 * size, color: color);

  /// Appbar title — Nunito 600 27px.
  static TextStyle appbar({Color color = Zine.ink}) => TextStyle(
        fontFamily: display, fontWeight: FontWeight.w600, fontSize: 27,
        height: 1.05, letterSpacing: -0.4, color: color);

  /// Card title — Nunito 600 19px.
  static TextStyle cardTitle({double size = 19, Color color = Zine.ink}) => TextStyle(
        fontFamily: display, fontWeight: FontWeight.w600, fontSize: size,
        height: 1.1, letterSpacing: -0.2, color: color);

  /// Big stat / money — Nunito 600 38–58px.
  static TextStyle stat({double size = 38, Color color = Zine.ink}) => TextStyle(
        fontFamily: display, fontWeight: FontWeight.w600, fontSize: size,
        height: 1.0, letterSpacing: -0.02 * size, color: color);

  /// Button label — Nunito 600 17–22px.
  static TextStyle button({double size = 19, Color color = Zine.ink}) => TextStyle(
        fontFamily: display, fontWeight: FontWeight.w600, fontSize: size,
        height: 1.0, letterSpacing: -0.2, color: color);

  /// Body / subtitle — Nunito 700, ink-soft.
  static TextStyle sub({double size = 15.5, Color color = Zine.inkSoft}) => TextStyle(
        fontFamily: body, fontWeight: FontWeight.w700, fontSize: size,
        height: 1.42, color: color);

  /// Emphasized body value — Nunito 800–900.
  static TextStyle value({double size = 16, Color color = Zine.ink, FontWeight weight = FontWeight.w800}) =>
      TextStyle(fontFamily: body, fontWeight: weight, fontSize: size, height: 1.3, color: color);

  /// Input text — Nunito 800, 18–19px.
  static TextStyle input({double size = 18, Color color = Zine.ink}) => TextStyle(
        fontFamily: body, fontWeight: FontWeight.w800, fontSize: size,
        letterSpacing: -0.18, color: color);

  /// Field label / kicker — Nunito 700 11px UPPERCASE.
  static TextStyle kicker({double size = 11, Color color = Zine.inkSoft}) => TextStyle(
        fontFamily: mono, fontWeight: FontWeight.w700, fontSize: size,
        letterSpacing: 0.08 * size, color: color);

  /// Caption / tag / sticker — Nunito 700 10.5–14px UPPERCASE.
  static TextStyle tag({double size = 12, Color color = Zine.ink}) => TextStyle(
        fontFamily: mono, fontWeight: FontWeight.w700, fontSize: size,
        letterSpacing: 0.04 * size, color: color);

  /// Mono link — Nunito 700, blue-ink.
  static TextStyle link({double size = 13, Color color = Zine.blueInk}) => TextStyle(
        fontFamily: mono, fontWeight: FontWeight.w700, fontSize: size, color: color);
}
