import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/widgets.dart';

import '../../data/models/merch.dart';
import 'svg_path.dart';

/// [HF-MERCH-STUDIO-2] Product silhouettes for the merch studio, the product cards and the mockups. Same drawings as the web studio
/// (web/src/islands/dashboard-hf/merch/studio/silhouettes.tsx): every family is an SVG path on a 1000 x 1000 box (front view) plus
/// the print-area box for front and back, as fractions of that box. [printAreaPx] fits the REAL inch aspect of the catalogue area inside it.

const List<String> kProductFamilies = <String>[
  'tee', 'tee_long', 'vneck', 'polo', 'crop_top', 'hoodie', 'crop_hoodie', 'sweatshirt', 'jacket', 'joggers', 'shorts',
  'tote', 'mug', 'bottle', 'phone_case', 'poster', 'notebook', 'popsocket', 'mousepad', 'mask', 'cap', 'other',
];

/// `#rrggbb` (or `#rgb`) as a colour; anything else becomes a light grey.
Color colourFromHex(String hex) {
  var h = hex.trim();
  if (h.startsWith('#')) h = h.substring(1);
  if (h.length == 3) h = '${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}';
  if (h.length == 8) h = h.substring(0, 6);
  final v = h.length == 6 ? int.tryParse(h, radix: 16) : null;
  return v == null ? const Color(0xFFE0E0E0) : Color(0xFF000000 | v);
}

/// `#rrggbb` for a colour (lower case).
String hexFromColour(Color c) {
  String two(double v) => math.max(0, math.min(255, (v * 255).round())).toRadixString(16).padLeft(2, '0');
  return '#${two(c.r)}${two(c.g)}${two(c.b)}';
}

/// The silhouette family of a catalogue item: the server's `family`, else a guess from kind / name.
String familyOfItem(CatalogItem item) {
  if (kProductFamilies.contains(item.family) && item.family != 'other') return item.family;
  final n = '${item.kind} ${item.name}'.toLowerCase();
  bool has(List<String> w) => w.any(n.contains);
  if (has(['crop']) && has(['hood'])) return 'crop_hoodie';
  if (has(['hood'])) return 'hoodie';
  if (has(['crop'])) return 'crop_top';
  if (has(['sweat'])) return 'sweatshirt';
  if (has(['jacket', 'bomber', 'windbreaker'])) return 'jacket';
  if (has(['jogger', 'pant', 'trouser', 'lower'])) return 'joggers';
  if (has(['short'])) return 'shorts';
  if (has(['polo'])) return 'polo';
  if (has(['v-neck', 'vneck', 'v neck'])) return 'vneck';
  if (has(['long sleeve', 'full sleeve'])) return 'tee_long';
  if (has(['tote', 'bag'])) return 'tote';
  if (has(['mug', 'cup'])) return 'mug';
  if (has(['bottle', 'tumbler', 'flask'])) return 'bottle';
  if (has(['phone', 'case', 'cover'])) return 'phone_case';
  if (has(['poster', 'frame', 'canvas'])) return 'poster';
  if (has(['note', 'diary', 'journal'])) return 'notebook';
  if (has(['pop', 'socket', 'grip'])) return 'popsocket';
  if (has(['mouse', 'desk'])) return 'mousepad';
  if (has(['mask'])) return 'mask';
  if (has(['cap', 'hat'])) return 'cap';
  if (has(['shirt', 'tee', 't-shirt', 'tshirt'])) return 'tee';
  return 'other';
}

enum SilDetailKind { line, shade, thick }

class SilDetail {
  const SilDetail(this.path, this.kind);
  final Path path;
  final SilDetailKind kind;
}

class Silhouette {
  const Silhouette(this.path, this.details, this.area);
  final Path path;
  final List<SilDetail> details;

  /// Print-area box as fractions of the 1000 x 1000 stage.
  final Rect area;
}

// ---------------------------------------------------------------------------------------------- garments

class _G {
  const _G({
    required this.nh, required this.ntop, required this.sx, required this.sy, required this.ox, required this.oy,
    required this.ex, required this.ey, required this.bh, required this.ay, required this.hy, required this.dipF, required this.dipB,
    this.vneck = false, this.hood = false,
  });

  final double nh, ntop, sx, sy, ox, oy, ex, ey, bh, ay, hy, dipF, dipB;
  final bool vneck, hood;

  _G tweak({double? nh, double? ox, double? oy, double? ex, double? ey, double? ay, double? hy, double? bh, double? dipF, bool? vneck}) => _G(
        nh: nh ?? this.nh, ntop: ntop, sx: sx, sy: sy, ox: ox ?? this.ox, oy: oy ?? this.oy, ex: ex ?? this.ex, ey: ey ?? this.ey,
        bh: bh ?? this.bh, ay: ay ?? this.ay, hy: hy ?? this.hy, dipF: dipF ?? this.dipF, dipB: dipB, vneck: vneck ?? this.vneck, hood: hood,
      );
}

const _G _tee = _G(nh: 105, ntop: 118, sx: 255, sy: 150, ox: 410, oy: 265, ex: 335, ey: 395, bh: 245, ay: 345, hy: 880, dipF: 62, dipB: 20);

final Map<String, _G> _garments = <String, _G>{
  'tee': _tee,
  'tee_long': _tee.tweak(ox: 430, oy: 700, ex: 335, ey: 735, ay: 350),
  'vneck': _tee.tweak(dipF: 150, vneck: true),
  'polo': _tee.tweak(dipF: 40, nh: 98),
  'crop_top': _tee.tweak(hy: 640, bh: 238),
  'hoodie': const _G(nh: 118, ntop: 175, sx: 262, sy: 215, ox: 440, oy: 730, ex: 345, ey: 765, bh: 250, ay: 410, hy: 915, dipF: 50, dipB: 30, hood: true),
  'crop_hoodie': const _G(nh: 118, ntop: 175, sx: 262, sy: 215, ox: 440, oy: 700, ex: 345, ey: 735, bh: 250, ay: 410, hy: 720, dipF: 50, dipB: 30, hood: true),
  'sweatshirt': const _G(nh: 112, ntop: 135, sx: 258, sy: 172, ox: 435, oy: 730, ex: 340, ey: 765, bh: 248, ay: 380, hy: 890, dipF: 52, dipB: 24),
  'jacket': const _G(nh: 104, ntop: 120, sx: 262, sy: 160, ox: 440, oy: 730, ex: 342, ey: 765, bh: 252, ay: 385, hy: 895, dipF: 10, dipB: 10),
};

String _f(num n) => ((n * 10).round() / 10).toStringAsFixed(1);
double _lerp(double a, double b, double t) => a + (b - a) * t;
String _lp(double h, double y) => '${_f(500 - h)} ${_f(y)}';
String _rp(double h, double y) => '${_f(500 + h)} ${_f(y)}';

String _garmentPath(_G g, String side) {
  final dip = side == 'front' ? g.dipF : g.dipB;
  String neck;
  if (g.hood) {
    final top = g.ntop - 158;
    neck = 'C ${_f(500 + g.nh + 95)} ${_f(g.ntop - 10)} ${_f(500 + g.nh + 92)} ${_f(top)} 500 ${_f(top)} '
        'C ${_f(500 - g.nh - 92)} ${_f(top)} ${_f(500 - g.nh - 95)} ${_f(g.ntop - 10)} ${_lp(g.nh, g.ntop)}';
  } else if (g.vneck && side == 'front') {
    neck = 'L 500 ${_f(g.ntop + dip)} L ${_lp(g.nh, g.ntop)}';
  } else {
    neck = 'C ${_f(500 + g.nh * 0.85)} ${_f(g.ntop + dip)} ${_f(500 - g.nh * 0.85)} ${_f(g.ntop + dip)} ${_lp(g.nh, g.ntop)}';
  }
  return 'M ${_lp(g.nh, g.ntop)} L ${_lp(g.sx, g.sy)} L ${_lp(g.ox, g.oy)} L ${_lp(g.ex, g.ey)} L ${_lp(g.bh, g.ay)} L ${_lp(g.bh, g.hy)} '
      'L ${_rp(g.bh, g.hy)} L ${_rp(g.bh, g.ay)} L ${_rp(g.ex, g.ey)} L ${_rp(g.ox, g.oy)} L ${_rp(g.sx, g.sy)} L ${_rp(g.nh, g.ntop)} $neck Z';
}

/// Detail strings: plain = thin seam line, '~' prefix = soft shaded shape, '=' prefix = thick line (straps, drawstrings).
List<String> _garmentDetails(String fam, _G g, String side) {
  final d = <String>[];
  final long = g.oy > 600;
  d.add('M ${_lp(g.sx, g.sy)} Q ${_lp(g.bh + 16, (g.sy + g.ay) / 2)} ${_lp(g.bh, g.ay)}');
  d.add('M ${_rp(g.sx, g.sy)} Q ${_rp(g.bh + 16, (g.sy + g.ay) / 2)} ${_rp(g.bh, g.ay)}');
  final cl = long ? 0.1 : 0.14;
  final c1x = _lerp(g.ox, g.sx, cl), c1y = _lerp(g.oy, g.sy, cl);
  final c2x = _lerp(g.ex, g.bh, cl), c2y = _lerp(g.ey, g.ay, cl);
  d.add('M ${_lp(c1x, c1y)} L ${_lp(c2x, c2y)}');
  d.add('M ${_rp(c1x, c1y)} L ${_rp(c2x, c2y)}');
  d.add('M ${_lp(g.bh, g.hy - 36)} L ${_rp(g.bh, g.hy - 36)}');
  final dip = side == 'front' ? g.dipF : g.dipB;
  if (g.hood) {
    if (side == 'front') {
      d.add('~M ${_lp(g.nh - 4, g.ntop + 6)} C ${_f(500 - g.nh)} ${_f(g.ntop + 112)} ${_f(500 + g.nh)} ${_f(g.ntop + 112)} ${_rp(g.nh - 4, g.ntop + 6)} '
          'C ${_f(500 + g.nh * 0.6)} ${_f(g.ntop - 78)} ${_f(500 - g.nh * 0.6)} ${_f(g.ntop - 78)} ${_lp(g.nh - 4, g.ntop + 6)} Z');
      d.add('M ${_lp(g.nh + 22, g.ntop - 4)} C ${_f(500 - g.nh * 0.5)} ${_f(g.ntop + 150)} ${_f(500 + g.nh * 0.5)} ${_f(g.ntop + 150)} ${_rp(g.nh + 22, g.ntop - 4)}');
      d.add('=M 438 ${_f(g.ntop + 100)} L 432 ${_f(g.ntop + 235)}');
      d.add('=M 562 ${_f(g.ntop + 100)} L 568 ${_f(g.ntop + 235)}');
      d.add('M 336 ${_f(g.hy - 285)} L 664 ${_f(g.hy - 285)} L 706 ${_f(g.hy - 128)} L 294 ${_f(g.hy - 128)} Z');
      d.add('M 372 ${_f(g.hy - 285)} L 340 ${_f(g.hy - 128)}');
      d.add('M 628 ${_f(g.hy - 285)} L 660 ${_f(g.hy - 128)}');
    } else {
      d.add('M 500 ${_f(g.ntop - 158)} C 470 ${_f(g.ntop - 60)} 468 ${_f(g.ntop + 20)} 480 ${_f(g.ntop + 60)}');
      d.add('M 500 ${_f(g.ntop - 158)} C 530 ${_f(g.ntop - 60)} 532 ${_f(g.ntop + 20)} 520 ${_f(g.ntop + 60)}');
      d.add('M ${_lp(g.nh + 18, g.ntop + 4)} C ${_f(500 - g.nh * 0.5)} ${_f(g.ntop + 52)} ${_f(500 + g.nh * 0.5)} ${_f(g.ntop + 52)} ${_rp(g.nh + 18, g.ntop + 4)}');
    }
  } else if (side == 'back') {
    d.add('M ${_lp(g.nh + 10, g.ntop + 8)} C ${_f(500 - g.nh * 0.5)} ${_f(g.ntop + dip + 24)} ${_f(500 + g.nh * 0.5)} ${_f(g.ntop + dip + 24)} ${_rp(g.nh + 10, g.ntop + 8)}');
  } else if (fam == 'vneck') {
    d.add('M ${_lp(g.nh + 14, g.ntop + 10)} L 500 ${_f(g.ntop + dip + 30)} L ${_rp(g.nh + 14, g.ntop + 10)}');
  } else if (fam == 'polo') {
    d.add('~M ${_lp(g.nh + 4, g.ntop - 2)} L ${_lp(g.nh + 48, g.ntop + 74)} L 488 ${_f(g.ntop + 150)} L 500 ${_f(g.ntop + 52)} Z');
    d.add('~M ${_rp(g.nh + 4, g.ntop - 2)} L ${_rp(g.nh + 48, g.ntop + 74)} L 512 ${_f(g.ntop + 150)} L 500 ${_f(g.ntop + 52)} Z');
    d.add('M 500 ${_f(g.ntop + 52)} L 500 ${_f(g.ntop + 300)}');
    d.add('M 534 ${_f(g.ntop + 56)} L 534 ${_f(g.ntop + 300)}');
    d.add('M 466 ${_f(g.ntop + 56)} L 466 ${_f(g.ntop + 300)}');
    for (final y in <double>[g.ntop + 110, g.ntop + 190, g.ntop + 270]) {
      d.add('M 508 ${_f(y)} a 8 8 0 1 0 -16 0 a 8 8 0 1 0 16 0');
    }
  } else if (fam == 'jacket') {
    d.add('~M ${_lp(g.nh + 8, g.ntop - 6)} L ${_lp(g.nh + 40, g.ntop + 70)} L 490 ${_f(g.ntop + 90)} L 490 ${_f(g.ntop + 8)} Z');
    d.add('~M ${_rp(g.nh + 8, g.ntop - 6)} L ${_rp(g.nh + 40, g.ntop + 70)} L 510 ${_f(g.ntop + 90)} L 510 ${_f(g.ntop + 8)} Z');
    d.add('=M 500 ${_f(g.ntop + 8)} L 500 ${_f(g.hy)}');
    d.add('M 330 ${_f(g.hy - 300)} L 440 ${_f(g.hy - 262)}');
    d.add('M 670 ${_f(g.hy - 300)} L 560 ${_f(g.hy - 262)}');
    d.add('M 330 ${_f(g.hy - 300)} L 318 ${_f(g.hy - 170)}');
    d.add('M 670 ${_f(g.hy - 300)} L 682 ${_f(g.hy - 170)}');
  } else {
    d.add('M ${_lp(g.nh + 12, g.ntop + 6)} C ${_f(500 - g.nh * 0.8)} ${_f(g.ntop + dip + 34)} ${_f(500 + g.nh * 0.8)} ${_f(g.ntop + dip + 34)} ${_rp(g.nh + 12, g.ntop + 6)}');
  }
  if (fam == 'sweatshirt') d.add('M ${_lp(g.bh, g.hy - 70)} L ${_rp(g.bh, g.hy - 70)}');
  return d;
}

// ---------------------------------------------------------------------------------------------- other products

String _rr(double x, double y, double w, double h, double r) =>
    'M ${_f(x + r)} ${_f(y)} L ${_f(x + w - r)} ${_f(y)} Q ${_f(x + w)} ${_f(y)} ${_f(x + w)} ${_f(y + r)} L ${_f(x + w)} ${_f(y + h - r)} '
    'Q ${_f(x + w)} ${_f(y + h)} ${_f(x + w - r)} ${_f(y + h)} L ${_f(x + r)} ${_f(y + h)} Q ${_f(x)} ${_f(y + h)} ${_f(x)} ${_f(y + h - r)} '
    'L ${_f(x)} ${_f(y + r)} Q ${_f(x)} ${_f(y)} ${_f(x + r)} ${_f(y)} Z';

String _circ(double cx, double cy, double r) =>
    'M ${_f(cx + r)} ${_f(cy)} a ${_f(r)} ${_f(r)} 0 1 0 ${_f(-2 * r)} 0 a ${_f(r)} ${_f(r)} 0 1 0 ${_f(2 * r)} 0';

Rect _box(double x, double y, double w, double h) => Rect.fromLTWH(x, y, w, h);

const Map<String, List<List<double>>> _garmentArea = <String, List<List<double>>>{
  // [front x y w h], [back x y w h]
  'tee': [[0.31, 0.25, 0.38, 0.5], [0.3, 0.2, 0.4, 0.56]],
  'tee_long': [[0.31, 0.25, 0.38, 0.5], [0.3, 0.2, 0.4, 0.56]],
  'vneck': [[0.31, 0.3, 0.38, 0.44], [0.3, 0.2, 0.4, 0.56]],
  'polo': [[0.33, 0.4, 0.34, 0.34], [0.3, 0.2, 0.4, 0.56]],
  'crop_top': [[0.31, 0.25, 0.38, 0.34], [0.3, 0.2, 0.4, 0.4]],
  'hoodie': [[0.31, 0.37, 0.38, 0.32], [0.3, 0.28, 0.4, 0.52]],
  'crop_hoodie': [[0.31, 0.37, 0.38, 0.26], [0.3, 0.28, 0.4, 0.36]],
  'sweatshirt': [[0.31, 0.3, 0.38, 0.46], [0.3, 0.22, 0.4, 0.56]],
  'jacket': [[0.54, 0.36, 0.14, 0.14], [0.3, 0.22, 0.4, 0.56]],
};

(String, List<String>, Rect) _buildRaw(String family, String side) {
  final g = _garments[family];
  if (g != null) {
    final a = (_garmentArea[family] ?? _garmentArea['tee']!)[side == 'front' ? 0 : 1];
    return (_garmentPath(g, side), _garmentDetails(family, g, side), _box(a[0], a[1], a[2], a[3]));
  }
  final front = side == 'front';
  switch (family) {
    case 'joggers':
      return (
        'M 285 100 L 715 100 L 758 380 L 706 905 L 548 905 L 500 430 L 452 905 L 294 905 L 242 380 Z',
        <String>[
          'M 270 168 L 730 168', '=M 470 168 L 462 250', '=M 530 168 L 538 250', 'M 500 430 L 500 168', 'M 706 840 L 548 840',
          'M 294 840 L 452 840', 'M 300 250 C 330 300 330 360 300 400', 'M 700 250 C 670 300 670 360 700 400',
        ],
        front ? _box(0.54, 0.3, 0.2, 0.3) : _box(0.3, 0.24, 0.4, 0.3)
      );
    case 'shorts':
      return (
        'M 262 190 L 738 190 L 800 700 L 548 722 L 500 450 L 452 722 L 200 700 Z',
        <String>['M 255 260 L 745 260', '=M 470 260 L 462 340', '=M 530 260 L 538 340', 'M 500 450 L 500 260', 'M 810 640 L 548 664', 'M 190 640 L 452 664'],
        front ? _box(0.56, 0.32, 0.18, 0.26) : _box(0.3, 0.3, 0.4, 0.26)
      );
    case 'tote':
      const handle = 'M 330 335 C 322 90 678 90 670 335 L 640 335 C 646 160 354 160 360 335 Z';
      return ('${_rr(185, 335, 630, 570, 24)} $handle', <String>['M 190 400 L 810 400', handle], _box(0.3, 0.46, 0.4, 0.4));
    case 'mug':
      return (
        'M 215 235 L 715 235 L 705 815 Q 703 862 656 862 L 274 862 Q 227 862 225 815 Z M 712 320 C 960 300 970 770 700 770 L 702 696 C 850 700 840 392 714 392 Z',
        <String>['M 215 235 Q 465 292 715 235', 'M 225 815 Q 465 880 705 815', 'M 255 300 L 262 780'],
        _box(0.24, 0.34, 0.46, 0.44)
      );
    case 'bottle':
      return (
        'M 425 52 L 575 52 Q 590 52 590 68 L 590 150 L 598 192 C 660 232 702 272 702 345 L 702 905 Q 702 950 656 950 L 344 950 Q 298 950 298 905 L 298 345 C 298 272 340 232 402 192 L 410 150 L 410 68 Q 410 52 425 52 Z',
        <String>['M 410 150 L 590 150', 'M 410 108 L 590 108', 'M 402 192 L 598 192', 'M 330 360 L 332 900', 'M 298 330 Q 500 380 702 330'],
        _box(0.35, 0.42, 0.3, 0.38)
      );
    case 'phone_case':
      return (
        _rr(290, 50, 420, 900, 96),
        <String>[_rr(310, 70, 380, 860, 80), '~${_rr(335, 95, 140, 150, 34)}', _circ(380, 140, 26), _circ(430, 200, 26), _circ(445, 128, 14)],
        _box(0.31, 0.29, 0.38, 0.62)
      );
    case 'poster':
      return (
        _rr(160, 70, 680, 860, 12),
        <String>[_rr(200, 110, 600, 780, 4), _rr(262, 172, 476, 656, 2), '~M 262 172 L 738 172 L 738 828 L 262 828 Z'],
        _box(0.28, 0.19, 0.44, 0.62)
      );
    case 'notebook':
      return (
        _rr(230, 70, 590, 860, 30),
        <String>[
          _rr(260, 100, 530, 800, 18), 'M 300 70 L 300 930',
          for (final y in <double>[160, 240, 320, 400, 480, 560, 640, 720, 800, 880]) _circ(262, y, 14),
        ],
        _box(0.33, 0.18, 0.44, 0.64)
      );
    case 'popsocket':
      return (
        _circ(500, 500, 330),
        <String>[_circ(500, 500, 296), '~${_circ(500, 500, 110)}', _circ(500, 500, 70), 'M 300 330 Q 340 270 420 240'],
        _box(0.28, 0.28, 0.44, 0.44)
      );
    case 'mousepad':
      return (_rr(110, 240, 780, 520, 70), <String>[_rr(130, 260, 740, 480, 56), 'M 180 300 Q 330 280 460 300'], _box(0.15, 0.31, 0.7, 0.38));
    case 'mask':
      return (
        'M 235 335 C 400 280 600 280 765 335 L 738 645 C 600 718 400 718 262 645 Z',
        <String>[
          'M 235 335 C 130 350 110 520 205 600', 'M 765 335 C 870 350 890 520 795 600', 'M 250 420 Q 500 460 750 420',
          'M 256 500 Q 500 540 744 500', 'M 262 580 Q 500 620 738 580',
        ],
        _box(0.3, 0.42, 0.4, 0.2)
      );
    case 'cap':
      return (
        'M 200 575 C 185 320 330 195 500 195 C 670 195 815 320 800 575 C 650 540 350 540 200 575 Z M 130 585 C 130 560 870 560 870 585 C 870 705 130 705 130 585 Z',
        <String>[
          _circ(500, 205, 22), 'M 500 195 L 500 565', 'M 350 240 C 330 330 330 450 340 555', 'M 650 240 C 670 330 670 450 660 555',
          'M 135 600 C 400 640 600 640 865 600',
        ],
        _box(0.36, 0.3, 0.28, 0.22)
      );
    default:
      return (_rr(150, 150, 700, 700, 70), <String>[_rr(176, 176, 648, 648, 52)], _box(0.22, 0.22, 0.56, 0.56));
  }
}

final Map<String, Silhouette> _cache = <String, Silhouette>{};

/// Path, line details and print-area box (fractions of the 1000 x 1000 stage) for a family and side.
Silhouette silhouette(String family, [String side = 'front']) {
  final fam = kProductFamilies.contains(family) ? family : 'other';
  final sd = side == 'back' ? 'back' : 'front';
  return _cache.putIfAbsent('$fam:$sd', () {
    final raw = _buildRaw(fam, sd);
    final details = <SilDetail>[
      for (final s in raw.$2)
        if (s.startsWith('~'))
          SilDetail(parseSvgPath(s.substring(1)), SilDetailKind.shade)
        else if (s.startsWith('='))
          SilDetail(parseSvgPath(s.substring(1)), SilDetailKind.thick)
        else
          SilDetail(parseSvgPath(s), SilDetailKind.line),
    ];
    return Silhouette(parseSvgPath(raw.$1), details, raw.$3);
  });
}

/// The print area on the 1000 x 1000 stage with the real inch aspect ratio fitted inside the family's box (centred). [ppi] = stage px per inch.
class StageGeom {
  const StageGeom(this.rect, this.ppi);
  final Rect rect;
  final double ppi;
}

StageGeom printAreaPx(String family, String side, double areaWIn, double areaHIn) {
  final b = silhouette(family, side).area;
  final bw = b.width * 1000, bh = b.height * 1000;
  final aw = areaWIn < 0.1 ? 0.1 : areaWIn;
  final ah = areaHIn < 0.1 ? 0.1 : areaHIn;
  final ppi = (bw / aw) < (bh / ah) ? bw / aw : bh / ah;
  final w = aw * ppi, h = ah * ppi;
  return StageGeom(Rect.fromLTWH(b.left * 1000 + (bw - w) / 2, b.top * 1000 + (bh - h) / 2, w, h), ppi);
}

/// Draws the product on [canvas] into a [size] box (the drawing is made on a 1000 x 1000 box and scaled).
void paintSilhouette(Canvas canvas, Size size, Silhouette s, Color fill) {
  final dark = fill.computeLuminance() < 0.28;
  final line = dark ? const Color(0x3DFFFFFF) : const Color(0x38000000);
  final shade = dark ? const Color(0x61000000) : const Color(0x1A000000);
  final out = dark ? const Color(0x8C000000) : const Color(0x57000000);
  canvas.save();
  canvas.scale(size.width / 1000, size.height / 1000);
  canvas.drawPath(s.path, Paint()..color = fill..isAntiAlias = true);
  canvas.drawPath(
    s.path,
    Paint()
      ..shader = ui.Gradient.linear(
        Offset.zero,
        const Offset(1000, 1000),
        const <Color>[Color(0x33FFFFFF), Color(0x00FFFFFF), Color(0x24000000)],
        const <double>[0, 0.55, 1],
      ),
  );
  for (final d in s.details) {
    switch (d.kind) {
      case SilDetailKind.shade:
        canvas.drawPath(d.path, Paint()..color = shade);
        canvas.drawPath(
            d.path, Paint()..color = line..style = PaintingStyle.stroke..strokeWidth = 3..strokeJoin = StrokeJoin.round);
      case SilDetailKind.thick:
        canvas.drawPath(
            d.path, Paint()..color = line..style = PaintingStyle.stroke..strokeWidth = 11..strokeCap = StrokeCap.round);
      case SilDetailKind.line:
        canvas.drawPath(
            d.path,
            Paint()
              ..color = line
              ..style = PaintingStyle.stroke
              ..strokeWidth = 4
              ..strokeCap = StrokeCap.round
              ..strokeJoin = StrokeJoin.round);
    }
  }
  canvas.drawPath(s.path, Paint()..color = out..style = PaintingStyle.stroke..strokeWidth = 5..strokeJoin = StrokeJoin.round);
  canvas.restore();
}

/// A clean product drawing (front or back) filled with [colour]. [size] = width and height.
class ProductSilhouette extends StatelessWidget {
  const ProductSilhouette({super.key, required this.family, required this.colour, required this.size, this.side = 'front'});

  final String family;
  final Color colour;
  final double size;
  final String side;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: size,
      height: size,
      child: CustomPaint(painter: _SilhouettePainter(family, side, colour)),
    );
  }
}

class _SilhouettePainter extends CustomPainter {
  _SilhouettePainter(this.family, this.side, this.colour);

  final String family;
  final String side;
  final Color colour;

  @override
  void paint(Canvas canvas, Size size) => paintSilhouette(canvas, size, silhouette(family, side), colour);

  @override
  bool shouldRepaint(_SilhouettePainter old) => old.family != family || old.side != side || old.colour != colour;
}
