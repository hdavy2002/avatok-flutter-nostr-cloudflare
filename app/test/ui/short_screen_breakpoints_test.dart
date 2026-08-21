import 'package:avatok_call/core/ui/breakpoints.dart';
import 'package:flutter_test/flutter_test.dart';

/// [RESP-SHORT-1 2026-08-21] Contract for the HEIGHT tier in
/// `core/ui/breakpoints.dart`.
///
/// Deliberately pure arithmetic against the `*For`/`*Height` forms — no widget
/// pumping, no MediaQuery, no golden. There is no local Flutter toolchain on
/// the machine this was written on, so a test that cannot be run here is only
/// worth adding if it is simple enough to be obviously correct by reading; a
/// pumped widget tree is not.
///
/// The three sizes below are the ones the audit measured
/// (Specs/AUDIT-SHORT-SCREEN-2026-08-21.md).
void main() {
  const keyone = 590.0; // BlackBerry-style QWERTY handset: 393 x 590dp
  const tiny = 480.0; // the genuinely tiny phone: 320 x 480dp
  const ordinary = 852.0; // ordinary modern handset, the control

  test('the ordinary handset is not short and is not touched at all', () {
    expect(ZineBreakpoints.isShortHeight(ordinary), isFalse);
    expect(ZineBreakpoints.heroHeightFractionFor(ordinary), 1.0);
    expect(ZineBreakpoints.verticalChromeScaleFor(ordinary), 1.0);
  });

  test('the QWERTY handset lands in the short tier', () {
    expect(ZineBreakpoints.isShortHeight(keyone), isTrue);
    expect(ZineBreakpoints.heroHeightFractionFor(keyone), 0.42);
    expect(ZineBreakpoints.verticalChromeScaleFor(keyone), 0.85);
  });

  test('the tiny phone lands in the extra-short tier', () {
    expect(ZineBreakpoints.isShortHeight(tiny), isTrue);
    expect(ZineBreakpoints.heroHeightFractionFor(tiny), 0.34);
    expect(ZineBreakpoints.verticalChromeScaleFor(tiny), 0.72);
  });

  test('thresholds are exclusive upper bounds', () {
    // A device sitting exactly ON a boundary belongs to the LARGER tier, which
    // is the same convention `classify()` uses for width.
    expect(ZineBreakpoints.isShortHeight(ZineBreakpoints.shortMax), isFalse);
    expect(ZineBreakpoints.heroHeightFractionFor(ZineBreakpoints.shortMax), 1.0);
    expect(ZineBreakpoints.verticalChromeScaleFor(ZineBreakpoints.xshortMax),
        0.85);
  });

  test('the hero cap is what actually shrinks the call hero on the tester phone',
      () {
    // `call_hero_composition.dart` caps the 340x350 ringing motif at
    // `heroHeightFraction * viewportHeight`. Restated here as the number the
    // owner is being promised: ~350dp of hero becomes ~248dp on a 590dp screen,
    // and stays 350dp on an ordinary phone.
    expect(ZineBreakpoints.heroHeightFractionFor(keyone) * keyone,
        closeTo(247.8, 0.1));
    expect(ZineBreakpoints.heroHeightFractionFor(ordinary) * ordinary,
        greaterThan(350.0),
        reason: 'the cap must not bind on the phone the design was signed off '
            'on — if it does, this is no longer an opt-in relief');
  });

  test('the width tier is unchanged — the QWERTY phone is a REGULAR width', () {
    // The whole reason this tier exists: 393dp wide classifies `regular`, so
    // every width-keyed lever ([RESP-SMALL-1], [RESP-SMALL-2]) misses it.
    expect(ZineBreakpoints.classify(393), ZineWidthClass.regular);
    expect(ZineBreakpoints.classify(320), ZineWidthClass.compact);
  });
}
