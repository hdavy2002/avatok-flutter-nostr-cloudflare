// vision_preview_pane.dart
//
// Two public widgets:
//   • VisionCameraView   — the native camera PlatformView (Android) the session
//     screen stacks its overlay over. Shared so the live screen and the studio
//     preview render the exact same camera surface.
//   • VisionPreviewPane  — the lightweight studio widget Phase 2 imports: camera
//     + the chosen overlay ONLY (no Gemini Live, no mic, no billing), so a
//     creator can eyeball the overlay before publishing.
//
// Public symbol contract (master §6 / Phase-3): VisionPreviewPane is exported
// unchanged with signature `VisionPreviewPane({required String capability,
// required String overlayStyle})`.
import 'package:flutter/foundation.dart' show defaultTargetPlatform, TargetPlatform;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../core/ui/zine.dart';
import 'overlay_painters.dart';
import 'pose_channel.dart';

/// Native camera surface (Android: CameraX preview behind a PlatformView). On
/// non-Android platforms (iOS is a later track) it renders a calm placeholder.
class VisionCameraView extends StatelessWidget {
  /// Optional creation params forwarded to the native view (capability/engine/
  /// overlay/lens). The actual model is started via [PoseChannel.start]; passing
  /// them here lets the native side spin the camera up immediately.
  final Map<String, dynamic> creationParams;
  const VisionCameraView({super.key, this.creationParams = const {}});

  @override
  Widget build(BuildContext context) {
    if (defaultTargetPlatform == TargetPlatform.android) {
      return AndroidView(
        viewType: PoseChannel.cameraViewType,
        creationParams: creationParams,
        creationParamsCodec: const StandardMessageCodec(),
        gestureRecognizers: const <Factory<OneSequenceGestureRecognizer>>{},
      );
    }
    return Container(
      color: Zine.ink,
      alignment: Alignment.center,
      child: Text('Camera preview is Android-only for now',
          style: ZineText.sub(size: 13, color: Zine.paper)),
    );
  }
}

class VisionPreviewPane extends StatefulWidget {
  final String capability;   // master §6 enum
  final String overlayStyle; // master §6 enum
  const VisionPreviewPane({super.key, required this.capability, required this.overlayStyle});

  @override
  State<VisionPreviewPane> createState() => _VisionPreviewPaneState();
}

class _VisionPreviewPaneState extends State<VisionPreviewPane> {
  final PoseChannel _pose = PoseChannel();
  VisionFrame _frame = const VisionFrame();
  bool _started = false;

  String get _engine {
    if (widget.capability == 'pose') return 'movenet';
    if (widget.capability == 'gemini_only') return 'none';
    return 'mediapipe_tasks';
  }

  @override
  void initState() {
    super.initState();
    _boot();
  }

  Future<void> _boot() async {
    try {
      await _pose.start(
        capability: widget.capability,
        engine: _engine,
        overlayStyle: widget.overlayStyle,
        lensFacing: 'front',
      );
      _pose.frames.listen((f) {
        if (mounted) setState(() => _frame = f);
      });
      if (mounted) setState(() => _started = true);
    } catch (_) {/* placeholder stays on unsupported platforms */}
  }

  @override
  void dispose() {
    _pose.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final painter = overlayPainterFor(widget.overlayStyle, _frame);
    return ClipRRect(
      borderRadius: BorderRadius.circular(Zine.r),
      child: Container(
        decoration: BoxDecoration(
          color: Zine.ink,
          border: Zine.border,
          borderRadius: BorderRadius.circular(Zine.r),
        ),
        child: Stack(fit: StackFit.expand, children: [
          VisionCameraView(creationParams: {
            'capability': widget.capability,
            'engine': _engine,
            'overlay_style': widget.overlayStyle,
            'lens_facing': 'front',
          }),
          if (_started && painter != null)
            CustomPaint(painter: painter),
          if (!_started)
            const Center(child: CircularProgressIndicator(color: Zine.lime)),
        ]),
      ),
    );
  }
}
