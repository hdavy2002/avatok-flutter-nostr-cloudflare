import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

import '../../core/ui/avatok_dark.dart';
import '../../core/ui/breakpoints.dart';
import '../../core/ui/illustrations.dart';
import '../../core/ui/rajasthani_motifs.dart';

/// [UI-CALLS-2026] ONE transparent composition for the ringing / unreachable /
/// no-answer call screen: the Rajasthani hero art (temple bell, marigold petal
/// wheel, black dotted orbit, the little truck) AND the caller's photo, in a
/// single widget.
///
/// Why this exists at all. The audio call screen used to build a bare
/// `Stack(alignment: Alignment.center, …)` of an `SvgPicture` with an `Avatar`
/// laid over it. Two separate things:
///
///  1. `Alignment.center` centres the avatar on the SVG's GEOMETRIC centre.
///     The petal wheel and the dotted orbit in `06-in-call-illo-1.svg` are
///     centred at (170, 224) of a 340x350 viewBox — 49px BELOW that. So the
///     photo sat visibly high inside its decoration, which is the owner's
///     "centre the profile photo inside the circular decoration".
///  2. Nothing tied the avatar's size to the orbit's radius, so any change to
///     one drifted away from the other.
///
/// Here the medallion centre and radius of each illustration are declared once
/// ([_HeroGeom]) and the photo is `Positioned` from those fractions, so the
/// whole thing is ONE widget in the scrolling column: art and photo move
/// together, at any width, on any phone.
///
/// The composition paints no background of its own — it is transparent over
/// whatever page surface hosts it.
class CallHeroComposition extends StatelessWidget {
  const CallHeroComposition({
    super.key,
    required this.connected,
    required this.centre,
    this.maxWidth = 340,
  });

  /// `true` once the call is live — swaps to the connected motif, exactly as
  /// the old call site did (mirrors `CallSession.isConnected`).
  final bool connected;

  /// Builds what sits in the middle of the medallion (the caller photo, or the
  /// Ava countdown). Given the diameter it must fill, so the caller never has
  /// to guess a size that fits the orbit.
  final Widget Function(double diameter) centre;

  /// Upper bound on the composition width; it also shrinks to fit narrow
  /// phones. Height follows the illustration's own aspect ratio.
  final double maxWidth;

  @override
  Widget build(BuildContext context) {
    final g = connected ? _kHeroConnected : _kHeroRinging;
    final available = MediaQuery.of(context).size.width - 48;
    var w = math.max(200.0, math.min(maxWidth, available));
    var h = w * g.vbH / g.vbW;
    // [RESP-SHORT-1 2026-08-21] HEIGHT CAP. The three lines above derive the
    // whole composition from WIDTH alone, and `_kHeroRinging` is a 340x350
    // viewBox — TALLER than it is wide. On the tester's QWERTY handset
    // (393 x 590dp: normal width, two-thirds the usual height) that resolved to
    // a 350dp hero, 59% of the entire viewport, which pushed the peer's name up
    // under the header and everything else below the fold
    // (Specs/AUDIT-SHORT-SCREEN-2026-08-21.md finding 5).
    //
    // `heroHeightFraction` returns 1.0 on a normal phone, so `capH` is the
    // WHOLE viewport there (852dp) and the branch below never runs — this
    // changes NOTHING on the geometry the owner signed off on. It only bites
    // below 640dp tall: 0.42 x 590 = 248dp on the tester's phone.
    // Width is re-derived from the capped height so the artwork keeps its
    // aspect ratio, and `d` / `stud` below key off `w`, so the medallion and
    // the studs follow without further arithmetic.
    final capH = ZineBreakpoints.heroHeightFraction(context) *
        MediaQuery.sizeOf(context).height;
    if (h > capH) {
      h = capH;
      w = h * g.vbW / g.vbH;
    }
    // The photo fills ~70% of the dotted orbit — the same 132px-in-340px
    // proportion the screen shipped with, now derived instead of hard-coded.
    final d = w * (2 * g.r * 0.70) / g.vbW;
    // Motif studs: small enough to read as punctuation in the empty corners,
    // never as a second subject. Two per composition, no more.
    final stud = w * 0.062;

    return SizedBox(
      width: w,
      height: h,
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          Positioned.fill(
            child: SvgPicture.asset(
              g.asset,
              fit: BoxFit.contain,
              excludeFromSemantics: true,
            ),
          ),
          // Tasteful Holi punctuation in the empty corners — the shared
          // `LotusRosettePlate` painter, not new art.
          Positioned(
            right: w * 0.02,
            top: h * 0.10,
            child: LotusRosettePlate(
              size: stud,
              plateColor: AD.primaryBadge,
              centerColor: AD.haldi,
            ),
          ),
          Positioned(
            left: w * 0.04,
            top: h * 0.08,
            child: LotusRosettePlate(
              size: stud * 0.8,
              plateColor: AD.haldi,
              centerColor: AD.primaryBadge,
            ),
          ),
          // The photo, centred on the medallion the art actually draws.
          Positioned(
            left: w * g.cx / g.vbW - d / 2,
            top: h * g.cy / g.vbH - d / 2,
            width: d,
            height: d,
            child: Center(child: centre(d)),
          ),
        ],
      ),
    );
  }
}

/// Where the petal wheel / dotted orbit actually sits inside one illustration,
/// in its own viewBox units. Read straight off the SVG — if the designer ships
/// a new revision, these four numbers are the only thing to re-check.
class _HeroGeom {
  const _HeroGeom({
    required this.asset,
    required this.vbW,
    required this.vbH,
    required this.cx,
    required this.cy,
    required this.r,
  });

  final String asset;
  final double vbW;
  final double vbH;

  /// Medallion centre.
  final double cx;
  final double cy;

  /// Dotted-orbit radius.
  final double r;
}

/// `06-in-call-illo-1.svg` — viewBox 340x350, orbit `cx=170 cy=224 r=94`.
const _kHeroRinging = _HeroGeom(
  asset: Illustrations.inCallHero1,
  vbW: 340,
  vbH: 350,
  cx: 170,
  cy: 224,
  r: 94,
);

/// `06-in-call-illo-2.svg` — viewBox 320x300, orbit `cx=160 cy=150 r=92`.
const _kHeroConnected = _HeroGeom(
  asset: Illustrations.inCallHero2,
  vbW: 320,
  vbH: 300,
  cx: 160,
  cy: 150,
  r: 92,
);
