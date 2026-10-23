import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../theme.dart';
import 'contract.dart';
import 'fonts.dart';
import 'images.dart';
import 'layer_paint.dart';
import 'silhouettes.dart';

/// [HF-MERCH-STUDIO-2] The studio stage: the product in its colour, the dashed print area, the layers clipped to it (faint ghost
/// outside), and the touch handling: tap to select, drag to move, pinch to scale, two-finger turn (snaps near 0/90/180/270), corner
/// handles to scale and a round handle to turn. The layers are changed in place; the owner is told through [onChanged] while a
/// gesture runs and through [onCommit] when it ends (that is where undo history is recorded).

enum _Drag { none, move, corner, rotate }

double _cl(double v, double lo, double hi) => math.max(lo, math.min(hi, v));

class _View {
  _View(this.k, this.origin, this.geom);

  /// Screen px per stage unit.
  final double k;
  final Offset origin;
  final StageGeom geom;

  double get pxPerIn => k * geom.ppi;

  Offset toScreen(Offset world) => Offset(world.dx * k + origin.dx, world.dy * k + origin.dy);

  Offset centreOf(DesignLayer l) => toScreen(Offset(geom.rect.left + l.x * geom.ppi, geom.rect.top + l.y * geom.ppi));
}

/// Half sizes (screen px) of a layer's selection box.
Size _halfBox(_View v, DesignLayer l, {double pad = 0}) {
  final s = layerSizeIn(l);
  final p = layerPadIn(l);
  return Size(math.max(18.0, (s.width / 2 + p) * v.pxPerIn) + pad, math.max(18.0, (s.height / 2 + p) * v.pxPerIn) + pad);
}

Offset _rotPoint(Offset c, double deg, double x, double y) {
  final a = deg * kRadPerDeg;
  final ca = math.cos(a), sa = math.sin(a);
  return Offset(c.dx + x * ca - y * sa, c.dy + x * sa + y * ca);
}

class StudioStage extends StatefulWidget {
  const StudioStage({
    super.key,
    required this.family,
    required this.side,
    required this.colour,
    required this.areaW,
    required this.areaH,
    required this.layers,
    required this.selectedId,
    required this.store,
    required this.zoomToArea,
    required this.bottomInset,
    required this.onSelect,
    required this.onChanged,
    required this.onCommit,
  });

  final String family;
  final String side;
  final Color colour;
  final double areaW;
  final double areaH;
  final List<DesignLayer> layers;
  final String? selectedId;
  final ImageStore store;

  /// Zoom in on the print area.
  final bool zoomToArea;

  /// Height at the bottom that a tool panel covers (the product is centred in what is left).
  final double bottomInset;
  final ValueChanged<String?> onSelect;
  final VoidCallback onChanged;
  final VoidCallback onCommit;

  @override
  State<StudioStage> createState() => _StudioStageState();
}

class _StudioStageState extends State<StudioStage> {
  _View? _view;
  Offset? _downAt;
  _Drag _drag = _Drag.none;
  DesignLayer? _active;
  Offset _startFocal = Offset.zero;
  double _startX = 0, _startY = 0, _startW = 0, _startH = 0, _startSize = 0, _startRot = 0, _refScale = 1, _refRot = 0, _startDist = 1;
  int _count = 1;
  bool _changed = false;
  bool _guideV = false, _guideH = false;

  DesignLayer? get _selected {
    for (final l in widget.layers) {
      if (l.id == widget.selectedId) return l;
    }
    return null;
  }

  _View _computeView(Size size) {
    final geom = printAreaPx(widget.family, widget.side, widget.areaW, widget.areaH);
    final usableH = math.max(80.0, size.height - widget.bottomInset);
    final base = math.min(size.width, usableH) / 1060;
    final z = widget.zoomToArea ? _cl(1000 / (math.max(geom.rect.width, geom.rect.height) * 1.18), 1.0, 4.0) : 1.0;
    final k = base * z;
    final c = widget.zoomToArea ? geom.rect.center : const Offset(500, 500);
    return _View(k, Offset(size.width / 2 - c.dx * k, usableH / 2 - c.dy * k), geom);
  }

  // ---------------------------------------------------------------------------------------------- hit tests

  DesignLayer? _hitLayer(_View v, Offset p) {
    for (var i = widget.layers.length - 1; i >= 0; i--) {
      final l = widget.layers[i];
      if (!l.visible || l.locked || l.opacity <= 0.01) continue;
      final c = v.centreOf(l);
      final h = _halfBox(v, l);
      final a = -l.rotation * kRadPerDeg;
      final dx = p.dx - c.dx, dy = p.dy - c.dy;
      final lx = dx * math.cos(a) - dy * math.sin(a);
      final ly = dx * math.sin(a) + dy * math.cos(a);
      if (lx.abs() <= h.width && ly.abs() <= h.height) return l;
    }
    return null;
  }

  Offset _rotHandle(_View v, DesignLayer l) {
    final h = _halfBox(v, l, pad: 4);
    return _rotPoint(v.centreOf(l), l.rotation, 0, -(h.height + 38));
  }

  List<Offset> _corners(_View v, DesignLayer l) {
    final h = _halfBox(v, l, pad: 4);
    final c = v.centreOf(l);
    return <Offset>[
      _rotPoint(c, l.rotation, -h.width, -h.height),
      _rotPoint(c, l.rotation, h.width, -h.height),
      _rotPoint(c, l.rotation, h.width, h.height),
      _rotPoint(c, l.rotation, -h.width, h.height),
    ];
  }

  // ---------------------------------------------------------------------------------------------- gestures

  void _tap(Offset p) {
    final v = _view;
    if (v == null) return;
    final hit = _hitLayer(v, p);
    if (hit?.id != widget.selectedId) widget.onSelect(hit?.id);
  }

  void _rebase(DesignLayer l, Offset focal, int count, double scale, double rotation) {
    _startFocal = focal;
    _startX = l.x;
    _startY = l.y;
    _startRot = l.rotation;
    _startW = l is ImageDesignLayer ? l.w : 0;
    _startH = l is ImageDesignLayer ? l.h : 0;
    _startSize = l is TextDesignLayer ? l.sizeIn : 0;
    _refScale = scale <= 0 ? 1 : scale;
    _refRot = rotation;
    _count = count;
  }

  void _start(ScaleStartDetails d) {
    final v = _view;
    if (v == null) return;
    _changed = false;
    _drag = _Drag.none;
    _active = null;
    final sel = _selected;
    final p = _downAt ?? d.localFocalPoint;
    if (d.pointerCount == 1) {
      if (sel != null && sel.visible && !sel.locked) {
        if ((p - _rotHandle(v, sel)).distance <= 32) {
          _drag = _Drag.rotate;
          _active = sel;
          _rebase(sel, d.localFocalPoint, 1, 1, 0);
          return;
        }
        for (final c in _corners(v, sel)) {
          if ((p - c).distance <= 32) {
            _drag = _Drag.corner;
            _active = sel;
            _startDist = math.max(12.0, (p - v.centreOf(sel)).distance);
            _rebase(sel, d.localFocalPoint, 1, 1, 0);
            return;
          }
        }
      }
      final hit = _hitLayer(v, p);
      if (hit != null) {
        if (hit.id != widget.selectedId) widget.onSelect(hit.id);
        _active = hit;
        _drag = _Drag.move;
        _rebase(hit, d.localFocalPoint, 1, 1, 0);
      } else if (sel != null) {
        widget.onSelect(null);
      }
    } else {
      final t = sel ?? _hitLayer(v, p);
      if (t != null && t.visible && !t.locked) {
        if (t.id != widget.selectedId) widget.onSelect(t.id);
        _active = t;
        _drag = _Drag.move;
        _rebase(t, d.localFocalPoint, d.pointerCount, 1, 0);
      }
    }
  }

  void _scaleTo(DesignLayer l, double s) {
    if (l is ImageDesignLayer) {
      final w = _cl(_startW * s, 0.15, math.max(widget.areaW, widget.areaH) * 6);
      l.w = w;
      l.h = _startW <= 0 ? l.h : _startH * (w / _startW);
    } else if (l is TextDesignLayer) {
      l.sizeIn = _cl(_startSize * s, 0.12, 40);
    }
  }

  double _snapAngle(double deg) {
    final n = ((deg % 360) + 360) % 360;
    for (final t in const <double>[0, 90, 180, 270, 360]) {
      if ((n - t).abs() <= 6) return t == 360 ? 0 : t;
    }
    return (n * 10).roundToDouble() / 10;
  }

  void _update(ScaleUpdateDetails d) {
    final v = _view;
    final l = _active;
    if (v == null || l == null || l.locked || _drag == _Drag.none) return;
    if (d.pointerCount != _count) {
      _rebase(l, d.localFocalPoint, d.pointerCount, d.scale, d.rotation);
      return;
    }
    switch (_drag) {
      case _Drag.rotate:
        {
          final c = v.centreOf(l);
          final p = d.localFocalPoint;
          l.rotation = _snapAngle(math.atan2(p.dy - c.dy, p.dx - c.dx) / kRadPerDeg + 90);
        }
      case _Drag.corner:
        {
          final c = v.centreOf(l);
          _scaleTo(l, math.max(0.05, (d.localFocalPoint - c).distance / _startDist));
        }
      case _Drag.move:
        final ppi = v.pxPerIn;
        var x = _startX + (d.localFocalPoint.dx - _startFocal.dx) / ppi;
        var y = _startY + (d.localFocalPoint.dy - _startFocal.dy) / ppi;
        final thr = 9 / ppi;
        _guideV = (x - widget.areaW / 2).abs() < thr;
        _guideH = (y - widget.areaH / 2).abs() < thr;
        if (_guideV) x = widget.areaW / 2;
        if (_guideH) y = widget.areaH / 2;
        l.x = x;
        l.y = y;
        if (d.pointerCount >= 2) {
          _scaleTo(l, d.scale / _refScale);
          l.rotation = _snapAngle(_startRot + (d.rotation - _refRot) / kRadPerDeg);
        }
      case _Drag.none:
        return;
    }
    _changed = true;
    widget.onChanged();
  }

  void _end(ScaleEndDetails d) {
    final wasChanged = _changed;
    _drag = _Drag.none;
    _active = null;
    _guideV = false;
    _guideH = false;
    _changed = false;
    if (wasChanged) {
      widget.onCommit();
    } else {
      setState(() {});
    }
  }

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(builder: (context, c) {
      final size = Size(c.maxWidth, c.maxHeight);
      final view = _computeView(size);
      _view = view;
      return Listener(
        onPointerDown: (e) => _downAt = e.localPosition,
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTapUp: (d) => _tap(d.localPosition),
          onScaleStart: _start,
          onScaleUpdate: _update,
          onScaleEnd: _end,
          child: CustomPaint(
            size: size,
            painter: _StagePainter(
              view: view,
              family: widget.family,
              side: widget.side,
              colour: widget.colour,
              layers: widget.layers,
              selected: _selected,
              store: widget.store,
              guideV: _guideV,
              guideH: _guideH,
              areaW: widget.areaW,
              areaH: widget.areaH,
              corners: _selected == null || !_selected!.visible ? null : _corners(view, _selected!),
              rotHandle: _selected == null || !_selected!.visible ? null : _rotHandle(view, _selected!),
            ),
          ),
        ),
      );
    });
  }
}

class _StagePainter extends CustomPainter {
  _StagePainter({
    required this.view,
    required this.family,
    required this.side,
    required this.colour,
    required this.layers,
    required this.selected,
    required this.store,
    required this.guideV,
    required this.guideH,
    required this.areaW,
    required this.areaH,
    required this.corners,
    required this.rotHandle,
  }) : super(repaint: Listenable.merge(<Listenable>[store.changes, MerchFonts.changes]));

  final _View view;
  final String family;
  final String side;
  final Color colour;
  final List<DesignLayer> layers;
  final DesignLayer? selected;
  final ImageStore store;
  final bool guideV;
  final bool guideH;
  final double areaW;
  final double areaH;
  final List<Offset>? corners;
  final Offset? rotHandle;

  void _drawLayers(Canvas canvas, Rect area) {
    for (final l in layers) {
      paintLayer(canvas, l, ppi: view.geom.ppi, origin: area.topLeft, image: l is ImageDesignLayer ? store.imageFor(l) : null);
    }
  }

  void _dashed(Canvas canvas, Offset a, Offset b, Paint paint, double dash, double gap) {
    final total = (b - a).distance;
    if (total <= 0) return;
    final dir = (b - a) / total;
    var t = 0.0;
    while (t < total) {
      final e = math.min(total, t + dash);
      canvas.drawLine(a + dir * t, a + dir * e, paint);
      t = e + gap;
    }
  }

  @override
  void paint(Canvas canvas, Size size) {
    final v = view;
    final area = v.geom.rect;
    canvas.save();
    canvas.translate(v.origin.dx, v.origin.dy);
    canvas.scale(v.k);
    paintSilhouette(canvas, const Size(1000, 1000), silhouette(family, side), colour);

    // faint ghost of whatever sticks out of the print area
    final vis = Rect.fromLTWH(-v.origin.dx / v.k, -v.origin.dy / v.k, size.width / v.k, size.height / v.k);
    final outside = Path.combine(PathOperation.difference, Path()..addRect(vis.inflate(20)), Path()..addRect(area));
    canvas.save();
    canvas.clipPath(outside);
    canvas.saveLayer(vis.inflate(20), Paint()..color = const Color.fromRGBO(255, 255, 255, 0.22));
    _drawLayers(canvas, area);
    canvas.restore();
    canvas.restore();

    // the print itself, clipped to the print area
    canvas.save();
    canvas.clipRect(area);
    _drawLayers(canvas, area);
    canvas.restore();

    // dashed print area
    final lineColour = colour.computeLuminance() > 0.55 ? const Color(0xFFC2185B) : const Color(0xFFFCD34D);
    final dp = Paint()
      ..color = lineColour
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2.5 / v.k
      ..strokeCap = StrokeCap.round;
    final dash = 11 / v.k, gap = 8 / v.k;
    _dashed(canvas, area.topLeft, area.topRight, dp, dash, gap);
    _dashed(canvas, area.topRight, area.bottomRight, dp, dash, gap);
    _dashed(canvas, area.bottomRight, area.bottomLeft, dp, dash, gap);
    _dashed(canvas, area.bottomLeft, area.topLeft, dp, dash, gap);

    // centre guides while a layer snaps to the middle
    final gp = Paint()
      ..color = C.rani
      ..strokeWidth = 1.5 / v.k;
    if (guideV) _dashed(canvas, Offset(area.center.dx, area.top - 14 / v.k), Offset(area.center.dx, area.bottom + 14 / v.k), gp, 5 / v.k, 5 / v.k);
    if (guideH) _dashed(canvas, Offset(area.left - 14 / v.k, area.center.dy), Offset(area.right + 14 / v.k, area.center.dy), gp, 5 / v.k, 5 / v.k);
    canvas.restore();

    // selection box and handles, drawn in screen pixels
    final sel = selected;
    final cs = corners;
    final rh = rotHandle;
    if (sel != null && sel.visible && cs != null && rh != null) {
      final box = Path()..addPolygon(cs, true);
      if (sel.locked) {
        final p = Paint()
          ..color = C.muted
          ..style = PaintingStyle.stroke
          ..strokeWidth = 1.5;
        for (var i = 0; i < 4; i++) {
          _dashed(canvas, cs[i], cs[(i + 1) % 4], p, 5, 4);
        }
        return;
      }
      canvas.drawPath(
          box,
          Paint()
            ..color = C.rani
            ..style = PaintingStyle.stroke
            ..strokeWidth = 2
            ..strokeJoin = StrokeJoin.round);
      final topMid = Offset((cs[0].dx + cs[1].dx) / 2, (cs[0].dy + cs[1].dy) / 2);
      canvas.drawLine(topMid, rh, Paint()..color = C.rani..strokeWidth = 2);
      final fill = Paint()..color = C.white;
      final ring = Paint()
        ..color = C.rani
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2.5;
      for (final c in cs) {
        canvas.drawCircle(c, 11, fill);
        canvas.drawCircle(c, 11, ring);
      }
      canvas.drawCircle(rh, 13, Paint()..color = C.rani);
      canvas.drawArc(
        Rect.fromCircle(center: rh, radius: 6),
        -math.pi * 0.2,
        math.pi * 1.5,
        false,
        Paint()
          ..color = C.white
          ..style = PaintingStyle.stroke
          ..strokeWidth = 2
          ..strokeCap = StrokeCap.round,
      );
    }
  }

  @override
  bool shouldRepaint(_StagePainter old) => true;
}
