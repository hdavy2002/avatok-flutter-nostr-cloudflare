// ignore_for_file: deprecated_member_use_from_same_package
import 'dart:ui' show Color;

import 'package:flutter/painting.dart' show HSVColor;
import 'package:flutter_test/flutter_test.dart';
import 'package:hf_app/core/theme/hf_tokens.dart';

void main() {
  // Enumerated by hand on purpose: adding a colour to HfColors without listing it here is caught by the count check.
  final colours = <String, Color>{
    'ink': HfColors.ink,
    'page': HfColors.page,
    'surface': HfColors.surface,
    'primary': HfColors.primary,
    'onPrimary': HfColors.onPrimary,
    'white': HfColors.white,
    'sunshine': HfColors.sunshine,
    'deepOrange': HfColors.deepOrange,
    'lavender': HfColors.lavender,
    'lavenderInk': HfColors.lavenderInk,
    'lavenderDeep': HfColors.lavenderDeep,
    'peach': HfColors.peach,
    'peachInk': HfColors.peachInk,
    'peachDeep': HfColors.peachDeep,
    'peachWave': HfColors.peachWave,
    'sky': HfColors.sky,
    'skyInk': HfColors.skyInk,
    'skyDeep': HfColors.skyDeep,
    'butter': HfColors.butter,
    'butterInk': HfColors.butterInk,
    'butterDeep': HfColors.butterDeep,
    'blush': HfColors.blush,
    'blushInk': HfColors.blushInk,
    'blushDeep': HfColors.blushDeep,
    'rose': HfColors.rose,
    'roseDot': HfColors.roseDot,
    'amberDot': HfColors.amberDot,
    'verifiedBlue': HfColors.verifiedBlue,
    'link': HfColors.link,
    'star': HfColors.star,
    'accent': HfColors.accent,
    'muted': HfColors.muted,
    'mutedSoft': HfColors.mutedSoft,
    'line': HfColors.line,
    'surfaceSoft': HfColors.surfaceSoft,
    'segmentTrack': HfColors.segmentTrack,
    'handle': HfColors.handle,
    'inkSoft': HfColors.inkSoft,
    'inkTagline': HfColors.inkTagline,
    'outlineChip': HfColors.outlineChip,
    'butterValue': HfColors.butterValue,
    'darkBg': HfColors.darkBg,
    'darkCard': HfColors.darkCard,
    'darkTile': HfColors.darkTile,
    'darkTileSky': HfColors.darkTileSky,
    'darkTileBlush': HfColors.darkTileBlush,
    'darkTilePeach': HfColors.darkTilePeach,
    'darkTileButter': HfColors.darkTileButter,
    'darkNav': HfColors.darkNav,
    'darkSelected': HfColors.darkSelected,
    'darkText': HfColors.darkText,
    'lavenderLight': HfColors.lavenderLight,
    'peachLight': HfColors.peachLight,
    'blushLight': HfColors.blushLight,
    'skyLight': HfColors.skyLight,
    'butterLight': HfColors.butterLight,
    'darkBar': HfColors.darkBar,
    'darkLine': HfColors.darkLine,
    'blushDot': HfColors.blushDot,
  };

  test('no HfColors value has a green hue (owner rule)', () {
    for (final e in colours.entries) {
      final hsv = HSVColor.fromColor(e.value);
      final green = hsv.hue >= 75 && hsv.hue <= 165 && hsv.saturation > 0.25;
      expect(
        green,
        isFalse,
        reason:
            '${e.key} hue ${hsv.hue.toStringAsFixed(0)} sat ${hsv.saturation.toStringAsFixed(2)}',
      );
    }
  });

  test('the list above covers HfColors.all', () {
    expect(colours.length, HfColors.all.length);
    for (final c in HfColors.all) {
      expect(
        colours.containsValue(c),
        isTrue,
        reason: '$c missing from the test list',
      );
    }
  });

  test('key colours match the approved mockups', () {
    expect(HfColors.ink, const Color(0xFF000000));
    expect(HfColors.page, const Color(0xFFF6F3EE));
    expect(HfColors.surface, const Color(0xFFFFFDF9));
    expect(HfColors.darkCard, const Color(0xFF343438));
    expect(HfColors.primary, const Color(0xFFF28C28));
    expect(HfColors.onPrimary, const Color(0xFF231407));
    expect(HfColors.lavender, const Color(0xFFE7E1FF));
    expect(HfColors.darkBg, const Color(0xFF000000));
    expect(HfColors.butterDeep, const Color(0xFF6E4F00));
    expect(HfColors.sunshine, const Color(0xFFFFC93C));
    expect(HfColors.deepOrange, const Color(0xFFE8641B));
  });

  test('motion gradients and the confetti palette use the warm tokens', () {
    expect(HfGradients.sun.colors, [HfColors.sunshine, HfColors.primary]);
    expect(HfGradients.sunDeep.colors, [HfColors.primary, HfColors.deepOrange]);
    expect(HfConfetti.palette, [
      HfColors.primary,
      HfColors.sunshine,
      HfColors.blush,
      HfColors.lavender,
    ]);
  });

  test('deprecated aliases point at non-green colours', () {
    final aliases = [
      HfColors.plum,
      HfColors.cream,
      HfColors.lilac,
      HfColors.orchid,
      HfColors.mauve,
      HfColors.mint,
      HfColors.coral,
      HfColors.forest,
    ];
    for (final c in aliases) {
      final hsv = HSVColor.fromColor(c);
      expect(hsv.hue >= 75 && hsv.hue <= 165 && hsv.saturation > 0.25, isFalse);
    }
  });
}
