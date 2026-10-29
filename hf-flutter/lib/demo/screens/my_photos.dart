import 'dart:async';
import 'dart:math' as math;

import 'package:cached_network_image/cached_network_image.dart';
import 'package:camera/camera.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:image/image.dart' as im;
import 'package:permission_handler/permission_handler.dart';

import '../../data/api_exception.dart';
import '../../data/intro_flags.dart';
import '../../data/merch_art_picker.dart';
import '../../data/photos_gate.dart'; // [HF-PHOTO-CROP-APP]
import '../../data/repos/my_photos_repo.dart';
import '../../data/services.dart';
import '../../data/telemetry.dart';
import '../channel_pop_kit.dart';
import '../desi.dart';
import '../theme.dart';
import 'photo_crop_editor.dart'; // [HF-PHOTO-CROP-APP]

/// [HF-MOD-APP-PHOTOS] The fan's own profile photo and cover, built to the owner-approved canvas artboards
/// AppMe (the card on top of the Me tab), AppPhotos ("My photo & cover") and AppRefused.
/// Every picture is checked by the server before it goes live; the old one stays until the new one passes.
/// Behind `hfPhotoModerationEnabled` (IntroFlags.photoModeration): with it off nothing here shows.

// ------------------------------------------------------------------------------------------- shrinking

/// Result of [shrinkPhoto]: the JPEG, or a [problem] code (`bad` = cannot be read, `small` = under the size the server needs).
typedef ShrunkPhoto = (Uint8List? bytes, String? problem);

/// Decodes, fixes the rotation, shrinks and re-encodes as JPEG (quality 80). Top level so [compute] can run it in an isolate.
/// Profile (`kind` 0): centre-crop to a square, longest side 1080. Cover (`kind` 1): width at most 1600, aspect kept, never under 200 high.
ShrunkPhoto shrinkPhoto((Uint8List, int) a) {
  try {
    var img = im.decodeImage(a.$1);
    if (img == null) return (null, 'bad');
    img = im.bakeOrientation(img);
    if (a.$2 == PhotoKind.profile.index) {
      if (img.width < PhotoLimits.profileMin || img.height < PhotoLimits.profileMin) return (null, 'small');
      final side = math.min(img.width, img.height);
      img = im.copyCrop(img, x: (img.width - side) ~/ 2, y: (img.height - side) ~/ 2, width: side, height: side);
      if (side > PhotoLimits.profileLongSide) {
        img = im.copyResize(img, width: PhotoLimits.profileLongSide, height: PhotoLimits.profileLongSide, interpolation: im.Interpolation.average);
      }
    } else {
      if (img.width < PhotoLimits.coverMinW || img.height < PhotoLimits.coverMinH) return (null, 'small');
      var scale = math.min(1.0, PhotoLimits.coverMaxW / img.width);
      if (img.height * scale < PhotoLimits.coverMinH) scale = PhotoLimits.coverMinH / img.height;
      if (scale < 1) img = im.copyResize(img, width: (img.width * scale).round(), interpolation: im.Interpolation.average);
    }
    return (Uint8List.fromList(im.encodeJpg(img, quality: 80)), null);
  } catch (_) {
    return (null, 'bad');
  }
}

/// [HF-PHOTO-CROP-APP] [cropPhoto] input: the picture, the [PhotoKind] index and the visible area as fractions of the picture
/// (left, top, right, bottom), measured on the upright picture (after the camera's rotation flag is applied).
typedef CropArgs = (Uint8List, int, double, double, double, double);

/// Like [shrinkPhoto], but crops exactly the area the person framed in the editor. Top level so [compute] can run it in an isolate.
/// Profile: a square, longest side 1080 (never under 200). Cover: 3 : 1, 1500 x 500 (or the source's own width when smaller, never
/// under 640 x 213). Same checks, same JPEG quality 80, same `bad` / `small` problems.
ShrunkPhoto cropPhoto(CropArgs a) {
  try {
    var img = im.decodeImage(a.$1);
    if (img == null) return (null, 'bad');
    img = im.bakeOrientation(img);
    final profile = a.$2 == PhotoKind.profile.index;
    if (profile) {
      if (img.width < PhotoLimits.profileMin || img.height < PhotoLimits.profileMin) return (null, 'small');
    } else {
      if (img.width < PhotoLimits.coverMinW || img.height < PhotoLimits.coverMinH) return (null, 'small');
    }
    var w = (((a.$5 - a.$3) * img.width).round()).clamp(1, img.width).toInt();
    var h = (((a.$6 - a.$4) * img.height).round()).clamp(1, img.height).toInt();
    if (profile) {
      final side = math.min(w, h);
      w = side;
      h = side;
    } else {
      h = math.max(1, (w / 3).round());
      if (h > img.height) {
        h = img.height;
        w = math.min(img.width, h * 3);
      }
    }
    final x = ((a.$3 * img.width).round()).clamp(0, img.width - w).toInt();
    final y = ((a.$4 * img.height).round()).clamp(0, img.height - h).toInt();
    img = im.copyCrop(img, x: x, y: y, width: w, height: h);
    if (profile) {
      final target = w.clamp(PhotoLimits.profileMin, PhotoLimits.profileLongSide).toInt();
      if (target != w) img = im.copyResize(img, width: target, height: target, interpolation: target < w ? im.Interpolation.average : im.Interpolation.cubic);
    } else {
      final tw = w.clamp(PhotoLimits.coverMinW, PhotoLimits.coverMaxW).toInt();
      if (tw != w) img = im.copyResize(img, width: tw, height: (tw / 3).round(), interpolation: tw < w ? im.Interpolation.average : im.Interpolation.cubic);
    }
    return (Uint8List.fromList(im.encodeJpg(img, quality: 80)), null);
  } catch (_) {
    return (null, 'bad');
  }
}

// ------------------------------------------------------------------------------------------- shared bits

const Color _lilacInk = Color(0xFF3B2A96);
const Color _refusedBg = Color(0xFFFFF0F1);
const Color _refusedLine = Color(0xFFF2C0C4);
const Color _refusedTitle = Color(0xFF9E1C22);
const Color _refusedBody = Color(0xFF5B2A2E);

BoxDecoration _cardDeco() => BoxDecoration(color: C.white, borderRadius: BorderRadius.circular(24), border: Border.all(color: C.line, width: 1.5));

/// Block-print cover art, used when the person has no cover yet.
class BlockPrintCover extends StatelessWidget {
  const BlockPrintCover({super.key});

  @override
  Widget build(BuildContext context) => const ExcludeSemantics(child: SizedBox.expand(child: CustomPaint(painter: _BlockPrintPainter())));
}

class _BlockPrintPainter extends CustomPainter {
  const _BlockPrintPainter();

  @override
  void paint(Canvas canvas, Size size) {
    // Drawn on a 390 x 132 board, then scaled to fill (slice).
    final k = math.max(size.width / 390, size.height / 132);
    canvas.clipRect(Offset.zero & size);
    canvas.translate((size.width - 390 * k) / 2, (size.height - 132 * k) / 2);
    canvas.scale(k);
    final p = Paint();
    canvas.drawRect(const Rect.fromLTWH(0, 0, 390, 132), p..color = C.marigold);
    p.color = C.rani;
    for (final c in const [(30.0, 30.0, 18.0), (110.0, 96.0, 22.0), (210.0, 26.0, 16.0), (300.0, 90.0, 24.0), (370.0, 28.0, 14.0)]) {
      canvas.drawCircle(Offset(c.$1, c.$2), c.$3, p);
    }
    p.color = C.maroon;
    for (final c in const [(73.0, 69.0, 26.0), (261.0, 61.0, 22.0)]) {
      canvas.save();
      canvas.translate(c.$1, c.$2);
      canvas.rotate(math.pi / 4);
      canvas.drawRRect(RRect.fromRectAndRadius(Rect.fromCenter(center: Offset.zero, width: c.$3, height: c.$3), const Radius.circular(6)), p);
      canvas.restore();
    }
    p.color = C.peacock;
    for (final c in const [(160.0, 70.0, 10.0), (340.0, 60.0, 8.0)]) {
      canvas.drawCircle(Offset(c.$1, c.$2), c.$3, p);
    }
    p.color = C.gold;
    for (final c in const [(30.0, 30.0, 6.0), (110.0, 96.0, 8.0), (300.0, 90.0, 9.0)]) {
      canvas.drawCircle(Offset(c.$1, c.$2), c.$3, p);
    }
  }

  @override
  bool shouldRepaint(covariant _BlockPrintPainter old) => false;
}

/// A network picture that fills its box, or [fallback] when there is none or it cannot load.
Widget _netOr(String? url, Widget fallback) {
  if (url == null) return fallback;
  return CachedNetworkImage(imageUrl: url, fit: BoxFit.cover, fadeInDuration: Duration.zero, placeholder: (_, __) => fallback, errorWidget: (_, __, ___) => fallback);
}

class _Initial extends StatelessWidget {
  const _Initial(this.name, this.size);
  final String name;
  final double size;

  @override
  Widget build(BuildContext context) {
    final n = name.trim();
    return Container(color: C.blush, alignment: Alignment.center, child: Text(n.isEmpty ? '?' : n.characters.first.toUpperCase(), style: t(size * 0.42, color: C.maroon, w: FontWeight.w900)));
  }
}

Widget _round(double size, Widget child, {double border = 3, Color borderColor = C.blush}) => Container(
      width: size,
      height: size,
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(shape: BoxShape.circle, color: C.blush, border: Border.all(color: borderColor, width: border)),
      child: child,
    );

String _myName() => Services.instance.me?.name ?? 'Friend';

// ------------------------------------------------------------------------------------------- Me tab card

/// The card on top of the Me tab: cover banner, round photo with a camera badge, name, @handle and "Edit photo & cover".
/// Shows nothing while `hfPhotoModerationEnabled` is off.
class MyPhotoCard extends StatefulWidget {
  const MyPhotoCard({super.key, this.repo});

  final MyPhotosRepo? repo;

  @override
  State<MyPhotoCard> createState() => _MyPhotoCardState();
}

class _MyPhotoCardState extends State<MyPhotoCard> {
  MyPhotos _photos = const MyPhotos();
  bool _on = IntroFlags.photoModeration;

  MyPhotosRepo get _repo => widget.repo ?? MyPhotosRepo.instance;

  @override
  void initState() {
    super.initState();
    unawaited(_init());
  }

  Future<void> _init() async {
    await IntroFlags.ensureLoaded();
    if (!mounted) return;
    setState(() => _on = IntroFlags.photoModeration);
    if (_on) await _load();
  }

  Future<void> _load() async {
    try {
      final p = await _repo.load();
      if (mounted) setState(() => _photos = p);
    } catch (_) {
      // The card still shows the block-print cover and the initial.
    }
  }

  Future<void> _open() async {
    await context.push<Object?>('/me/photos');
    if (mounted) unawaited(_load());
  }

  @override
  Widget build(BuildContext context) {
    if (!_on) return const SizedBox.shrink();
    final name = _myName();
    final handle = Services.instance.me?.handle;
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Container(
        decoration: _cardDeco(),
        clipBehavior: Clip.antiAlias,
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          SizedBox(
            height: 180,
            child: Stack(clipBehavior: Clip.none, children: [
              Positioned(
                left: 0,
                right: 0,
                top: 0,
                height: 132,
                child: Semantics(
                  button: true,
                  label: 'Change your cover',
                  child: GestureDetector(
                    onTap: () => unawaited(_open()),
                    child: Stack(fit: StackFit.expand, children: [
                      _netOr(_photos.cover.url, const BlockPrintCover()),
                      Positioned(
                        right: 12,
                        top: 12,
                        child: Container(
                          height: 40,
                          padding: const EdgeInsets.symmetric(horizontal: 14),
                          decoration: BoxDecoration(color: C.deep.withValues(alpha: .78), borderRadius: BorderRadius.circular(999)),
                          child: Row(mainAxisSize: MainAxisSize.min, children: [
                            const Icon(Icons.photo_camera_rounded, size: 16, color: C.white),
                            const SizedBox(width: 6),
                            Text('Cover', style: t(14, color: C.white, w: FontWeight.w800)),
                          ]),
                        ),
                      ),
                    ]),
                  ),
                ),
              ),
              Positioned(left: 18, top: 84, child: _round(96, _netOr(_photos.profile.url, _Initial(name, 96)), border: 4, borderColor: C.white)),
              Positioned(
                left: 92,
                top: 150,
                child: Container(
                  width: 34,
                  height: 34,
                  decoration: BoxDecoration(color: C.maroon, shape: BoxShape.circle, border: Border.all(color: C.white, width: 3)),
                  child: const ExcludeSemantics(child: Icon(Icons.photo_camera_rounded, size: 16, color: C.white)),
                ),
              ),
            ]),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(18, 8, 18, 16),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(name, maxLines: 1, overflow: TextOverflow.ellipsis, style: t(24, w: FontWeight.w900, h: 1.1)),
              if (handle != null && handle.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 4), child: Text('@$handle', style: t(14, color: C.muted, w: FontWeight.w600))),
              const SizedBox(height: 12),
              DesiButton('Edit photo & cover', icon: Icons.photo_camera_rounded, onTap: () => unawaited(_open())),
            ]),
          ),
        ]),
      ),
    );
  }
}

// ------------------------------------------------------------------------------------------- the screen

enum _Stage { idle, preparing, sending }

class _SlotState {
  PhotoSlot server = const PhotoSlot();
  _Stage stage = _Stage.idle;
  Uint8List? thumb;
  bool timedOut = false;
  bool justLive = false;
  String? error;

  bool get busy => stage != _Stage.idle;
}

/// "My photo & cover": change the cover and the profile photo; each new picture is checked first.
class MyPhotosScreen extends StatefulWidget {
  const MyPhotosScreen({super.key, this.repo, this.onboarding = false, this.gate});

  final MyPhotosRepo? repo;

  /// [HF-PHOTO-CROP-APP] The mandatory "Add your photos" step (`/onboarding/photos`): same cards, plus the explanation, the progress
  /// and a Continue button that unlocks the app. Works even when the photo & cover card flag is off.
  final bool onboarding;

  /// Tests pass their own; the app uses [PhotosGate.instance].
  final PhotosGate? gate;

  @override
  State<MyPhotosScreen> createState() => _MyPhotosScreenState();
}

class _MyPhotosScreenState extends State<MyPhotosScreen> {
  final Map<PhotoKind, _SlotState> _s = {PhotoKind.profile: _SlotState(), PhotoKind.cover: _SlotState()};
  final Set<PhotoKind> _watching = {};
  bool _ready = false;
  bool _enabled = false;
  String? _loadError;
  int _gen = 0;

  bool _continuing = false;
  String? _continueError;

  MyPhotosRepo get _repo => widget.repo ?? MyPhotosRepo.instance;
  PhotosGate get _gate => widget.gate ?? PhotosGate.instance;

  @override
  void initState() {
    super.initState();
    if (widget.onboarding) {
      final why = _gate.takeMessage();
      Telemetry.event('hf_photo_onboarding_shown', {'missing': _gate.missing.join(',')});
      if (why != null) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted) ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text(why, style: t(15, color: C.white, w: FontWeight.w700))));
        });
      }
    }
    unawaited(_init());
  }

  @override
  void dispose() {
    _gen++; // stops a running poll
    super.dispose();
  }

  Future<void> _init() async {
    await IntroFlags.ensureLoaded();
    if (!mounted) return;
    _enabled = widget.onboarding || IntroFlags.photoModeration;
    if (!_enabled) {
      setState(() => _ready = true);
      return;
    }
    await _refresh();
  }

  Future<void> _refresh() async {
    setState(() => _loadError = null);
    try {
      final p = await _repo.load();
      if (!mounted) return;
      setState(() {
        _ready = true;
        for (final k in PhotoKind.values) {
          final st = _s[k]!;
          st.server = p.slot(k);
          if (st.server.checking && !st.busy) _watching.add(k);
        }
      });
      if (_watching.isNotEmpty) unawaited(_poll());
    } on ApiException catch (e) {
      if (mounted) {
        setState(() {
          _ready = true;
          _loadError = e.userMessage;
        });
      }
    } catch (_) {
      if (mounted) {
        setState(() {
          _ready = true;
          _loadError = ApiException.genericText;
        });
      }
    }
  }

  /// After a 202: ask every 2 seconds, for up to 60 seconds, until the check is over.
  Future<void> _poll() async {
    final gen = ++_gen;
    final end = DateTime.now().add(const Duration(seconds: 60));
    while (mounted && gen == _gen && DateTime.now().isBefore(end)) {
      await Future<void>.delayed(const Duration(seconds: 2));
      if (!mounted || gen != _gen) return;
      MyPhotos p;
      try {
        p = await _repo.load();
      } catch (_) {
        continue;
      }
      if (!mounted || gen != _gen) return;
      setState(() {
        for (final k in PhotoKind.values) {
          final st = _s[k]!;
          if (st.busy && st.stage == _Stage.preparing) continue;
          final now = p.slot(k);
          if (_watching.contains(k) && !now.checking) {
            _watching.remove(k);
            st.server = now;
            st.thumb = null;
            st.timedOut = false;
            if (now.refused != null) {
              Telemetry.event('hf_photo_result_app', {'kind': k.name, 'result': 'refused'});
            } else {
              st.justLive = true;
              Telemetry.event('hf_photo_result_app', {'kind': k.name, 'result': 'live'});
            }
          } else if (_watching.contains(k)) {
            st.server = now;
          }
        }
      });
      if (_watching.isEmpty) {
        unawaited(_gate.refresh()); // [HF-PHOTO-CROP-APP] the cached "photos complete" answer follows the new pictures
        return;
      }
    }
    if (!mounted || gen != _gen) return;
    setState(() {
      for (final k in _watching) {
        _s[k]!.timedOut = true;
        Telemetry.event('hf_photo_result_app', {'kind': k.name, 'result': 'timeout'});
      }
      _watching.clear();
    });
  }

  Future<void> _choose(PhotoKind k, {required bool selfie}) async {
    final st = _s[k]!;
    if (st.busy || st.server.checking) return;
    Telemetry.event('hf_photo_pick', {'kind': k.name, 'source': selfie ? 'camera' : 'gallery'});
    Uint8List? chosen;
    PhotoCropResult? crop;
    try {
      // [HF-PHOTO-CROP-APP] pick -> "Adjust your photo" -> only then shrink and upload. "Choose another" goes back to the picker.
      while (crop == null || crop.another) {
        Uint8List? data;
        if (selfie) {
          data = await Navigator.of(context).push<Uint8List>(MaterialPageRoute(builder: (_) => const SelfieCaptureScreen()));
        } else {
          final picked = await MerchArtPicker.pick();
          if (picked == null) return;
          if (picked.problem != null) {
            if (mounted) setState(() => st.error = picked.problem);
            return;
          }
          data = picked.bytes;
        }
        if (data == null || !mounted) return;
        final bytesToEdit = data;
        chosen = bytesToEdit;
        crop = await Navigator.of(context).push<PhotoCropResult>(
          MaterialPageRoute<PhotoCropResult>(fullscreenDialog: true, builder: (_) => PhotoCropEditor(bytes: bytesToEdit, kind: k)),
        );
        if (crop == null || !mounted) return;
      }
    } catch (_) {
      if (mounted) setState(() => st.error = 'We could not open your photos. Please try again.');
      return;
    }
    final raw = chosen;
    final framed = crop;
    if (raw == null || !mounted) return;
    setState(() {
      st.stage = _Stage.preparing;
      st.error = null;
      st.justLive = false;
      st.timedOut = false;
      st.thumb = null;
    });
    final sw = Stopwatch()..start();
    final (bytes, problem) = await compute(cropPhoto, (raw, k.index, framed.left, framed.top, framed.right, framed.bottom));
    if (!mounted) return;
    if (bytes == null) {
      setState(() {
        st.stage = _Stage.idle;
        st.error = problem == 'small'
            ? (k == PhotoKind.profile ? 'That photo is too small. Please choose one that is at least 200 by 200 pixels.' : 'That photo is too small for a cover. Please choose a wider one, at least 640 by 200 pixels.')
            : 'That picture could not be opened. Please choose another one.';
      });
      Telemetry.event('hf_photo_upload_app', {'kind': k.name, 'bytes': raw.length, 'ms': sw.elapsedMilliseconds, 'ok': false, 'error': problem ?? 'bad'});
      return;
    }
    setState(() {
      st.thumb = bytes;
      st.stage = _Stage.sending;
    });
    try {
      await _repo.upload(k, bytes);
      Telemetry.event('hf_photo_upload_app', {'kind': k.name, 'bytes': bytes.length, 'ms': sw.elapsedMilliseconds, 'ok': true});
      if (!mounted) return;
      setState(() {
        st.stage = _Stage.idle;
        st.server = PhotoSlot(url: st.server.url, checking: true);
        _watching.add(k);
      });
      unawaited(_poll());
    } on ApiException catch (e) {
      Telemetry.event('hf_photo_upload_app', {'kind': k.name, 'bytes': bytes.length, 'ms': sw.elapsedMilliseconds, 'ok': false, 'error': e.code});
      if (mounted) {
        setState(() {
          st.stage = _Stage.idle;
          st.thumb = null;
          st.error = e.userMessage;
        });
      }
    } catch (_) {
      Telemetry.event('hf_photo_upload_app', {'kind': k.name, 'bytes': bytes.length, 'ms': sw.elapsedMilliseconds, 'ok': false, 'error': 'unknown'});
      if (mounted) {
        setState(() {
          st.stage = _Stage.idle;
          st.thumb = null;
          st.error = ApiException.genericText;
        });
      }
    }
  }

  bool get _anyProblem => _s.values.any((s) => s.error != null || (!s.server.checking && s.server.refused != null));

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: C.page,
      body: Column(children: [
        GpHeader(title: widget.onboarding ? 'Add your photos' : 'My photo & cover', bag: false),
        Expanded(child: _body(context)),
      ]),
    );
  }

  Widget _body(BuildContext context) {
    if (!_ready) return const Center(child: CircularProgressIndicator(color: C.maroon));
    if (!_enabled) {
      return ListView(padding: const EdgeInsets.fromLTRB(16, 20, 16, 28), children: [
        Container(
          decoration: _cardDeco(),
          padding: const EdgeInsets.all(18),
          child: Text('Changing your photo and cover is not available right now. Please try again later.', style: t(16, w: FontWeight.w700, h: 1.4)),
        ),
      ]);
    }
    if (_loadError != null) {
      return ListView(padding: const EdgeInsets.fromLTRB(16, 20, 16, 28), children: [
        _ProblemBox(title: 'We could not load your photos', body: _loadError!),
        const SizedBox(height: 14),
        Align(alignment: Alignment.centerLeft, child: DesiButton('Try again', icon: Icons.refresh_rounded, onTap: () => unawaited(_refresh()))),
      ]);
    }
    final onb = widget.onboarding;
    return ListView(padding: const EdgeInsets.fromLTRB(16, 14, 16, 28), children: [
      if (onb) ...[_onboardingIntro(), const SizedBox(height: 14), _profileCard(), const SizedBox(height: 14), _coverCard()] else ...[_coverCard(), const SizedBox(height: 14), _profileCard()],
      const SizedBox(height: 14),
      const _SafetyNote(),
      if (onb) ...[const SizedBox(height: 18), _continueArea()],
      if (_anyProblem) ...[
        const SizedBox(height: 14),
        Center(
          child: Wrap(alignment: WrapAlignment.center, crossAxisAlignment: WrapCrossAlignment.center, children: [
            Text('Think this is a mistake? ', style: t(14, color: C.muted, w: FontWeight.w600)),
            InkWell(
              borderRadius: BorderRadius.circular(8),
              onTap: () => unawaited(context.push<Object?>('/help')),
              child: ConstrainedBox(
                constraints: const BoxConstraints(minHeight: 48, minWidth: 48),
                child: Center(child: Text('Contact support', style: t(14, color: C.tan, w: FontWeight.w800))),
              ),
            ),
          ]),
        ),
      ],
    ]);
  }

  /// A slot counts as done when a picture is live, nothing is being sent and no new one is being checked.
  bool _slotDone(PhotoKind k) {
    final st = _s[k]!;
    return st.server.url != null && !st.server.checking && !st.busy;
  }

  Widget _progressLine(PhotoKind k, String label) {
    final st = _s[k]!;
    final IconData icon;
    final Color color;
    final String note;
    if (_slotDone(k)) {
      icon = Icons.check_circle_rounded;
      color = C.maroon;
      note = 'Done';
    } else if (st.busy || st.server.checking) {
      icon = Icons.hourglass_top_rounded;
      color = C.amber;
      note = 'Checking…';
    } else if (st.error != null || st.server.refused != null) {
      icon = Icons.cancel_rounded;
      color = C.ruby;
      note = 'Not accepted. The reason is below.';
    } else {
      icon = Icons.radio_button_unchecked_rounded;
      color = C.muted;
      note = 'Needed';
    }
    return Semantics(
      container: true,
      label: '$label: $note',
      child: ExcludeSemantics(
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Icon(icon, size: 26, color: color),
            const SizedBox(width: 10),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(_slotDone(k) ? '$label ✓' : label, style: t(17, w: FontWeight.w900, h: 1.2)),
                Text(note, style: t(15, color: C.muted, w: FontWeight.w600, h: 1.35)),
              ]),
            ),
          ]),
        ),
      ),
    );
  }

  /// The explanation and the two-step progress shown above the cards in the mandatory setup.
  Widget _onboardingIntro() {
    return Container(
      decoration: _cardDeco(),
      padding: const EdgeInsets.all(16),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Text('Add your photos', style: t(24, w: FontWeight.w900, h: 1.15)),
        const SizedBox(height: 8),
        Text(
          'Every Hello Fraands member needs two photos before calling or booking: a clear photo of your face, and a cover photo. '
          'This keeps everyone on the app real and safe. We check each photo in a few seconds.',
          style: t(16, w: FontWeight.w600, h: 1.5),
        ),
        const SizedBox(height: 10),
        _progressLine(PhotoKind.profile, 'Profile photo'),
        _progressLine(PhotoKind.cover, 'Cover photo'),
      ]),
    );
  }

  Future<void> _continue() async {
    if (_continuing) return;
    setState(() {
      _continuing = true;
      _continueError = null;
    });
    await _gate.refresh();
    if (!mounted) return;
    if (_gate.blocking) {
      setState(() {
        _continuing = false;
        _continueError = 'Your photos are not accepted yet. Please wait for the checks to finish, or choose a different photo.';
      });
      return;
    }
    Telemetry.event('hf_photo_onboarding_done');
    context.go(Services.instance.viewerIsInfluencer ? '/inf/home' : '/reels');
  }

  Widget _continueArea() {
    final ready = _slotDone(PhotoKind.profile) && _slotDone(PhotoKind.cover);
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      if (_continueError != null) ...[_ProblemBox(title: 'Not ready yet', body: _continueError!), const SizedBox(height: 12)],
      PhotoButton(_continuing ? 'Please wait…' : 'Continue', icon: Icons.arrow_forward_rounded, onTap: ready && !_continuing ? () => unawaited(_continue()) : null),
      if (!ready)
        Padding(
          padding: const EdgeInsets.only(top: 10),
          child: Text('Continue opens when both photos are accepted.', textAlign: TextAlign.center, style: t(15, color: C.muted, w: FontWeight.w600, h: 1.4)),
        ),
      const SizedBox(height: 10),
      Wrap(alignment: WrapAlignment.center, spacing: 8, children: [
        _linkButton('Contact support', () => unawaited(context.push<Object?>('/help'))),
        _linkButton('Sign out', () => unawaited(_signOut())),
      ]),
    ]);
  }

  Widget _linkButton(String label, VoidCallback onTap) => InkWell(
        borderRadius: BorderRadius.circular(8),
        onTap: onTap,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 48, minWidth: 48),
          child: Center(child: Padding(padding: const EdgeInsets.symmetric(horizontal: 8), child: Text(label, style: t(16, color: C.tan, w: FontWeight.w800)))),
        ),
      );

  Future<void> _signOut() async {
    await Services.instance.signOut();
    unawaited(_gate.refresh());
    if (mounted) context.go('/reels');
  }

  Widget _eyebrow(String text) => Text(text.toUpperCase(), style: t(14, color: C.tan, w: FontWeight.w900, ls: 1.4));

  /// The red box (role alert) for a refused picture or a failed upload.
  Widget? _problem(PhotoKind k) {
    final st = _s[k]!;
    if (st.error != null) return _ProblemBox(title: 'We couldn\'t upload that photo', body: st.error!);
    if (!st.server.checking && !st.busy && st.server.refused != null) return _ProblemBox(title: 'Why your photo was not accepted', body: st.server.refused!);
    return null;
  }

  Widget _statusFor(PhotoKind k) {
    final st = _s[k]!;
    final what = k == PhotoKind.profile ? 'photo' : 'cover';
    if (st.stage == _Stage.preparing) return _Status(chip: 'Getting your $what ready…', note: 'Making it small so it uploads fast.');
    if (st.stage == _Stage.sending) return _Status(chip: 'Sending your $what…', note: 'Your old $what stays until the new one passes.');
    if (st.server.checking && !st.timedOut) return _Status(chip: 'Checking your new $what…', note: 'Your old $what stays until the new one passes. Usually a few seconds.');
    if (st.timedOut) return _Status(chip: 'Still checking…', note: 'This is taking longer than usual. Your old $what stays until the new one passes. Look again in a minute.');
    if (st.justLive) return _Status(chip: 'Your new $what is live', note: k == PhotoKind.profile ? 'Shown on your comments and bookings.' : 'Shown at the top of your Me tab.', live: true);
    return const SizedBox.shrink();
  }

  Widget _coverCard() {
    final st = _s[PhotoKind.cover]!;
    final problem = _problem(PhotoKind.cover);
    final waiting = st.busy || st.server.checking;
    final coverStatus = _statusFor(PhotoKind.cover);
    return Semantics(
      container: true,
      label: 'Cover photo',
      child: Container(
        decoration: _cardDeco(),
        padding: const EdgeInsets.all(16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          _eyebrow('Cover'),
          const SizedBox(height: 12),
          if (problem != null) ...[problem, const SizedBox(height: 12)],
          ClipRRect(
            borderRadius: BorderRadius.circular(16),
            child: SizedBox(height: 118, child: _netOr(st.server.url, const BlockPrintCover())),
          ),
          if (st.thumb != null) ...[
            const SizedBox(height: 12),
            _NewThumb(bytes: st.thumb!, width: 120, height: 40, radius: 10, spinning: waiting),
          ],
          const SizedBox(height: 12),
          if (coverStatus is! SizedBox) ...[coverStatus, const SizedBox(height: 12)],
          Align(
            alignment: Alignment.centerLeft,
            child: DesiButton(
              problem != null ? 'Choose another photo' : 'Change cover',
              kind: problem != null ? DesiButtonKind.plum : DesiButtonKind.ghost,
              onTap: waiting ? null : () => unawaited(_choose(PhotoKind.cover, selfie: false)),
            ),
          ),
        ]),
      ),
    );
  }

  Widget _profileCard() {
    final st = _s[PhotoKind.profile]!;
    final problem = _problem(PhotoKind.profile);
    final waiting = st.busy || st.server.checking;
    final status = _statusFor(PhotoKind.profile);
    final refusedOnly = problem != null;
    return Semantics(
      container: true,
      label: 'Profile photo',
      child: Container(
        decoration: _cardDeco(),
        clipBehavior: Clip.antiAlias,
        child: Stack(children: [
          const Positioned(right: -16, top: -16, child: ExcludeSemantics(child: Hibiscus(size: 64))),
          Padding(
            padding: const EdgeInsets.all(16),
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Padding(padding: const EdgeInsets.only(right: 40), child: _eyebrow('Profile photo')),
              const SizedBox(height: 12),
              if (problem != null) ...[problem, const SizedBox(height: 12)],
              Row(crossAxisAlignment: CrossAxisAlignment.center, children: [
                _round(92, _netOr(st.server.url, _Initial(_myName(), 92))),
                if (st.thumb != null) ...[
                  const SizedBox(width: 14),
                  _NewThumb(bytes: st.thumb!, width: 56, height: 56, radius: 14, spinning: waiting),
                ],
                if (refusedOnly && st.thumb == null) ...[
                  const SizedBox(width: 14),
                  Expanded(
                    child: Text(
                      st.server.url != null ? 'Your old photo is still showing. The refused photo was deleted and nobody saw it.' : 'The refused photo was deleted and nobody saw it. Please choose a new one.',
                      style: t(14, color: C.muted, w: FontWeight.w600, h: 1.45),
                    ),
                  ),
                ],
              ]),
              if (status is! SizedBox) ...[const SizedBox(height: 12), status],
              const SizedBox(height: 14),
              Wrap(spacing: 8, runSpacing: 8, children: [
                DesiButton(
                  refusedOnly ? 'Choose another photo' : 'Choose a photo',
                  onTap: waiting ? null : () => unawaited(_choose(PhotoKind.profile, selfie: false)),
                ),
                if (!refusedOnly)
                  DesiButton(
                    'Take a selfie',
                    kind: DesiButtonKind.ghost,
                    onTap: waiting ? null : () => unawaited(_choose(PhotoKind.profile, selfie: true)),
                  ),
              ]),
            ]),
          ),
        ]),
      ),
    );
  }
}

/// Soft red box (role alert): "We couldn't use that photo" plus the server's sentence.
class _ProblemBox extends StatelessWidget {
  const _ProblemBox({required this.title, required this.body});

  final String title;
  final String body;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      liveRegion: true,
      container: true,
      child: Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(color: _refusedBg, borderRadius: BorderRadius.circular(20), border: Border.all(color: _refusedLine, width: 2)),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Container(
            width: 36,
            height: 36,
            decoration: const BoxDecoration(color: C.ruby, shape: BoxShape.circle),
            child: const ExcludeSemantics(child: Icon(Icons.close_rounded, size: 20, color: C.white)),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(title, style: t(17, color: _refusedTitle, w: FontWeight.w900, h: 1.2)),
              const SizedBox(height: 4),
              Text(body, style: t(15, color: _refusedBody, w: FontWeight.w600, h: 1.5)),
            ]),
          ),
        ]),
      ),
    );
  }
}

/// The small picture of the new photo, dashed outline, with a spinner on a dark veil while it is being sent or checked.
class _NewThumb extends StatelessWidget {
  const _NewThumb({required this.bytes, required this.width, required this.height, required this.radius, required this.spinning});

  final Uint8List bytes;
  final double width;
  final double height;
  final double radius;
  final bool spinning;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: 'Your new picture',
      image: true,
      child: SizedBox(
        width: width,
        height: height,
        child: CustomPaint(
          foregroundPainter: const DesiDashedRRectPainter(color: C.lav, radius: 14, width: 2),
          child: Padding(
            padding: const EdgeInsets.all(2),
            child: ClipRRect(
              borderRadius: BorderRadius.circular(math.max(radius - 2, 0)),
              child: Stack(fit: StackFit.expand, children: [
                Image.memory(bytes, fit: BoxFit.cover, gaplessPlayback: true),
                if (spinning)
                  Container(
                    color: C.deep.withValues(alpha: .5),
                    alignment: Alignment.center,
                    child: SizedBox(width: math.min(22, height - 12), height: math.min(22, height - 12), child: const CircularProgressIndicator(strokeWidth: 3, color: C.white)),
                  ),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}

/// Chip plus one sentence under it. [live] = plum chip with a check.
class _Status extends StatelessWidget {
  const _Status({required this.chip, required this.note, this.live = false});

  final String chip;
  final String note;
  final bool live;

  @override
  Widget build(BuildContext context) {
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Semantics(
        liveRegion: true,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
          decoration: BoxDecoration(color: live ? C.maroon : C.lavtint, borderRadius: BorderRadius.circular(999)),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            if (live) ...[const Icon(Icons.check_rounded, size: 18, color: C.white), const SizedBox(width: 8)],
            Flexible(child: Text(chip, style: t(14, color: live ? C.white : _lilacInk, w: FontWeight.w900))),
          ]),
        ),
      ),
      const SizedBox(height: 6),
      Text(note, style: t(14, color: C.muted, w: FontWeight.w600, h: 1.45)),
    ]);
  }
}

class _SafetyNote extends StatelessWidget {
  const _SafetyNote();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
      decoration: BoxDecoration(color: C.butter, borderRadius: BorderRadius.circular(20)),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        const ExcludeSemantics(child: Icon(Icons.info_outline_rounded, size: 22, color: C.amber)),
        const SizedBox(width: 10),
        Expanded(
          child: Text.rich(
            TextSpan(children: [
              TextSpan(text: 'Every photo is checked for safety. ', style: t(14, w: FontWeight.w900, h: 1.5)),
              TextSpan(
                text: 'Not allowed: nudity, sexual content, violence. We shrink your photo before sending it, so it uploads fast.',
                style: t(14, w: FontWeight.w600, h: 1.5),
              ),
            ]),
          ),
        ),
      ]),
    );
  }
}

// ------------------------------------------------------------------------------------------- selfie

/// Front camera, one tap to take a picture. Pops with the picture's bytes (or null when she backs out).
class SelfieCaptureScreen extends StatefulWidget {
  const SelfieCaptureScreen({super.key});

  @override
  State<SelfieCaptureScreen> createState() => _SelfieCaptureScreenState();
}

class _SelfieCaptureScreenState extends State<SelfieCaptureScreen> {
  CameraController? _cam;
  bool _starting = true;
  bool _taking = false;
  bool _denied = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    unawaited(_prepare());
  }

  @override
  void dispose() {
    unawaited(_cam?.dispose());
    super.dispose();
  }

  Future<void> _prepare() async {
    setState(() {
      _starting = true;
      _error = null;
      _denied = false;
    });
    try {
      final cams = await availableCameras();
      if (cams.isEmpty) {
        if (mounted) {
          setState(() {
            _starting = false;
            _error = 'We could not find a camera on this phone.';
          });
        }
        return;
      }
      final cam = cams.firstWhere((c) => c.lensDirection == CameraLensDirection.front, orElse: () => cams.first);
      final ctl = CameraController(cam, ResolutionPreset.high, enableAudio: false);
      await ctl.initialize();
      if (!mounted) {
        await ctl.dispose();
        return;
      }
      setState(() {
        _cam = ctl;
        _starting = false;
      });
    } on CameraException {
      if (mounted) {
        setState(() {
          _starting = false;
          _denied = true;
          _error = 'We need your camera to take a selfie. Please allow it in Settings.';
        });
      }
    } catch (_) {
      if (mounted) {
        setState(() {
          _starting = false;
          _error = 'We could not start the camera. Please try again.';
        });
      }
    }
  }

  Future<void> _take() async {
    final c = _cam;
    if (c == null || _taking) return;
    setState(() => _taking = true);
    try {
      final f = await c.takePicture();
      final bytes = await f.readAsBytes();
      if (mounted) Navigator.of(context).pop(bytes);
    } catch (_) {
      if (mounted) {
        setState(() {
          _taking = false;
          _error = 'We could not take the picture. Please try again.';
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final cam = _cam;
    return Scaffold(
      backgroundColor: C.page,
      body: Column(children: [
        const GpHeader(title: 'Take a selfie', bag: false),
        Expanded(
          child: ListView(padding: const EdgeInsets.fromLTRB(16, 14, 16, 28), children: [
            if (_error != null) ...[
              _ProblemBox(title: 'Camera problem', body: _error!),
              const SizedBox(height: 14),
            ],
            if (_starting)
              const Padding(padding: EdgeInsets.symmetric(vertical: 60), child: Center(child: CircularProgressIndicator(color: C.maroon)))
            else if (cam != null && cam.value.isInitialized)
              ClipRRect(
                borderRadius: BorderRadius.circular(24),
                child: AspectRatio(aspectRatio: 1 / cam.value.aspectRatio, child: CameraPreview(cam)),
              ),
            const SizedBox(height: 16),
            Wrap(spacing: 8, runSpacing: 8, children: [
              if (cam != null) DesiButton(_taking ? 'Please wait…' : 'Take photo', icon: Icons.photo_camera_rounded, onTap: _taking ? null : () => unawaited(_take())),
              if (_denied) DesiButton('Open Settings', onTap: () => unawaited(openAppSettings())),
              if (!_starting && cam == null && !_denied) DesiButton('Try again', onTap: () => unawaited(_prepare())),
              DesiButton('Cancel', kind: DesiButtonKind.ghost, onTap: () => Navigator.of(context).pop()),
            ]),
          ]),
        ),
      ]),
    );
  }
}
