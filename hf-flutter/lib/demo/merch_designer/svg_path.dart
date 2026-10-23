import 'dart:ui';

/// [HF-MERCH-STUDIO-2] Small SVG path-data parser: M L H V C S Q T A Z, absolute and relative, into a `dart:ui` [Path].
/// The product silhouettes are written as SVG path strings on a 1000 x 1000 box (same strings as the web studio).
/// Unknown or broken data stops the parse and returns what was built so far (never throws).
Path parseSvgPath(String d) {
  final r = _Reader(d);
  final path = Path();
  var cx = 0.0, cy = 0.0; // current point
  var sx = 0.0, sy = 0.0; // start of the sub path
  var lcx = 0.0, lcy = 0.0; // last control point (for S and T)
  var lastCubic = false, lastQuad = false;
  var cmd = '';
  var guard = 0;
  while (guard++ < 100000) {
    r.skipSeparators();
    if (r.done) break;
    final ch = r.peek;
    if (_isCommand(ch)) {
      cmd = ch;
      r.pos++;
      if (cmd == 'Z' || cmd == 'z') {
        path.close();
        cx = sx;
        cy = sy;
        lastCubic = false;
        lastQuad = false;
        continue;
      }
    } else if (cmd.isEmpty || cmd == 'Z' || cmd == 'z') {
      break;
    }
    final rel = cmd.toLowerCase() == cmd;
    switch (cmd.toLowerCase()) {
      case 'm': {
        final x = r.number(), y = r.number();
        if (x == null || y == null) return path;
        cx = rel ? cx + x : x;
        cy = rel ? cy + y : y;
        path.moveTo(cx, cy);
        sx = cx;
        sy = cy;
        cmd = rel ? 'l' : 'L'; // more pairs after a move are line-tos
        lastCubic = false;
        lastQuad = false;
      }
      case 'l': {
        final x = r.number(), y = r.number();
        if (x == null || y == null) return path;
        cx = rel ? cx + x : x;
        cy = rel ? cy + y : y;
        path.lineTo(cx, cy);
        lastCubic = false;
        lastQuad = false;
      }
      case 'h': {
        final x = r.number();
        if (x == null) return path;
        cx = rel ? cx + x : x;
        path.lineTo(cx, cy);
        lastCubic = false;
        lastQuad = false;
      }
      case 'v': {
        final y = r.number();
        if (y == null) return path;
        cy = rel ? cy + y : y;
        path.lineTo(cx, cy);
        lastCubic = false;
        lastQuad = false;
      }
      case 'c': {
        final v = r.numbers(6);
        if (v == null) return path;
        final x1 = rel ? cx + v[0] : v[0], y1 = rel ? cy + v[1] : v[1];
        final x2 = rel ? cx + v[2] : v[2], y2 = rel ? cy + v[3] : v[3];
        final x = rel ? cx + v[4] : v[4], y = rel ? cy + v[5] : v[5];
        path.cubicTo(x1, y1, x2, y2, x, y);
        lcx = x2;
        lcy = y2;
        cx = x;
        cy = y;
        lastCubic = true;
        lastQuad = false;
      }
      case 's': {
        final v = r.numbers(4);
        if (v == null) return path;
        final x1 = lastCubic ? 2 * cx - lcx : cx, y1 = lastCubic ? 2 * cy - lcy : cy;
        final x2 = rel ? cx + v[0] : v[0], y2 = rel ? cy + v[1] : v[1];
        final x = rel ? cx + v[2] : v[2], y = rel ? cy + v[3] : v[3];
        path.cubicTo(x1, y1, x2, y2, x, y);
        lcx = x2;
        lcy = y2;
        cx = x;
        cy = y;
        lastCubic = true;
        lastQuad = false;
      }
      case 'q': {
        final v = r.numbers(4);
        if (v == null) return path;
        final x1 = rel ? cx + v[0] : v[0], y1 = rel ? cy + v[1] : v[1];
        final x = rel ? cx + v[2] : v[2], y = rel ? cy + v[3] : v[3];
        path.quadraticBezierTo(x1, y1, x, y);
        lcx = x1;
        lcy = y1;
        cx = x;
        cy = y;
        lastQuad = true;
        lastCubic = false;
      }
      case 't': {
        final v = r.numbers(2);
        if (v == null) return path;
        final x1 = lastQuad ? 2 * cx - lcx : cx, y1 = lastQuad ? 2 * cy - lcy : cy;
        final x = rel ? cx + v[0] : v[0], y = rel ? cy + v[1] : v[1];
        path.quadraticBezierTo(x1, y1, x, y);
        lcx = x1;
        lcy = y1;
        cx = x;
        cy = y;
        lastQuad = true;
        lastCubic = false;
      }
      case 'a': {
        final rx = r.number(), ry = r.number(), rot = r.number();
        final large = r.flag(), sweep = r.flag();
        final x = r.number(), y = r.number();
        if (rx == null || ry == null || rot == null || large == null || sweep == null || x == null || y == null) return path;
        final ex = rel ? cx + x : x, ey = rel ? cy + y : y;
        if (ex != cx || ey != cy) {
          if (rx == 0 || ry == 0) {
            path.lineTo(ex, ey);
          } else {
            path.arcToPoint(Offset(ex, ey),
                radius: Radius.elliptical(rx.abs(), ry.abs()), rotation: rot, largeArc: large, clockwise: sweep);
          }
        }
        cx = ex;
        cy = ey;
        lastCubic = false;
        lastQuad = false;
      }
      default:
        return path;
    }
  }
  return path;
}

bool _isCommand(String c) => 'MmLlHhVvCcSsQqTtAaZz'.contains(c);

class _Reader {
  _Reader(this.s);
  final String s;
  int pos = 0;

  bool get done => pos >= s.length;
  String get peek => s[pos];

  void skipSeparators() {
    while (pos < s.length) {
      final c = s.codeUnitAt(pos);
      if (c == 0x20 || c == 0x2C || c == 0x0A || c == 0x0D || c == 0x09) {
        pos++;
      } else {
        break;
      }
    }
  }

  static bool _digit(int c) => c >= 0x30 && c <= 0x39;

  double? number() {
    skipSeparators();
    final start = pos;
    if (pos < s.length && (s[pos] == '-' || s[pos] == '+')) pos++;
    var digits = 0;
    while (pos < s.length && _digit(s.codeUnitAt(pos))) {
      pos++;
      digits++;
    }
    if (pos < s.length && s[pos] == '.') {
      pos++;
      while (pos < s.length && _digit(s.codeUnitAt(pos))) {
        pos++;
        digits++;
      }
    }
    if (digits == 0) {
      pos = start;
      return null;
    }
    if (pos < s.length && (s[pos] == 'e' || s[pos] == 'E')) {
      final save = pos;
      pos++;
      if (pos < s.length && (s[pos] == '-' || s[pos] == '+')) pos++;
      var ed = 0;
      while (pos < s.length && _digit(s.codeUnitAt(pos))) {
        pos++;
        ed++;
      }
      if (ed == 0) pos = save;
    }
    return double.tryParse(s.substring(start, pos));
  }

  List<double>? numbers(int n) {
    final out = <double>[];
    for (var i = 0; i < n; i++) {
      final v = number();
      if (v == null) return null;
      out.add(v);
    }
    return out;
  }

  /// An arc flag: a single 0 or 1 (may be glued to the next number).
  bool? flag() {
    skipSeparators();
    if (pos >= s.length) return null;
    final c = s[pos];
    if (c == '0' || c == '1') {
      pos++;
      return c == '1';
    }
    return null;
  }
}
