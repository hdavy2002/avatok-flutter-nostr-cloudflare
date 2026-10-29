import 'dart:async';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:image/image.dart' as im;

import '../../data/merch_art_picker.dart';
import '../../data/repos/channel_repo.dart';
import '../channel_pop_kit.dart';
import '../desi.dart';
import '../theme.dart';
import '../widgets.dart';

/// [HF-CHANNEL-APP-1] The influencer's profile (page) photo, built to the owner-approved phone mock PhonePhoto: pick a picture from the
/// gallery, drag and pinch (or use the slider) until the face sits in the middle of the 4:5 frame, then Save. The cropped picture
/// is sent as a 1200 x 1500 PNG to `PUT /api/hosts/me/photo` (the phone cannot encode JPEG without another package).

/// Paints [img] into a frame of [size], filling it, zoomed by [zoom] (1 = just covers) and moved by [offset] (frame units).
void _paintCrop(Canvas canvas, Size size, ui.Image img, double zoom, Offset offset) {
  final iw = img.width.toDouble();
  final ih = img.height.toDouble();
  final s = math.max(size.width / iw, size.height / ih) * zoom;
  final w = iw * s;
  final h = ih * s;
  final o = _clampOffset(size, img, zoom, offset);
  final dst = Rect.fromLTWH((size.width - w) / 2 + o.dx, (size.height - h) / 2 + o.dy, w, h);
  canvas.drawImageRect(img, Rect.fromLTWH(0, 0, iw, ih), dst, Paint()..filterQuality = FilterQuality.high);
}

/// Keeps the picture covering the whole frame.
Offset _clampOffset(Size size, ui.Image img, double zoom, Offset offset) {
  final iw = img.width.toDouble();
  final ih = img.height.toDouble();
  final s = math.max(size.width / iw, size.height / ih) * zoom;
  final maxX = math.max(0.0, (iw * s - size.width) / 2);
  final maxY = math.max(0.0, (ih * s - size.height) / 2);
  return Offset(offset.dx.clamp(-maxX, maxX).toDouble(), offset.dy.clamp(-maxY, maxY).toDouble());
}

class _CropPainter extends CustomPainter {
  _CropPainter(this.img, this.zoom, this.offset);

  final ui.Image img;
  final double zoom;
  final Offset offset;

  @override
  void paint(Canvas canvas, Size size) {
    canvas.clipRect(Offset.zero & size);
    _paintCrop(canvas, size, img, zoom, offset);
    // rule-of-thirds guide
    final line = Paint()
      ..color = GP.gridLine
      ..strokeWidth = 1;
    for (var i = 1; i < 3; i++) {
      canvas.drawLine(Offset(size.width * i / 3, 0), Offset(size.width * i / 3, size.height), line);
      canvas.drawLine(Offset(0, size.height * i / 3), Offset(size.width, size.height * i / 3), line);
    }
  }

  @override
  bool shouldRepaint(covariant _CropPainter old) => old.img != img || old.zoom != zoom || old.offset != offset;
}

class ProfilePhotoScreen extends StatefulWidget {
  const ProfilePhotoScreen({super.key, this.repo});

  final ChannelRepo? repo;

  @override
  State<ProfilePhotoScreen> createState() => _ProfilePhotoScreenState();
}

class _ProfilePhotoScreenState extends State<ProfilePhotoScreen> {
  static const double _maxZoom = 4;
  static const int _outW = 1200;
  static const int _outH = 1500;

  ui.Image? _img;
  double _zoom = 1;
  double _startZoom = 1;
  Offset _offset = Offset.zero;
  Size _frame = Size.zero;
  bool _busy = false;
  String? _error;

  ChannelRepo get _repo => widget.repo ?? ChannelRepo.instance;

  @override
  void dispose() {
    _img?.dispose();
    super.dispose();
  }

  Future<void> _choose() async {
    setState(() => _error = null);
    try {
      final art = await MerchArtPicker.pick();
      if (art == null) return;
      final buf = await ui.ImmutableBuffer.fromUint8List(art.bytes);
      final desc = await ui.ImageDescriptor.encoded(buf);
      final w = desc.width;
      final h = desc.height;
      const cap = 2400; // keep memory small: the export is 1200 x 1500 anyway
      final codec = await desc.instantiateCodec(targetWidth: w >= h && w > cap ? cap : null, targetHeight: h > w && h > cap ? cap : null);
      final frame = await codec.getNextFrame();
      desc.dispose();
      buf.dispose();
      if (!mounted) {
        frame.image.dispose();
        return;
      }
      setState(() {
        _img?.dispose();
        _img = frame.image;
        _zoom = 1;
        _offset = Offset.zero;
      });
    } catch (_) {
      if (mounted) setState(() => _error = 'That picture could not be opened. Please choose another one.');
    }
  }

  void _setZoom(double z) {
    final img = _img;
    if (img == null) return;
    setState(() {
      _zoom = z.clamp(1.0, _maxZoom).toDouble();
      _offset = _clampOffset(_frame, img, _zoom, _offset);
    });
  }

  /// How many source pixels span the frame's width at the current zoom.
  double _visibleSourceWidth(ui.Image img) {
    final s = math.max(_frame.width / img.width, _frame.height / img.height) * _zoom;
    return _frame.width / s;
  }

  Future<Uint8List> _render(ui.Image img) async {
    final rec = ui.PictureRecorder();
    final canvas = Canvas(rec, Rect.fromLTWH(0, 0, _outW.toDouble(), _outH.toDouble()));
    final k = _outW / _frame.width;
    canvas.scale(k);
    _paintCrop(canvas, _frame, img, _zoom, _offset);
    final pic = rec.endRecording();
    final out = await pic.toImage(_outW, _outH);
    final data = await out.toByteData(format: ui.ImageByteFormat.rawRgba);
    out.dispose();
    pic.dispose();
    if (data == null) throw StateError('rgba');
    // [HF-MOD-2] JPEG, not PNG: a 1200 x 1500 photo is ~300-600 KB instead of several MB, well under the 4 MB the
    // AI photo check accepts, and quicker on mobile data. Encoded off the UI thread.
    final rgba = data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes);
    return compute(_encodeJpeg, (rgba, _outW, _outH));
  }

  Future<void> _save() async {
    final img = _img;
    if (img == null || _busy || _frame.width <= 0) return;
    if (_visibleSourceWidth(img) < 600) {
      setState(() => _error = 'This picture is too small to fill the frame. Zoom out a little or choose a bigger picture.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final bytes = await _render(img);
      final up = await _repo.uploadProfilePhoto(bytes, contentType: 'image/jpeg');
      channelEvent('profile_photo_saved', {'bytes': bytes.length, 'zoom': double.parse(_zoom.toStringAsFixed(2)), 'has_url': up.url != null, 'checking': up.checking});
      if (!mounted) return;
      toast(context, up.checking ? 'Checking your new photo… It shows on your page in a few seconds if it passes.' : 'Photo saved. It shows on your page now.');
      context.canPop() ? context.pop() : context.go('/inf/home');
    } catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = ChannelRepo.photoProblemText(e);
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final img = _img;
    return Scaffold(
      backgroundColor: GP.bg,
      body: Column(children: [
        const GpHeader(title: 'Profile photo', bag: false),
        Expanded(
          child: ListView(padding: const EdgeInsets.fromLTRB(16, 20, 16, 28), children: [
            Center(child: Text('MY PUBLIC PAGE', style: gpEyebrow())),
            const SizedBox(height: 6),
            Semantics(header: true, child: Text('Your big picture', textAlign: TextAlign.center, style: t(30, color: GP.ink, w: FontWeight.w900, h: 1.1))),
            const SizedBox(height: 8),
            Text('Drag and pinch until your face sits in the middle.', textAlign: TextAlign.center, style: t(15, color: GP.muted, w: FontWeight.w700, h: 1.35)),
            const SizedBox(height: 18),
            LayoutBuilder(builder: (context, c) {
              final w = c.maxWidth;
              final h = w * 5 / 4;
              _frame = Size(w, h);
              return Semantics(
                label: 'Crop area. Drag to move the picture, pinch to zoom.',
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(22),
                  child: Container(
                    width: w,
                    height: h,
                    color: GP.tile,
                    child: img == null
                        ? Center(
                            child: Column(mainAxisSize: MainAxisSize.min, children: [
                              const Icon(Icons.add_photo_alternate_rounded, size: 64, color: GP.muted),
                              const SizedBox(height: 8),
                              Text('Choose a picture to begin', style: t(16, color: GP.muted, w: FontWeight.w800)),
                            ]),
                          )
                        : GestureDetector(
                            behavior: HitTestBehavior.opaque,
                            onScaleStart: (_) => _startZoom = _zoom,
                            onScaleUpdate: (d) {
                              setState(() {
                                _zoom = (_startZoom * d.scale).clamp(1.0, _maxZoom).toDouble();
                                _offset = _clampOffset(_frame, img, _zoom, _offset + d.focalPointDelta);
                              });
                            },
                            child: CustomPaint(size: Size(w, h), painter: _CropPainter(img, _zoom, _offset)),
                          ),
                  ),
                ),
              );
            }),
            const SizedBox(height: 14),
            Row(children: [
              Text('Zoom', style: t(16, color: GP.ink, w: FontWeight.w900)),
              Expanded(
                child: Slider(
                  value: _zoom,
                  min: 1,
                  max: _maxZoom,
                  activeColor: GP.red,
                  inactiveColor: GP.line,
                  semanticFormatterCallback: (v) => '${(v * 100).round()} percent',
                  onChanged: img == null ? null : _setZoom,
                ),
              ),
            ]),
            const SizedBox(height: 8),
            _rule(true, 'Your AI avatar', ' — the one you chose.'),
            _rule(false, 'No real photo of you', ' — for your safety.'),
            _rule(true, 'Face in the middle', ' — with a little space above your head.'),
            if (_error != null) ...[
              const SizedBox(height: 10),
              Semantics(liveRegion: true, child: Text(_error!, style: t(15, color: GP.redDeep, w: FontWeight.w800, h: 1.3))),
            ],
            const SizedBox(height: 18),
            GpButton('Choose from gallery', kind: GpBtn.outline, onTap: _busy ? null : () => unawaited(_choose())),
          ]),
        ),
      ]),
      bottomNavigationBar: GpBottomBar(
        child: GpButton(_busy ? 'Saving…' : 'Save photo', onTap: (img == null || _busy) ? null : () => unawaited(_save())),
      ),
    );
  }

  Widget _rule(bool ok, String bold, String rest) => Padding(
        padding: const EdgeInsets.only(bottom: 10),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Container(
            width: 28,
            height: 28,
            alignment: Alignment.center,
            decoration: BoxDecoration(color: ok ? GP.blue : GP.red, shape: BoxShape.circle),
            child: Icon(ok ? Icons.check_rounded : Icons.close_rounded, size: 18, color: GP.paper),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Text.rich(
              TextSpan(children: [
                TextSpan(text: bold, style: t(16, color: GP.ink, w: FontWeight.w900)),
                TextSpan(text: rest),
              ]),
              style: t(16, color: GP.muted, w: FontWeight.w700, h: 1.35),
            ),
          ),
        ]),
      );
}

/// A card on the influencer home that opens the photo screen.
class ProfilePhotoCard extends StatelessWidget {
  const ProfilePhotoCard({super.key});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: DesiCard(
        title: 'Profile photo',
        note: 'Choose the big picture fans see at the top of your page.',
        child: Align(
          alignment: Alignment.centerLeft,
          child: DesiButton('Change photo', icon: Icons.photo_camera_rounded, onTap: () => unawaited(context.push<Object?>('/inf/photo'))),
        ),
      ),
    );
  }
}

/// [HF-MOD-2] RGBA -> JPEG (quality 85). Top level so [compute] can run it in an isolate.
Uint8List _encodeJpeg((Uint8List, int, int) a) {
  final img = im.Image.fromBytes(width: a.$2, height: a.$3, bytes: a.$1.buffer, bytesOffset: a.$1.offsetInBytes, numChannels: 4, order: im.ChannelOrder.rgba);
  return Uint8List.fromList(im.encodeJpg(img, quality: 85));
}
