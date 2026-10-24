import 'dart:math' as math;

import 'package:flutter/foundation.dart';

import '../../data/models/merch.dart';
import '../../data/repos/merch_repo.dart';
import '../merch_kit.dart';
import 'contract.dart';
import 'images.dart';
import 'render.dart';
import 'silhouettes.dart';

/// [HF-MERCH-STUDIO-2] "Looks good": draws the print file, uploads it (and, for a text-only design, the picture it stands on),
/// makes up to four product pictures and uploads them. Throws [StudioExportException] (a sentence safe to show) or the repo's
/// ApiException; the caller turns both into plain words. [say] reports the stage the work is in.
Future<DesignResult> finishDesign({
  required MerchRepo repo,
  required String family,
  required String side,
  required List<MerchColour> colours,
  required double areaW,
  required double areaH,
  required List<DesignLayer> layers,
  required ImageStore store,
  required ValueChanged<StudioArt> onArtAdded,
  required void Function(String) say,
}) async {
  final out = await renderPrint(layers: layers, areaW: areaW, areaH: areaH, store: store);
  try {
    var artId = '';
    for (final l in layers) {
      if (l is ImageDesignLayer && l.visible && l.opacity > 0.01) {
        artId = l.artId;
        break;
      }
    }
    if (artId.isEmpty) {
      say('Saving your design.');
      final up = await repo.uploadArt(out.png, contentType: 'image/png', fileName: 'text-design.png');
      artId = up.artId;
      onArtAdded(StudioArt(art: up, source: 'composite', bytes: out.png, label: 'Text design'));
    }
    say('Saving the print file.');
    final printFileId = await repo.uploadPrintFile(artId, out.png);
    final cols = colours.take(4).toList();
    final urls = <String>[];
    for (var i = 0; i < cols.length; i++) {
      say('Making product pictures ${i + 1} of ${cols.length}.');
      try {
        final png = await renderMockupPng(
          family: family, side: side, colour: colourFromHex(cols[i].hex), areaW: areaW, areaH: areaH, print: out.small,
          leftIn: out.leftIn, topIn: out.topIn, wIn: out.wIn, hIn: out.hIn, size: 900,
        );
        urls.add(await repo.uploadMockup(png));
      } catch (e, st) {
        merchCapture(e, st, 'studio_mockup');
      }
    }
    if (urls.isEmpty && cols.isNotEmpty) {
      throw const StudioExportException('Could not make the product pictures. Check your internet and try again.');
    }
    double r2(double v) => (v * 100).round() / 100;
    final left = r2(out.leftIn), top = r2(out.topIn);
    return DesignResult(
      // [HF-MERCH-ART-REUSE-1] Art already on a product is copied by the server; the product must use the copy (the print file id).
      artId: printFileId,
      printFileId: printFileId,
      wIn: math.min(r2(out.wIn), r2(areaW - left)),
      hIn: math.min(r2(out.hIn), r2(areaH - top)),
      leftIn: left,
      topIn: top,
      dpi: out.dpi,
      mockupUrls: urls,
      previewPng: out.previewPng,
      layers: layers,
    );
  } finally {
    out.dispose();
  }
}
