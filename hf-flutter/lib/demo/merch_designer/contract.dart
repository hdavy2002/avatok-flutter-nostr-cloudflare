import 'dart:typed_data';

import '../../data/models/merch.dart';

/// [HF-MERCH-STUDIO-2] Shared contract between the wizard (`screens/merch_wizard.dart`) and the design studio
/// (`merch_designer/designer.dart`). Spec: Specs/SPEC-2026-10-23-HF-MERCH-STUDIO-2.md. Same model as the web studio
/// (web/src/islands/dashboard-hf/merch/studio/types.ts). Inches are measured on the product's print area, top-left origin.

/// A picture in the influencer's tray: an upload, an AI result, a cut-out, or a text-only composite.
class StudioArt {
  const StudioArt({required this.art, required this.source, this.bytes, this.label});

  final ArtUpload art;

  /// 'upload' | 'ai' | 'bg_removed' | 'composite'
  final String source;

  /// Original bytes when the phone has them (uploads, cut-outs). Otherwise the designer downloads [ArtUpload.url].
  final Uint8List? bytes;
  final String? label;

  String get artId => art.artId;
}

/// One layer. [x]/[y] are the CENTRE in inches on the print area; [w]/[h] its size in inches before rotation.
sealed class DesignLayer {
  DesignLayer({
    required this.id,
    required this.name,
    this.visible = true,
    this.locked = false,
    required this.x,
    required this.y,
    this.rotation = 0,
    this.opacity = 1,
    this.flipX = false,
    this.flipY = false,
  });

  final String id;
  String name;
  bool visible;
  bool locked;
  double x;
  double y;

  /// Degrees, clockwise.
  double rotation;
  double opacity;
  bool flipX;
  bool flipY;

  DesignLayer copy();
}

class ImageDesignLayer extends DesignLayer {
  ImageDesignLayer({
    required super.id,
    required super.name,
    super.visible,
    super.locked,
    required super.x,
    required super.y,
    super.rotation,
    super.opacity,
    super.flipX,
    super.flipY,
    required this.artId,
    required this.url,
    required this.pxW,
    required this.pxH,
    required this.w,
    required this.h,
  });

  String artId;
  String url;
  int pxW;
  int pxH;
  double w;
  double h;

  /// Dots per inch this picture prints at.
  double get dpi => w <= 0 ? 0 : pxW / w;

  @override
  ImageDesignLayer copy() => ImageDesignLayer(
      id: id, name: name, visible: visible, locked: locked, x: x, y: y, rotation: rotation, opacity: opacity, flipX: flipX, flipY: flipY,
      artId: artId, url: url, pxW: pxW, pxH: pxH, w: w, h: h);
}

class TextDesignLayer extends DesignLayer {
  TextDesignLayer({
    required super.id,
    required super.name,
    super.visible,
    super.locked,
    required super.x,
    required super.y,
    super.rotation,
    super.opacity,
    super.flipX,
    super.flipY,
    required this.text,
    required this.font,
    required this.sizeIn,
    this.fill = '#1E1B4B',
    this.align = 'center',
    this.letterSpacing = 0,
    this.lineHeight = 1.15,
    this.stroke,
    this.strokeIn = 0,
    this.shadow = false,
  });

  String text;

  /// Font family name from the merch font registry (designer/fonts.dart).
  String font;

  /// Font size in inches (cap height scale: the size of one line).
  double sizeIn;

  /// `#rrggbb`
  String fill;

  /// 'left' | 'center' | 'right'
  String align;

  /// In em (0 = normal).
  double letterSpacing;

  /// Multiplier.
  double lineHeight;
  String? stroke;
  double strokeIn;
  bool shadow;

  @override
  TextDesignLayer copy() => TextDesignLayer(
      id: id, name: name, visible: visible, locked: locked, x: x, y: y, rotation: rotation, opacity: opacity, flipX: flipX, flipY: flipY,
      text: text, font: font, sizeIn: sizeIn, fill: fill, align: align, letterSpacing: letterSpacing, lineHeight: lineHeight,
      stroke: stroke, strokeIn: strokeIn, shadow: shadow);
}

/// What the designer hands back after "Looks good": the print file is uploaded and the mockups are made.
class DesignResult {
  const DesignResult({
    required this.artId,
    required this.printFileId,
    required this.wIn,
    required this.hIn,
    required this.leftIn,
    required this.topIn,
    required this.dpi,
    required this.mockupUrls,
    required this.previewPng,
    required this.layers,
  });

  final String artId;
  final String printFileId;
  final double wIn;
  final double hIn;
  final double leftIn;
  final double topIn;
  final int dpi;
  final List<String> mockupUrls;
  final Uint8List previewPng;
  final List<DesignLayer> layers;
}
