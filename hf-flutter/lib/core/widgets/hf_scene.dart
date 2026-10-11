import 'dart:math' as math;
import 'package:flutter/material.dart';
import '../theme/hf_tokens.dart';

enum HfSceneKind { discover, welcome, wallet, profile, call, women, lgbtq, host, verify, success }

/// Small, bespoke native illustrations. No asset download and no startup work.
/// Animation is opt-in and stops when accessibility requests reduced motion.
class HfScene extends StatefulWidget {
  const HfScene({super.key, required this.kind, this.height = 140, this.animated = false});
  final HfSceneKind kind;
  final double height;
  final bool animated;
  @override
  State<HfScene> createState() => _HfSceneState();
}

class _HfSceneState extends State<HfScene> with SingleTickerProviderStateMixin {
  late final AnimationController _motion = AnimationController(
    vsync: this, duration: const Duration(milliseconds: 2200));
  @override
  void didChangeDependencies() { super.didChangeDependencies(); _sync(); }
  @override
  void didUpdateWidget(HfScene oldWidget) { super.didUpdateWidget(oldWidget); _sync(); }
  void _sync() {
    if (widget.animated && !MediaQuery.disableAnimationsOf(context)) {
      if (!_motion.isAnimating) _motion.repeat(reverse: true);
    } else { _motion.stop(); _motion.value = 0; }
  }
  @override
  void dispose() { _motion.dispose(); super.dispose(); }
  @override
  Widget build(BuildContext context) => ExcludeSemantics(
    child: RepaintBoundary(
      child: SizedBox(height: widget.height, width: double.infinity,
        child: AnimatedBuilder(animation: _motion, builder: (_, __) =>
          CustomPaint(painter: _ScenePainter(widget.kind, _motion.value)))),
    ),
  );
}

class _ScenePainter extends CustomPainter {
  const _ScenePainter(this.kind, this.motion);
  final HfSceneKind kind;
  final double motion;
  static const _skin = Color(0xFFF4B393);
  void _rect(Canvas c, Rect r, Color color, [double radius = 18]) =>
    c.drawRRect(RRect.fromRectAndRadius(r, Radius.circular(radius)), Paint()..color = color);
  void _dot(Canvas c, Offset p, double radius, Color color) =>
    c.drawCircle(p, radius, Paint()..color = color);
  void _line(Canvas c, Offset a, Offset b, Color color, [double width = 4]) =>
    c.drawLine(a, b, Paint()..color = color..strokeWidth = width..strokeCap = StrokeCap.round);

  void _person(Canvas c, double x, double y, Color shirt, {bool longHair = false, double scale = 1}) {
    c.save(); c.translate(x, y); c.scale(scale);
    // Rounded sweater, neck, asymmetric hair silhouette and a calm face.
    _rect(c, const Rect.fromLTWH(-34, 10, 68, 72), shirt, 27);
    if (longHair) _rect(c, const Rect.fromLTWH(-27, -43, 54, 78), HfColors.ink, 23);
    _rect(c, const Rect.fromLTWH(-8, -4, 16, 24), _skin, 6);
    _rect(c, const Rect.fromLTWH(-22, -38, 44, 48), _skin, 20);
    _dot(c, const Offset(-4, -39), 23, HfColors.ink);
    _dot(c, const Offset(15, -40), 12, HfColors.ink);
    _rect(c, const Rect.fromLTWH(-16, -29, 35, 31), _skin, 12);
    _dot(c, const Offset(-8, -18), 1.6, HfColors.ink);
    _dot(c, const Offset(9, -18), 1.6, HfColors.ink);
    c.drawArc(const Rect.fromLTWH(-5, -17, 12, 14), 0.25, 2.1, false,
      Paint()..color=HfColors.ink..style=PaintingStyle.stroke..strokeWidth=2..strokeCap=StrokeCap.round);
    _line(c, const Offset(-20, 35), const Offset(15, 50), _skin, 12);
    _rect(c, const Rect.fromLTWH(8, 27, 20, 25), HfColors.ink, 5);
    c.drawArc(const Rect.fromLTWH(20, 31, 16, 17), -1.5, 3.2, false,
      Paint()..color=HfColors.ink..style=PaintingStyle.stroke..strokeWidth=4);
    c.restore();
  }

  void _plant(Canvas c, double x, double y) {
    _line(c, Offset(x,y), Offset(x+4,y-58), HfColors.forest, 3);
    for (var i=0; i<3; i++) {
      final yy=y-14-i*15;
      c.drawOval(Rect.fromCenter(center: Offset(x-7,yy), width: 20, height: 10),
        Paint()..color=HfColors.forest);
      c.drawOval(Rect.fromCenter(center: Offset(x+10,yy-9), width: 20, height: 10),
        Paint()..color=HfColors.forest);
    }
    _rect(c, Rect.fromLTWH(x-12,y-1,28,25), HfColors.coral, 7);
  }
  void _spark(Canvas c, Offset p, Color color) {
    _line(c,p.translate(-5,0),p.translate(5,0),color,3);
    _line(c,p.translate(0,-5),p.translate(0,5),color,3);
  }
  void _bubble(Canvas c, Rect r, Color color) {
    _rect(c,r,color,14);
    final path=Path()..moveTo(r.left+12,r.bottom-2)..lineTo(r.left+12,r.bottom+8)
      ..lineTo(r.left+25,r.bottom-2)..close();
    c.drawPath(path,Paint()..color=color);
    for(var i=0;i<3;i++) _dot(c,Offset(r.left+13+i*12,r.center.dy),2.5,HfColors.ink);
  }
  @override
  void paint(Canvas canvas, Size size) {
    if(size.width<=0 || size.height<=0) return;
    final c=canvas;
    c.save();
    // Scale the drawing, never text. Text belongs outside this decorative scene.
    c.scale(size.width/320,size.height/150);
    final dy=math.sin(motion*math.pi)*3;
    c.translate(0,dy);
    switch(kind) {
      case HfSceneKind.wallet:
        _rect(c,const Rect.fromLTWH(10,10,188,130),HfColors.sky,26);
        _rect(c,const Rect.fromLTWH(208,10,102,60),HfColors.butter,22);
        _rect(c,const Rect.fromLTWH(208,80,102,60),HfColors.blush,22);
        _rect(c,const Rect.fromLTWH(49,45,116,73),HfColors.ink,16);
        _rect(c,const Rect.fromLTWH(119,65,55,32),HfColors.coral,10);
        _dot(c,const Offset(134,81),4,HfColors.white);
        for(var i=0;i<3;i++) _dot(c,Offset(228+i*14.0,37),12,HfColors.butterDeep);
        _spark(c,const Offset(257,108),HfColors.coral);
        _spark(c,const Offset(42,31),HfColors.white);
      case HfSceneKind.verify:
      case HfSceneKind.success:
        _rect(c,const Rect.fromLTWH(10,10,300,130),HfColors.mint,26);
        _person(c,83,64,HfColors.butter,scale:0.8);
        _rect(c,const Rect.fromLTWH(178,33,80,89),HfColors.white,20);
        final shield=Path()..moveTo(218,48)..lineTo(242,58)..lineTo(239,86)
          ..quadraticBezierTo(233,102,218,110)..quadraticBezierTo(198,101,195,86)
          ..lineTo(194,58)..close();
        c.drawPath(shield,Paint()..color=HfColors.lavender);
        _line(c,const Offset(204,77),const Offset(215,87),HfColors.ink);
        _line(c,const Offset(215,87),const Offset(232,67),HfColors.ink);
        _spark(c,const Offset(275,34),HfColors.coral);
      case HfSceneKind.profile:
      case HfSceneKind.host:
        _rect(c,const Rect.fromLTWH(10,10,140,130),HfColors.blush,26);
        _rect(c,const Rect.fromLTWH(160,10,150,62),HfColors.lavender,22);
        _rect(c,const Rect.fromLTWH(160,82,150,58),HfColors.butter,22);
        _person(c,80,66,HfColors.coral,longHair:true,scale:0.8);
        _line(c,const Offset(179,33),const Offset(266,33),HfColors.ink,5);
        _line(c,const Offset(179,49),const Offset(241,49),HfColors.white,5);
        for(var i=0;i<6;i++) _line(c,Offset(181+i*19.0,108-(i%3)*4),
          Offset(181+i*19.0,117+(i%3)*4),HfColors.ink,5);
      case HfSceneKind.women:
      case HfSceneKind.lgbtq:
      case HfSceneKind.call:
      case HfSceneKind.welcome:
      case HfSceneKind.discover:
        final shade=kind==HfSceneKind.women ? HfColors.blush : kind==HfSceneKind.lgbtq ? HfColors.lavender : HfColors.mint;
        _rect(c,const Rect.fromLTWH(10,10,182,130),shade,26);
        _rect(c,const Rect.fromLTWH(202,10,108,60),HfColors.sky,22);
        _rect(c,const Rect.fromLTWH(202,80,108,60),HfColors.lavender,22);
        if (kind==HfSceneKind.call || kind==HfSceneKind.women || kind==HfSceneKind.lgbtq) {
          _person(c,57,77,HfColors.coral,longHair:kind==HfSceneKind.women,scale:0.65);
          _person(c,132,77,HfColors.butter,longHair:true,scale:0.65);
          _bubble(c,const Rect.fromLTWH(75,17,49,24),HfColors.white);
        } else {
          _person(c,79,67,HfColors.butter,scale:0.83);
          _plant(c,157,104);
        }
        _bubble(c,const Rect.fromLTWH(224,24,64,29),HfColors.white);
        _dot(c,const Offset(255,109),20,HfColors.butterDeep);
        _dot(c,const Offset(266,101),18,HfColors.lavender);
        _spark(c,const Offset(284,116),HfColors.coral);
        _spark(c,const Offset(32,38),HfColors.white);
    }
    c.restore();
  }
  @override
  bool shouldRepaint(covariant _ScenePainter old) => old.kind!=kind || old.motion!=motion;
}
