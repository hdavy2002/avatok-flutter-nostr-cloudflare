import 'dart:async';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';

/// [HF-MERCH-STUDIO-2] "Erase plain colour": removes a flat background on the phone. Flood-fills from the picture's edges through
/// pixels close to the corner colour (so the same colour inside the artwork stays), then softens the cut edge a little.
/// No server, no AI, free. Port of the web studio's erase.ts. The pixel work runs in a background isolate.

const int kEraseMaxSide = 3000;

/// Top-level so [compute] can run it. Arguments: [straight RGBA bytes, width, height, tolerance 1..100, feather 0..6].
/// Returns PREMULTIPLIED RGBA bytes (what `decodeImageFromPixels` wants).
Uint8List eraseRgbaPixels(List<Object> args) {
  final src = args[0] as Uint8List;
  final w = args[1] as int;
  final h = args[2] as int;
  final tolerance = args[3] as int;
  final feather = args[4] as int;
  final d = Uint8List.fromList(src);

  // the background colour: the most common of the four corner patches
  final patch = math.max(1, math.min(6, math.min(w, h) ~/ 20));
  final corners = <List<double>>[];
  for (final c in <List<int>>[
    [0, 0], [w - patch, 0], [0, h - patch], [w - patch, h - patch],
  ]) {
    var sr = 0.0, sg = 0.0, sb = 0.0, n = 0;
    for (var y = c[1]; y < c[1] + patch; y++) {
      for (var x = c[0]; x < c[0] + patch; x++) {
        final i = (y * w + x) * 4;
        if (d[i + 3] < 16) continue;
        sr += d[i];
        sg += d[i + 1];
        sb += d[i + 2];
        n++;
      }
    }
    if (n > 0) corners.add(<double>[sr / n, sg / n, sb / n]);
  }
  var br = 255.0, bg = 255.0, bb = 255.0;
  if (corners.isNotEmpty) {
    var best = corners.first;
    var bestVotes = -1;
    for (final c in corners) {
      var votes = 0;
      for (final o in corners) {
        final dist = math.sqrt(math.pow(o[0] - c[0], 2) + math.pow(o[1] - c[1], 2) + math.pow(o[2] - c[2], 2));
        if (dist < 40) votes++;
      }
      if (votes > bestVotes) {
        best = c;
        bestVotes = votes;
      }
    }
    br = best[0];
    bg = best[1];
    bb = best[2];
  }

  final thr = math.max(1, tolerance) * 2.4;
  bool bgLike(int p) {
    final i = p * 4;
    if (d[i + 3] < 16) return true;
    final dr = d[i] - br, dg = d[i + 1] - bg, db = d[i + 2] - bb;
    return math.sqrt(dr * dr + dg * dg + db * db) <= thr;
  }

  final total = w * h;
  final mask = Uint8List(total); // 1 = background
  final stack = Int32List(total);
  var sp = 0;
  void seed(int p) {
    if (mask[p] == 0 && bgLike(p)) {
      mask[p] = 1;
      stack[sp++] = p;
    }
  }

  for (var x = 0; x < w; x++) {
    seed(x);
    seed((h - 1) * w + x);
  }
  for (var y = 0; y < h; y++) {
    seed(y * w);
    seed(y * w + w - 1);
  }
  while (sp > 0) {
    final p = stack[--sp];
    final x = p % w;
    final y = p ~/ w;
    if (x > 0) seed(p - 1);
    if (x < w - 1) seed(p + 1);
    if (y > 0) seed(p - w);
    if (y < h - 1) seed(p + w);
  }

  // soft edge: blur the mask a little, art alpha = 1 - blurred mask
  var soft = Float32List(total);
  for (var p = 0; p < total; p++) {
    soft[p] = mask[p].toDouble();
  }
  final r = feather;
  if (r > 0) {
    final tmp = Float32List(total);
    final span = 2 * r + 1;
    for (var y = 0; y < h; y++) {
      var acc = 0.0;
      for (var x = -r; x <= r; x++) {
        acc += soft[y * w + math.min(w - 1, math.max(0, x))];
      }
      for (var x = 0; x < w; x++) {
        tmp[y * w + x] = acc / span;
        acc += soft[y * w + math.min(w - 1, x + r + 1)] - soft[y * w + math.max(0, x - r)];
      }
    }
    final out = Float32List(total);
    for (var x = 0; x < w; x++) {
      var acc = 0.0;
      for (var y = -r; y <= r; y++) {
        acc += tmp[math.min(h - 1, math.max(0, y)) * w + x];
      }
      for (var y = 0; y < h; y++) {
        out[y * w + x] = acc / span;
        acc += tmp[math.min(h - 1, y + r + 1) * w + x] - tmp[math.max(0, y - r) * w + x];
      }
    }
    soft = out;
  }

  for (var p = 0; p < total; p++) {
    final i = p * 4;
    var a = d[i + 3];
    if (mask[p] == 1) {
      a = 0;
    } else if (soft[p] > 0) {
      final keep = 1 - math.min(1.0, soft[p] * 1.15);
      a = (a * keep).round();
    }
    d[i + 3] = a;
    if (a < 255) {
      d[i] = (d[i] * a + 127) ~/ 255;
      d[i + 1] = (d[i + 1] * a + 127) ~/ 255;
      d[i + 2] = (d[i + 2] * a + 127) ~/ 255;
    }
  }
  return d;
}

/// Erases the flat background of [src]. [tolerance] 1..100 (how different a pixel may be and still count as background).
/// Returns a NEW image (the caller disposes it); [src] is left alone.
Future<ui.Image> eraseFlatColour(ui.Image src, {required int tolerance, int feather = 2}) async {
  final bd = await src.toByteData(format: ui.ImageByteFormat.rawStraightRgba);
  if (bd == null) throw StateError('erase_read_failed');
  final bytes = Uint8List.fromList(bd.buffer.asUint8List(bd.offsetInBytes, bd.lengthInBytes));
  final out = await compute<List<Object>, Uint8List>(
    eraseRgbaPixels,
    <Object>[bytes, src.width, src.height, math.max(1, math.min(100, tolerance)), math.max(0, math.min(6, feather))],
  );
  final done = Completer<ui.Image>();
  ui.decodeImageFromPixels(out, src.width, src.height, ui.PixelFormat.rgba8888, done.complete);
  return done.future;
}
