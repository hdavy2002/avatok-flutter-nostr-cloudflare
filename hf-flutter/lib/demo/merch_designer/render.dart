import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'contract.dart';
import 'fonts.dart';
import 'images.dart';
import 'layer_paint.dart';
import 'silhouettes.dart';

/// [HF-MERCH-STUDIO-2] Print export and mockups (spec section 2). [renderPrint] draws every visible layer at 300 DPI (long side capped
/// at 5000 px, so the real DPI may be lower and is reported) into ONE transparent PNG = the union box of the layers clipped to the
/// print area. It uses the same [paintLayer] as the stage. [renderMockupPng] draws the product with the print on it.

const double kExportDpi = 300;
const int kExportMaxPx = 5000;

/// [HF-MERCH-AI-HIRES-1] The server and Printrove take print files up to 15 MB. A PNG over [kPrintTargetBytes] is drawn again a little
/// smaller, never under [kExportMinDpi] ("Good"). Same rule as the web studio (exportPrint.ts).
const int kPrintLimitBytes = 15 * 1024 * 1024;
const int kPrintTargetBytes = 14 * 1024 * 1024;
const double kExportMinDpi = 200;

/// A failure with a sentence that is safe to show.
class StudioExportException implements Exception {
  const StudioExportException(this.message);
  final String message;
  @override
  String toString() => message;
}

class ExportOutput {
  ExportOutput({
    required this.png,
    required this.previewPng,
    required this.small,
    required this.widthPx,
    required this.heightPx,
    required this.wIn,
    required this.hIn,
    required this.leftIn,
    required this.topIn,
    required this.dpi,
    required this.scaledDown,
  });

  /// The print file (transparent PNG at full size).
  final Uint8List png;

  /// A small PNG of the same picture (long side up to 1200 px).
  final Uint8List previewPng;

  /// The same print at up to 1400 px, used to draw mockups. Call [dispose] when done.
  final ui.Image small;
  final int widthPx;
  final int heightPx;
  final double wIn;
  final double hIn;
  final double leftIn;
  final double topIn;

  /// Real DPI of the file (pixels / inches).
  final int dpi;
  final bool scaledDown;

  void dispose() => small.dispose();
}

/// A copy of [src] whose long side is at most [maxSide] (never enlarged).
Future<ui.Image> scaledCopy(ui.Image src, int maxSide) async {
  final k = math.min(1.0, maxSide / math.max(src.width, src.height));
  final w = math.max(1, (src.width * k).round()), h = math.max(1, (src.height * k).round());
  final rec = ui.PictureRecorder();
  final c = ui.Canvas(rec, ui.Rect.fromLTWH(0, 0, w.toDouble(), h.toDouble()));
  c.drawImageRect(
    src,
    ui.Rect.fromLTWH(0, 0, src.width.toDouble(), src.height.toDouble()),
    ui.Rect.fromLTWH(0, 0, w.toDouble(), h.toDouble()),
    ui.Paint()
      ..isAntiAlias = true
      ..filterQuality = ui.FilterQuality.medium,
  );
  final pic = rec.endRecording();
  try {
    return await pic.toImage(w, h);
  } finally {
    pic.dispose();
  }
}

/// Renders the design. [layers] are bottom to top.
Future<ExportOutput> renderPrint({
  required List<DesignLayer> layers,
  required double areaW,
  required double areaH,
  required ImageStore store,
}) async {
  final textFonts = <String>[
    for (final l in layers)
      if (l is TextDesignLayer && l.visible) l.font,
  ];
  final failedFonts = await MerchFonts.loadAll(textFonts);
  if (failedFonts.isNotEmpty) {
    throw StudioExportException('Could not load the font ${failedFonts.first}. Check your internet and try again.');
  }
  final bounds = designBounds(layers, areaW, areaH);
  if (bounds == null) throw const StudioExportException('Put your picture or text inside the dashed box first.');

  var ppi = kExportDpi;
  var widthPx = (bounds.width * ppi).round();
  var heightPx = (bounds.height * ppi).round();
  final longest = math.max(widthPx, heightPx);
  var scaledDown = false;
  if (longest > kExportMaxPx) {
    ppi = kExportDpi * kExportMaxPx / longest;
    widthPx = (bounds.width * ppi).round();
    heightPx = (bounds.height * ppi).round();
    scaledDown = true;
  }
  widthPx = math.max(1, widthPx);
  heightPx = math.max(1, heightPx);

  final decoded = <String, ui.Image>{};
  ui.Image? full;
  try {
    for (final l in layers) {
      if (l is! ImageDesignLayer || !l.visible || l.opacity <= 0.01) continue;
      final Uint8List bytes;
      try {
        bytes = await store.bytesFor(l.artId, l.url);
        final want = math.max(64, (math.max(l.w, l.h) * ppi).ceil());
        decoded[l.id] = await decodePicture(bytes, maxSide: math.min(kExportMaxPx, want));
      } catch (_) {
        throw const StudioExportException('Could not read the picture - please add it again.');
      }
    }
    var png = Uint8List(0);
    late ui.Image printImage;
    for (var attempt = 0;; attempt++) {
      full?.dispose();
      full = null;
      final rec = ui.PictureRecorder();
      final canvas = ui.Canvas(rec, ui.Rect.fromLTWH(0, 0, widthPx.toDouble(), heightPx.toDouble()));
      canvas.clipRect(ui.Rect.fromLTWH(0, 0, widthPx.toDouble(), heightPx.toDouble()));
      final origin = ui.Offset(-bounds.left * ppi, -bounds.top * ppi);
      for (final l in layers) {
        if (!l.visible || l.opacity <= 0.01) continue;
        paintLayer(canvas, l, ppi: ppi, origin: origin, image: l is ImageDesignLayer ? decoded[l.id] : null);
      }
      final pic = rec.endRecording();
      final drawn = await pic.toImage(widthPx, heightPx).whenComplete(pic.dispose);
      full = drawn;
      printImage = drawn;
      png = await encodePng(drawn);
      // [HF-MERCH-AI-HIRES-1] Too big for the 15 MB limit: draw it again a little smaller (at most 3 times, never under 200 DPI).
      if (png.length <= kPrintTargetBytes || ppi <= kExportMinDpi || attempt >= 3) break;
      ppi = math.max(kExportMinDpi, ppi * math.sqrt(kPrintTargetBytes / png.length) * 0.92);
      widthPx = math.max(1, (bounds.width * ppi).round());
      heightPx = math.max(1, (bounds.height * ppi).round());
      scaledDown = true;
    }
    if (png.length > kPrintLimitBytes) {
      throw const StudioExportException('Your design makes a print file that is too big. Make the picture a little smaller on the product and try again.');
    }
    final small = await scaledCopy(printImage, 1400);
    Uint8List preview;
    if (math.max(small.width, small.height) <= 1200) {
      preview = await encodePng(small);
    } else {
      final p2 = await scaledCopy(small, 1200);
      try {
        preview = await encodePng(p2);
      } finally {
        p2.dispose();
      }
    }
    return ExportOutput(
      png: png,
      previewPng: preview,
      small: small,
      widthPx: widthPx,
      heightPx: heightPx,
      wIn: bounds.width,
      hIn: bounds.height,
      leftIn: bounds.left,
      topIn: bounds.top,
      dpi: (widthPx / bounds.width).round(),
      scaledDown: scaledDown,
    );
  } finally {
    for (final i in decoded.values) {
      i.dispose();
    }
    full?.dispose();
  }
}

/// One product picture: the silhouette in [colour] with the print placed on the print area. [size] px square (900 by default).
Future<Uint8List> renderMockupPng({
  required String family,
  required String side,
  required ui.Color colour,
  required double areaW,
  required double areaH,
  required ui.Image print,
  required double leftIn,
  required double topIn,
  required double wIn,
  required double hIn,
  int size = 900,
}) async {
  final s = size.toDouble();
  final rec = ui.PictureRecorder();
  final canvas = ui.Canvas(rec, ui.Rect.fromLTWH(0, 0, s, s));
  canvas.drawRect(ui.Rect.fromLTWH(0, 0, s, s), ui.Paint()..color = const ui.Color(0xFFEFE3CF));
  paintSilhouette(canvas, ui.Size(s, s), silhouette(family, side), colour);
  final g = printAreaPx(family, side, areaW, areaH);
  final k = s / 1000;
  final dst = ui.Rect.fromLTWH((g.rect.left + leftIn * g.ppi) * k, (g.rect.top + topIn * g.ppi) * k, wIn * g.ppi * k, hIn * g.ppi * k);
  canvas.drawImageRect(
    print,
    ui.Rect.fromLTWH(0, 0, print.width.toDouble(), print.height.toDouble()),
    dst,
    ui.Paint()
      ..isAntiAlias = true
      ..filterQuality = ui.FilterQuality.high,
  );
  final pic = rec.endRecording();
  ui.Image? img;
  try {
    img = await pic.toImage(size, size);
    return await encodePng(img);
  } finally {
    pic.dispose();
    img?.dispose();
  }
}
