// overlay_painters.dart — CustomPainters that draw the on-device vision overlay
// on top of the native camera texture.
//
// One painter per `overlay_style` (master §6):
//   skeleton          — MoveNet 17 / MediaPipe 33 joints + bones
//   hand_mesh         — 21-pt hand connections
//   face_mesh         — face landmark dots (light)
//   bounding_box      — object / face_detect boxes + labels
//   segmentation_mask — person/object mask tint
//   none              — nothing
//
// Colors come from the `zine` accent palette (master rule 9): flat fills, hard
// ink strokes, NO gradients, NO blurred shadows. Landmarks arrive already
// normalized (0..1) and front-camera-mirrored by the native layer, so painters
// map straight through the paint `size`.
import 'package:flutter/material.dart';

import '../../../core/ui/zine.dart';
import 'pose_channel.dart';

/// Factory: the right painter for an overlay style. Returns null for `none`.
CustomPainter? overlayPainterFor(String overlayStyle, VisionFrame frame) {
  switch (overlayStyle) {
    case 'skeleton':
      return _SkeletonPainter(frame);
    case 'hand_mesh':
      return _HandMeshPainter(frame);
    case 'face_mesh':
      return _FaceMeshPainter(frame);
    case 'bounding_box':
      return _BoxPainter(frame);
    case 'segmentation_mask':
      return _MaskPainter(frame);
    case 'none':
    default:
      return null;
  }
}

// MoveNet 17 bone pairs (also a valid subset for MediaPipe-33 since we reuse the
// same conceptual joints; the skeleton painter just connects whatever exists).
const List<List<int>> _moveNetBones = [
  [0, 1], [0, 2], [1, 3], [2, 4],            // head
  [5, 6], [5, 7], [7, 9], [6, 8], [8, 10],   // arms + shoulders
  [5, 11], [6, 12], [11, 12],                // torso
  [11, 13], [13, 15], [12, 14], [14, 16],    // legs
];

// MediaPipe Pose 33 — the extra bones beyond the shared 17 conceptual joints.
const List<List<int>> _mpPoseBones = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [24, 26], [26, 28],
  [27, 31], [28, 32], [15, 17], [16, 18],
];

// MediaPipe Hand 21 connections.
const List<List<int>> _handBones = [
  [0, 1], [1, 2], [2, 3], [3, 4],        // thumb
  [0, 5], [5, 6], [6, 7], [7, 8],        // index
  [5, 9], [9, 10], [10, 11], [11, 12],   // middle
  [9, 13], [13, 14], [14, 15], [15, 16], // ring
  [13, 17], [17, 18], [18, 19], [19, 20],// pinky
  [0, 17],                               // palm base
];

abstract class _BasePainter extends CustomPainter {
  final VisionFrame f;
  const _BasePainter(this.f);

  Offset _pt(VisionPoint p, Size s) => Offset(p.x * s.width, p.y * s.height);

  // Hard-ink halo under accent strokes — keeps lines legible over any video.
  Paint get _halo => Paint()
    ..color = Zine.ink
    ..style = PaintingStyle.stroke
    ..strokeCap = StrokeCap.round;

  @override
  bool shouldRepaint(covariant _BasePainter old) => true; // 30 fps live stream
}

class _SkeletonPainter extends _BasePainter {
  const _SkeletonPainter(super.f);
  @override
  void paint(Canvas canvas, Size size) {
    if (f.points.isEmpty) return;
    final bones = (f.points.first.length > 17) ? _mpPoseBones : _moveNetBones;
    final accent = Paint()
      ..color = Zine.lime
      ..style = PaintingStyle.stroke
      ..strokeWidth = 4
      ..strokeCap = StrokeCap.round;
    final dot = Paint()..color = Zine.lilac..style = PaintingStyle.fill;
    for (final inst in f.points) {
      for (final b in bones) {
        if (b[0] >= inst.length || b[1] >= inst.length) continue;
        final a = inst[b[0]], c = inst[b[1]];
        if (a.score < .3 || c.score < .3) continue;
        final p1 = _pt(a, size), p2 = _pt(c, size);
        canvas.drawLine(p1, p2, _halo..strokeWidth = 7);
        canvas.drawLine(p1, p2, accent);
      }
      for (final k in inst) {
        if (k.score < .3) continue;
        final o = _pt(k, size);
        canvas.drawCircle(o, 5.5, _halo..strokeWidth = 3..style = PaintingStyle.stroke);
        canvas.drawCircle(o, 4, dot);
      }
    }
  }
}

class _HandMeshPainter extends _BasePainter {
  const _HandMeshPainter(super.f);
  @override
  void paint(Canvas canvas, Size size) {
    final accent = Paint()
      ..color = Zine.lilac
      ..style = PaintingStyle.stroke
      ..strokeWidth = 3
      ..strokeCap = StrokeCap.round;
    final dot = Paint()..color = Zine.lime..style = PaintingStyle.fill;
    for (final inst in f.points) {
      if (inst.length < 21) continue;
      for (final b in _handBones) {
        final p1 = _pt(inst[b[0]], size), p2 = _pt(inst[b[1]], size);
        canvas.drawLine(p1, p2, _halo..strokeWidth = 5);
        canvas.drawLine(p1, p2, accent);
      }
      for (final k in inst) {
        canvas.drawCircle(_pt(k, size), 3.5, dot);
      }
    }
  }
}

class _FaceMeshPainter extends _BasePainter {
  const _FaceMeshPainter(super.f);
  @override
  void paint(Canvas canvas, Size size) {
    // Face mesh is dense (468 pts) — draw light dots only, no full tessellation,
    // to stay smooth and unobtrusive. SAFETY: dots only, never identity overlay.
    final dot = Paint()..color = Zine.lilac.withValues(alpha: .85)..style = PaintingStyle.fill;
    for (final inst in f.points) {
      for (final k in inst) {
        if (k.score < .2) continue;
        canvas.drawCircle(_pt(k, size), 1.3, dot);
      }
    }
  }
}

class _BoxPainter extends _BasePainter {
  const _BoxPainter(super.f);
  @override
  void paint(Canvas canvas, Size size) {
    final stroke = Paint()
      ..color = Zine.lime
      ..style = PaintingStyle.stroke
      ..strokeWidth = 3.5;
    for (final b in f.boxes) {
      final rect = Rect.fromLTWH(b.x * size.width, b.y * size.height,
          b.w * size.width, b.h * size.height);
      canvas.drawRect(rect.inflate(1), _halo..strokeWidth = 6..style = PaintingStyle.stroke);
      canvas.drawRect(rect, stroke);
      final label = b.label;
      if (label != null && label.isNotEmpty) {
        final tp = TextPainter(
          text: TextSpan(
            text: ' ${label.toUpperCase()} ',
            style: const TextStyle(
                color: Zine.ink, fontSize: 11, fontWeight: FontWeight.w800, letterSpacing: .5),
          ),
          textDirection: TextDirection.ltr,
        )..layout();
        final lblRect = Rect.fromLTWH(rect.left, rect.top - tp.height - 2, tp.width, tp.height);
        canvas.drawRect(lblRect, Paint()..color = Zine.lime);
        canvas.drawRect(lblRect, _halo..strokeWidth = 2..style = PaintingStyle.stroke);
        tp.paint(canvas, lblRect.topLeft);
      }
    }
  }
}

class _MaskPainter extends _BasePainter {
  const _MaskPainter(super.f);
  @override
  void paint(Canvas canvas, Size size) {
    final mask = f.mask;
    if (mask == null || f.maskW == 0 || f.maskH == 0) return;
    // Upsample the low-res alpha grid into a flat lilac tint over the subject.
    final cellW = size.width / f.maskW, cellH = size.height / f.maskH;
    final tint = Paint()..color = Zine.lilac.withValues(alpha: .35)..style = PaintingStyle.fill;
    for (int y = 0; y < f.maskH; y++) {
      for (int x = 0; x < f.maskW; x++) {
        final a = mask[y * f.maskW + x];
        if (a < 128) continue;
        canvas.drawRect(Rect.fromLTWH(x * cellW, y * cellH, cellW + .5, cellH + .5), tint);
      }
    }
  }
}
